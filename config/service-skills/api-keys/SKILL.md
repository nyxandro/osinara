---
name: api-keys
description: Load before getting an API key of an HTTP service for a skill or script, before granting, revoking, listing or deleting a key, and before writing a skill that calls a service with a stored key.
---

# API keys

A key of an HTTP service is kept by the application, encrypted. Neither you nor any sandbox ever sees it: a sandbox gets a placeholder and a gateway address, and the server's egress proxy puts the real key into the request on its way to the service's own address only. Everything here is available only in a private chat with the owner.

## Getting a key

Never ask anyone to paste a key into a chat and never take one written there: a key in the chat reaches you, the history and the model provider. If someone writes one anyway, do not repeat or save it, and suggest replacing it at the service and sending the new one through the request below.

1. Find in the service's documentation its HTTPS API base URL and how it expects the key.
2. Call `manage_api_keys` with `action=request`, `name`, `purpose`, `baseUrl`, `authHeader` and `authScheme`:
   - `name`: 2–32 lowercase latin letters, digits or `_`, starting with a letter; it becomes `<NAME>_API_KEY` and `<NAME>_BASE_URL`. Prefer the name the service's SDK reads by itself, such as `openai` for an OpenAI-compatible service.
   - `purpose`: a few words for the owner, in Russian.
   - `baseUrl`: the API base on a host name, e.g. `https://api.example.com/v1`.
   - `Authorization: Bearer <key>` (OpenAI-compatible services and most others): `authHeader=authorization`, `authScheme=bearer`. The bare key in its own header, e.g. `x-api-key: <key>`: that header and `authScheme=raw`.
   A key the service takes in the query string or the body is not supported: say so.
3. The application itself asks the owner for the key in a separate message that names the address. Tell the owner in one line to send it as the next message; do not repeat the application's request. The wait lasts 30 minutes, and any ordinary message ends it.
4. The application confirms to the owner when the key is stored. `action=list` then shows `status=stored`.

To replace a stored key, request it again with the same name, `baseUrl`, `authHeader` and `authScheme`. A stored key cannot change its address or header: delete it and request it anew.

## Granting and accounting

A requested key works at once in the owner's own private chat. `action=grant` gives it to `target=family` (the private chats of all family members and the family groups) or to `target=group` with the external group's `telegramChatId` from `manage_telegram_group` status; both wait for the owner's button. An external group uses a key only from Bash, so it needs `bash`. `action=revoke` takes a grant back from the next request on; `action=delete` removes the key with its grants and their accounting.

`action=list` shows each key's status, address, grants, and per grant the number of requests in total and in the last 7 days and the last use. There are no limits, only this accounting.

## Using a key from Bash

Each Bash command of a chat with a granted key gets `<NAME>_API_KEY`, a placeholder that is not the key and is useless outside this server, and `<NAME>_BASE_URL`, `http://sandbox-egress-proxy:3129/<name>`, the gateway in place of the service's base URL. Call the gateway with the path below the base URL and the placeholder exactly where the service expects its key:

```bash
curl -sS "$NEURALDEEP_BASE_URL/images/generations" \
  -H "Authorization: Bearer $NEURALDEEP_API_KEY" -H "Content-Type: application/json" -d '{"prompt":"..."}'
```

An SDK takes the two as its base URL and key. A skill always reads both variables and never writes the service's own address, a placeholder or a key into its files. `env | grep -E '_(API_KEY|BASE_URL)='` shows what the current chat has.

Gateway refusals: `AGENT_SANDBOX_API_KEY_NOT_GRANTED` — this chat has no such key, or the key's header does not carry its placeholder in the key's form; `AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED` — the service could not be reached; `AGENT_SANDBOX_API_KEY_GATEWAY_UNAVAILABLE` — keys are temporarily unavailable on the server. The service's own answers, errors included, pass through unchanged.
