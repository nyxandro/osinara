# Osinara Agent Guide

## Что это за проект

Osinara — семейный Telegram-агент на TypeScript, Eve `0.32.0`, PostgreSQL и Groq.
Он обслуживает личные чаты, закрытые семейные группы и изолированные внешние группы.
Главная задача приложения — сохранять строгие границы между пользователями, семьями и группами.

Основные возможности: bootstrap владельца, приглашения и подтверждение участников;
личные, семейные и групповые контексты с отдельной политикой доступа;
durable Telegram ingress, Groq Whisper, HITL, Eve tools, skills и sandbox.

## Framework

Проект закреплён на Eve `0.32.0`; не обновлять версию как побочный рефакторинг.
Eve — filesystem-first framework для durable backend agents.
Расположение файла определяет его роль и, как правило, runtime-имя.

Официальная документация: [https://eve.dev/docs](https://eve.dev/docs)
Исходный репозиторий: [https://github.com/vercel/eve](https://github.com/vercel/eve)
Точная документация установленной версии: `node_modules/eve/docs/README.md`.
Публичные TypeScript-типы: `node_modules/eve/dist/src/public/`.

Перед изменением Eve-facing кода:

1. Прочитать релевантный guide в `node_modules/eve/docs/`.
2. Проверить экспортированные типы установленной Eve, а не полагаться на память.
3. Проверить runtime source Eve, если документация не определяет важную семантику.
4. Использовать только публичные Eve API либо явно документированный локальный патч.

Полезные guides:

- layout и config: `node_modules/eve/docs/reference/project-layout.md`, `agent-config.md`;
- Telegram: `node_modules/eve/docs/channels/telegram.mdx`;
- durability и sessions: `node_modules/eve/docs/concepts/`;
- dynamic tools: `node_modules/eve/docs/guides/dynamic-capabilities.md`;
- HITL: `node_modules/eve/docs/tools/human-in-the-loop.md`;
- sandbox и subagents: `node_modules/eve/docs/sandbox.mdx`, `subagents.mdx`.

## Граница Eve и приложения

Eve отвечает за agent loop, модели, durable sessions, compaction и streaming.
Eve также отвечает за channels, tools, skills, sandbox, subagents и HITL protocol.

Osinara отвечает за пользователей, семьи, роли, membership и приглашения.
Osinara также отвечает за group registration, scopes, authorization, audit и long-term memory.

Никогда не переносить прикладную авторизацию в prompt или инструкции модели.
Никогда не принимать `userId`, `familyId`, роль, group type или scope из текста модели.
Источники доверия — проверенный channel update, session auth и актуальное состояние PostgreSQL.

Long-term memory является application concern, а не заменой Eve `defineState`.
Смысловое решение о сохранении claim и create/attach thread принимает только основной чат-агент
через `remember`. Backend выводит source/identity/scope из verified Telegram context и PostgreSQL и
коммитит claim, evidence, Eve provenance и optional thread entry одной транзакцией. Subagent не
получает `remember`. Background semantic extraction, relation/thread classifiers и LLM briefs удалены;
retrieval и thread activation используют только локальный E5 и scoped SQL.

## Как проходит Telegram update

1. Docker Nginx принимает только разрешённые публичные маршруты.
2. Eve Telegram channel проверяет `TELEGRAM_WEBHOOK_SECRET_TOKEN`.
3. Локальный verified-update hook сохраняет исходный update в PostgreSQL до ACK.
4. Telegram быстро получает `200`, без ожидания модели или транскрибации.
5. `telegram-ingress-worker` вызывает закрытый drain route внутри Docker network.
6. Repository выдаёт update по FIFO для конкретного chat/topic и ставит lease.
7. Voice authorization повторно проверяется до обращения к Groq.
8. Native Eve Telegram dispatch запускает `handleTelegramMessage`.
9. Handler выводит auth и scopes только из Telegram и PostgreSQL.
10. Eve выполняет turn, tools, approvals и доставляет ответ через channel adapter.
11. Следующий item освобождается только после достижения session boundary.

Дедупликация основана на Telegram `update_id`.
Перед Groq и Eve dispatch сохраняются durable start markers.
После неоднозначного crash автоматический повтор запрещён, чтобы не удвоить оплату или side effect.

## Авторизация и scopes

`private` требует подтверждённую семейную identity.
Личный чат получает scopes `personal` и `family`.
`family_private` принимает только активного участника той же семьи и получает `family`.
`external` получает только собственный `group` scope.
Внешняя группа никогда не получает личную или семейную память и подключения.

Owner-only операции разрешены только в личном Telegram-чате владельца.
После HITL side-effect executor должен повторно проверить текущую owner-role в БД.
Изменение типа группы пересоздаёт trust zone и удаляет данные старой области.

Весь прикладной tool surface выдаётся per-mode через step-scoped Eve `defineDynamic` в `agent/tools/capabilities.ts`.
Статических дескрипторов у приложения нет: инструмент, недоступный текущему режиму, не имеет дескриптора вообще, а не заменяется заглушкой.
Реализации инструментов лежат в `agent/lib/tools/`; в `agent/tools/` остаётся только dynamic resolver, иначе дескриптор станет виден во всех режимах.
Матрица режимов и внешний allowlist собираются в `agent/lib/tool-policy/mode-tool-surface.ts`; сбой резолвера или недоказанный режим означает отсутствие прикладных инструментов.
Нативные контракты `glob`, `grep`, `read_file` и `write_file` во внешней группе перекрываются same-name dynamic wrappers: каждый execute повторно проверяет актуальную external registration, принимает только канонический путь внутри точного `/workspace/group` и запрещает symlink-компоненты до вызова Eve default executor. Единственное read-only исключение: `read_file` после live-проверки skill grant канонизирует supporting file видимого code-reviewed dynamic skill в `$HOME/.agents/skills`; `glob`, `grep` и `write_file` такого доступа не получают. В trusted private/family режимах wrappers не выдаются, поэтому исходные Eve built-ins сохраняют personal/family mounts и tools environment.
Eve `0.32.0` не умеет скрывать собственные built-ins per-session, поэтому `bash`, `todo` и `ask_question` во внешней группе перекрываются явным отказом. `web_fetch` выдаётся только через локальный controlled wrapper с execution-time проверкой; provider-native `web_search` не имеет local execution hook, поэтому всегда запрещён и не является grantable capability. `load_skill` обёрнут отдельной live-проверкой: он загружает только code-reviewed skill из актуального per-group skill allowlist либо capability-coupled `imagegen` при live grant `generate_image`.
Subscription-backed `generate_image` существует только при активном provider `codex-subscription`: при любом другом provider он не имеет дескриптора ни в одном режиме и отсутствует в owner-facing grant contract, поэтому включить его нельзя. В private/family он доступен интерактивному root-agent; внешней группе владелец выдаёт capability через `manage_telegram_group.update_policy` из личного чата с HITL и повторной owner-role проверкой. Grant одновременно открывает dynamic skill `imagegen`; execution повторно читает live group policy. Scheduled turns и subagents не получают ни tool, ни skill. Перед единственным вызовом `gpt-image-2` создаётся durable operation ledger; transport, 5xx и повреждённый success остаются terminal ambiguous без автоматического retry. Подтверждённый WebP сохраняется в authorized workspace и отправляется через exact-once `send_workspace_file`. CLIProxy запускается с `disable-image-generation: chat`, поэтому его скрытый provider tool не обходит application capability surface. Grant surface собирается в `agent/lib/tool-policy/grantable-group-capabilities.ts`: `manage_telegram_group` и registration принимают только capability, которую активный provider реально обслуживает, а grant, сохранённый под прежним provider, остаётся parseable, показывается в status как `unavailableConfiguredTools` и не выдаёт ни tool, ни skill.
Eve `0.32.0` materializes dynamic skill packages и их supporting files в sandbox на `session.started` или `turn.started`. Grantable `pohuy` остаётся вне static discovery и выдаётся turn-scoped resolver только разрешённым группам; folder, записанный посреди turn, не меняет текущий manifest и может появиться только через resolver на следующем turn.
Restricted group sandbox держит `$HOME` на Docker tmpfs. Docker `putArchive` не пишет надёжно прямо в mount target, поэтому runner file I/O загружает bytes во временный rootfs path и переносит их внутрь контейнера; не возвращать прямой archive write без реального tmpfs smoke.
Trusted sandbox подключён только к internal egress network и выходит наружу через `sandbox-egress-proxy`. Для Node CLI runtime задаёт `NODE_USE_ENV_PROXY=1`; официальный Russian Trusted Root CA закреплён в sandbox image и передаётся через `NODE_EXTRA_CA_CERTS`, чтобы T-Invest HTTPS проходил проверку без отключения TLS. Restricted group sandbox не получает эти переменные и остаётся без сети.
Нативный Eve `agent` используется для сложной работы только в trusted private/family режимах, где полезен свежий контекст. Во внешней группе same-name dynamic denial не позволяет запускать child и delegation prompt не выдаётся. Trusted child получает отдельные history и state и наследует проверенный auth, connections, skills, sandbox, workspace и trust-zone tools текущего parent turn, кроме root-owned `remember` и `generate_image`. В Eve `0.32.0` implicit `agent` доступен только root runtime node, поэтому child не может рекурсивно делегировать и удалённый `maxSubagentDepth` больше не нужен. Synthetic `session-limit` из Eve никогда не показывается во внешней группе: channel boundary завершает такой turn до parking, persistence и Telegram delivery.

## Структура проекта

`agent/agent.ts` — модель и compaction; root-only delegation задаётся нативной семантикой Eve.
`agent/instructions.md` — постоянное mode-agnostic ядро промта, не authorization layer.
`agent/instructions/` — четыре turn-scoped dynamic блока; порядок задан именами файлов: режим, делегация, стиль, память.
`agent/channels/telegram.ts` — Telegram channel, events и durable ingress hooks.
`agent/tools/capabilities.ts` — единственный discovered application tool и dynamic surface текущего режима.
`agent/lib/tools/` — реализации model-facing typed tools; имя берётся из имени файла.
`agent/lib/image-generation/` — provider gate, no-retry transport, durable ledger, skill и external presentation генерации изображений.
`agent/lib/prompt/` — фрагменты промта и композиция блоков по режимам.
`agent/skills/` — активные статические Eve skills и dynamic resolver для grantable group skills.
`agent/lib/` — application logic, repositories, policies и colocated tests.
`agent/sandbox.ts` — явный backend `just-bash` без настроенных network commands.
`migrations/` и `scripts/` — schema, migration runner, bootstrap, Eve patch и workers.
`infra/nginx.conf` и `compose.yaml` — edge allowlist и Docker services.

Не размещать `*.test.ts` в `agent/tools/` или `agent/channels/`.
Eve discovery воспримет такой файл как production tool или channel.
Тесты model-facing модулей размещать рядом по смыслу в `agent/lib/`.

## Локальный патч Eve

Eve `0.32.0` не предоставляет application seam для durable Telegram ingress и по умолчанию
повторяет некоторые model calls на уровне Eve. `scripts/apply-eve-patches.ts` добавляет
verified-update/drain hooks, возврат Session, application routing/HITL contracts, exact-once model
policy, fail-closed `input.requested` и пятиминутное ожидание health при холодном старте.
AI SDK transport retries, queue namespace, pure HITL context ordering и root-only delegation
используют штатное поведение Eve `0.32.0` и локально не патчатся.
Патч применяется автоматически через `postinstall` после каждого `npm ci`.
Он идемпотентен, проверяет точную версию и ожидаемые artifacts; несовпадение должно останавливать сборку.

Не редактировать `node_modules/eve` вручную.
Не обходить ошибку patch mismatch строковой заменой без повторного аудита upstream source.
При обновлении Eve сначала проверить, появился ли официальный эквивалент, и удалить патч.

## Правила изменения архитектуры

Сначала читать существующий flow и тесты, затем писать failing test, потом implementation.
Предпочитать расширение существующего application boundary новому параллельному пути.
Не создавать второй Telegram transport, второй voice pipeline или второй auth mechanism.
Не дублировать Eve agent loop, HITL, channel delivery, compaction или skill discovery.
Required config и required data проверять fail-fast; не добавлять бизнес-fallbacks.
Ошибки должны иметь стабильный код и понятное русское user-facing сообщение.
Новый source-файл не должен превышать 500 строк; близкий к лимиту модуль разделять.

## Проверка изменений

Быстрые проверки: `npm run typecheck`, `npm test`, `npm run build`.
Главная проверка выполняется в Docker Compose:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

Migrations выполнять только внутри backend/test container через `npm run migrate`.
После Eve-facing изменений обязательно проверять чистый `npm ci` и `eve build`.
После tool/channel edits проверять `.eve/discovery/agent-discovery-manifest.json` и результат `eve build`.
`.eve/compile/compiled-agent-manifest.json` относится к Eve `0.22.5` и не является актуальным artifact.
Production image собирается только из canonical repository state через CI/CD.
Не запускать ручной production build и не менять production database в рамках обычной задачи.

## Перед началом любой новой сессии

1. Прочитать этот файл.
2. Найти существующий модуль, repository и тест до создания нового файла.
3. Для Eve API открыть локальный guide и установленный `.d.ts`.
4. Не трогать память, deployment или persisted contract без явного scope задачи.
