/** Explicit local Docker smoke: real runner, isolated group networks, Bash and Chromium. No production resources. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { SandboxRunnerClient } from "../agent/lib/sandbox-runner/runner-client.js";
import { sandboxSeedDigest } from "../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { sandboxContainerName } from "../services/sandbox-runner/docker-sandbox-lifecycle.js";

async function main() {
  const [sandboxImage, serviceImage] = process.argv.slice(2);
  if (!sandboxImage || !serviceImage) throw new Error("TEST_IMAGES_REQUIRED: Pass explicit local sandbox and test-service image tags");
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });
  await docker.getImage(sandboxImage).inspect();
  await docker.getImage(serviceImage).inspect();
  const project = `osinara-matrix-smoke-${randomUUID().slice(0, 8)}`;
  const volumes: Docker.Volume[] = [];
  const services: Docker.Container[] = [];
  const workspace = randomUUID();
  const otherWorkspace = randomUUID();
  const personalWorkspace = randomUUID();
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const personalSessionId = randomUUID();
  const trustedNetwork = `${project}-trusted`;
  let client: SandboxRunnerClient | undefined;
  try {
    // Host networking puts this harmless control service on the daemon's host, including when
    // Docker Desktop runs in a separate VM from the machine executing this smoke script.
    const hostServer = await docker.createContainer({
      Image: serviceImage, Tty: true,
      Cmd: ["node", "-e", 'const s=require("node:http").createServer((q,r)=>r.end("host-control"));s.listen(0,"0.0.0.0",()=>console.log(String(s.address().port)))'],
      HostConfig: { NetworkMode: "host" },
    });
    services.push(hostServer);
    await hostServer.start();
    let hostPort: number | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const output = (await hostServer.logs({ stdout: true, stderr: false })).toString().trim();
      if (/^[0-9]+$/u.test(output)) { hostPort = Number(output); break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(hostPort, `Docker-host control service did not start: ${JSON.stringify((await hostServer.logs({ stdout: true, stderr: true })).toString())}`);
    await docker.createVolume({ Name: `${project}-workspaces` }); volumes.push(docker.getVolume(`${project}-workspaces`));
    await docker.createVolume({ Name: `${project}-tools` }); volumes.push(docker.getVolume(`${project}-tools`));
    const network = await docker.createNetwork({
      Name: trustedNetwork, Driver: "bridge", Internal: true,
      Labels: { "com.docker.compose.project": project, "com.docker.compose.network": "sandbox-egress" },
    });
    const proxyOptions = {
      Image: serviceImage, Cmd: ["node", "--import", "tsx", "services/sandbox-egress-proxy/main.ts"],
      Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "sandbox-egress-proxy" },
      HostConfig: { NetworkMode: "bridge" },
    };
    const proxy = await docker.createContainer(proxyOptions); services.push(proxy);
    await proxy.start();
    await network.connect({ Container: proxy.id, EndpointConfig: { Aliases: ["sandbox-egress-proxy"] } });
    const search = await docker.createContainer({
      Image: serviceImage, Tty: true,
      Cmd: ["node", "--import", "tsx", "--input-type=module", "-e",
        'import {searchPublicWeb} from "./agent/lib/tool-policy/conversation-web-tools.ts"; const result=await searchPublicWeb({query:"Telegram Bot API documentation",numResults:1}); if(!result.content.includes("https://core.telegram.org/bots/api"))throw new Error("TEST_SEARCH_SOURCE_MISSING"); console.log("search-source-verified")'],
      HostConfig: { NetworkMode: trustedNetwork },
    });
    services.push(search);
    const runner = await docker.createContainer({
      Image: serviceImage, Cmd: ["node", "--import", "tsx", "services/sandbox-runner/main.ts"],
      Env: [`SANDBOX_RUNTIME_IMAGE=${sandboxImage}`],
      Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "sandbox-runner" },
      ExposedPorts: { "8080/tcp": {} },
      HostConfig: {
        PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        Mounts: [
          { Type: "volume", Source: `${project}-workspaces`, Target: "/runner/workspaces" },
          { Type: "volume", Source: `${project}-tools`, Target: "/runner/tools" },
        ],
      },
    }); services.push(runner);
    await runner.start();
    const port = (await runner.inspect()).NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
    assert.ok(port);
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { ready = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { /* The test-owned runner is still starting. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "Runner did not become ready");
    client = new SandboxRunnerClient(url);
    const group = {
      access: "restricted" as const,
      agentSessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABC",
      mounts: [{ mountPoint: "group" as const, workspaceId: workspace }],
      sandboxSessionId: sessionId, seedDigest: sandboxSeedDigest([]), seedFiles: [],
    };
    await client.create(group);
    await client.writeFile(sessionId, "/workspace/group/kept.txt", new TextEncoder().encode("kept"));
    assert.equal((await docker.getContainer(sandboxContainerName(sessionId)).inspect()).HostConfig.NetworkMode, "none");
    const enabled = await client.create({ ...group, access: "group-tools" });
    assert.ok(enabled.instanceId);
    const shell = await client.run(sessionId, { command: "cat /workspace/group/kept.txt; test ! -e /workspace/personal; test ! -S /var/run/docker.sock", expectedInstanceId: enabled.instanceId, timeoutMs: 10_000 });
    assert.equal(shell.exitCode, 0); assert.equal(shell.stdout, "kept");
    const opened = await client.run(sessionId, { command: "timeout --signal=TERM --kill-after=5s 45s agent-browser open https://example.com --json", timeoutMs: 55_000 });
    assert.equal(opened.exitCode, 0, opened.stderr);
    assert.match(opened.stdout, /Example Domain/u);
    const title = await client.run(sessionId, { command: "timeout 20s agent-browser get title --json", timeoutMs: 25_000 });
    assert.equal(title.exitCode, 0, title.stderr); assert.match(title.stdout, /Example Domain/u);
    await proxy.remove({ force: true, v: true });
    services.splice(services.indexOf(proxy), 1);
    const replacementProxy = await docker.createContainer(proxyOptions); services.push(replacementProxy);
    await replacementProxy.start();
    await network.connect({ Container: replacementProxy.id, EndpointConfig: { Aliases: ["sandbox-egress-proxy"] } });
    const reconnected = await client.create({ ...group, access: "group-tools" });
    assert.equal(reconnected.instanceId, enabled.instanceId, "Proxy replacement must not recreate group compute");
    const page = await client.run(sessionId, {
      command: 'node -e \'fetch("https://example.com",{signal:AbortSignal.timeout(15000)}).then(r=>r.text()).then(t=>{if(!t.includes("Example Domain"))process.exit(2)})\'',
      timeoutMs: 20_000,
    });
    assert.equal(page.exitCode, 0, page.stderr);
    await client.create({ ...group, access: "group-tools", sandboxSessionId: otherSessionId,
      mounts: [{ mountPoint: "group", workspaceId: otherWorkspace }] });
    await client.create({ ...group, access: "trusted", sandboxSessionId: personalSessionId,
      mounts: [{ mountPoint: "personal", workspaceId: personalWorkspace }] });
    const personal = await docker.getContainer(sandboxContainerName(personalSessionId)).inspect();
    const groupInfo = await docker.getContainer(sandboxContainerName(sessionId)).inspect();
    const otherInfo = await docker.getContainer(sandboxContainerName(otherSessionId)).inspect();
    assert.notEqual(groupInfo.HostConfig.NetworkMode, trustedNetwork);
    assert.notEqual(groupInfo.HostConfig.NetworkMode, otherInfo.HostConfig.NetworkMode);
    await client.run(personalSessionId, {
      command: "node -e 'require(\"node:http\").createServer((q,s)=>s.end(\"private\")).listen(7777,\"0.0.0.0\")' >/tmp/private-server.log 2>&1 &",
      timeoutMs: 5_000,
    });
    const privateIp = personal.NetworkSettings.Networks[trustedNetwork]?.IPAddress;
    assert.ok(privateIp);
    const privateReady = await client.run(personalSessionId, {
      command: "node -e '(async()=>{for(let i=0;i<20;i++){try{if(await(await fetch(\"http://127.0.0.1:7777\")).text()===\"private\")process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)})()'",
      timeoutMs: 5_000,
    });
    assert.equal(privateReady.exitCode, 0, "Private control server did not start");
    const denied = await client.run(sessionId, {
      command: `node -e 'const s=require("node:net").connect(7777,"${privateIp}");s.on("connect",()=>process.exit(2));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),2000)'`,
      timeoutMs: 5_000,
    });
    assert.equal(denied.exitCode, 0, "Group reached a trusted sandbox directly");
    const hostGateway = (await network.inspect()).IPAM?.Config?.[0]?.Gateway;
    assert.ok(hostGateway);
    const hostControl = await client.run(personalSessionId, {
      command: `node -e 'const s=require("node:net").connect(${hostPort},"${hostGateway}");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(2));setTimeout(()=>process.exit(2),2000)'`,
      timeoutMs: 5_000,
    });
    assert.equal(hostControl.exitCode, 0, "The host control server is not reachable from an ordinary internal bridge");
    assert.ok(groupInfo.HostConfig.NetworkMode);
    const groupNetwork = await docker.getNetwork(groupInfo.HostConfig.NetworkMode).inspect();
    const subnet = groupNetwork.IPAM?.Config?.[0]?.Subnet;
    assert.ok(subnet);
    // The first subnet address is where Docker would put the host bridge without isolated mode.
    const address = subnet.split("/")[0]!.split(".").map(Number);
    const firstHost = [...address.slice(0, 3), address[3]! + 1].join(".");
    for (const host of [firstHost, hostGateway]) {
      const hostDenied = await client.run(sessionId, {
        command: `node -e 'const s=require("node:net").connect(${hostPort},"${host}");s.on("connect",()=>process.exit(2));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),2000)'`,
        timeoutMs: 5_000,
      });
      assert.equal(hostDenied.exitCode, 0, `Group reached a Docker host service via ${host}`);
    }
    const closed = await client.run(sessionId, { command: "timeout 20s agent-browser close --json", timeoutMs: 25_000 });
    assert.equal(closed.exitCode, 0, closed.stderr);
    await client.stop(sessionId);
    await client.create(group);
    const afterRevocation = await docker.getContainer(sandboxContainerName(sessionId)).inspect();
    assert.equal(afterRevocation.HostConfig.NetworkMode, "none");
    await assert.rejects(client.run(sessionId, {
      command: "touch /workspace/group/should-not-exist", expectedInstanceId: enabled.instanceId, timeoutMs: 5_000,
    }), /AGENT_SANDBOX_RUNNER_INSTANCE_STALE/u);
    assert.equal(await client.readFile(sessionId, "/workspace/group/should-not-exist"), null);
    assert.equal((await client.run(sessionId, { command: "cat /workspace/group/kept.txt", timeoutMs: 5_000 })).stdout, "kept");
    console.log(JSON.stringify({ phase: "sandbox-isolation", passed: true, checks: ["Bash", "real-browser", "browser-continuity", "proxy-replacement", "host-network-denied", "private-network-denied", "separate-group-networks", "revocation", "stale-command-denied", "files-preserved"] }));
    await search.start();
    const searchResult = await search.wait();
    assert.equal(searchResult.StatusCode, 0, (await search.logs({ stdout: true, stderr: true })).toString());
    console.log(JSON.stringify({ phase: "web-search-via-proxy", passed: true }));
  } finally {
    if (client) {
      try { await client.run(sessionId, { command: "timeout 10s agent-browser close --json", timeoutMs: 15_000 }); }
      catch { /* Cleanup continues even when a test intentionally revoked the browser environment. */ }
    }
    const sandboxes = await docker.listContainers({ all: true, filters: { label: [`dev.osinara.sandbox.project=${project}`] } });
    for (const sandbox of sandboxes) await docker.getContainer(sandbox.Id).remove({ force: true, v: true });
    for (const service of services.reverse()) await service.remove({ force: true, v: true });
    const networks = await docker.listNetworks();
    for (const network of networks) {
      if (network.Name === trustedNetwork || network.Labels?.["dev.osinara.group-egress.project"] === project) {
        await docker.getNetwork(network.Id).remove();
      }
    }
    for (const volume of volumes) await volume.remove();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
