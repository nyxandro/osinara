/** Owner-granted shell execution in the current group's isolated sandbox. */
import { defineBashTool } from "eve/tools";
import { defineTool } from "../../runtime/tool.js";
import type { GroupSandboxCommandOptions } from "../sandbox-runner/sandbox-runner-contract.js";
import { AppError } from "../app-error.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { authorizeCurrentExternalGroupCapability } from "./external-group-live-policy.js";

const bash = defineBashTool();

export const externalGroupBash = defineTool({
  ...bash,
  description: "Выполнить команду в изолированном окружении текущей группы. Доступны только её файлы и публичная сеть через защищённый шлюз; личные и семейные данные не подключены.",
  async execute(input, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    if (auth.groupType !== "external" || !auth.groupId) throw new AppError("AGENT_GROUP_TOOL_FORBIDDEN", "Bash недоступен в этом режиме");
    await authorizeCurrentExternalGroupCapability({ familyId: auth.familyId, groupId: auth.groupId }, "bash");
    return bash.execute(input, {
      ...ctx,
      async getSandbox() {
        const sandbox = await ctx.getSandbox();
        return {
          ...sandbox,
          run(options) {
            // Eve forwards command options to our backend. The requirement is checked under the
            // registration lock while selecting the exact container, not just before this tool.
            const command: GroupSandboxCommandOptions = { ...options, requiredGroupCapability: "bash" };
            return sandbox.run(command);
          },
        };
      },
    });
  },
});
