# Osinara Agent Guide

## Что это за проект

Osinara — семейный Telegram-агент на TypeScript, Eve `0.22.5`, PostgreSQL и Groq.
Он обслуживает личные чаты, закрытые семейные группы и изолированные внешние группы.
Главная задача приложения — сохранять строгие границы между пользователями, семьями и группами.

Основные возможности: bootstrap владельца, приглашения и подтверждение участников;
личные, семейные и групповые контексты с отдельной политикой доступа;
durable Telegram ingress, Groq Whisper, HITL, Eve tools, skills и sandbox.

Полная продуктовая спецификация: `SPECIFICATION.md`.
Текущий архитектурный статус: начало `docs/plan.md`.

## Framework

Проект закреплён на Eve `0.22.5`; не обновлять версию как побочный рефакторинг.
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
Работа над расширением памяти отложена; не менять её без отдельного обсуждения.

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
`external_private` и `external_public` получают только собственный `group` scope.
Внешняя группа никогда не получает личную или семейную память и подключения.

Owner-only операции разрешены только в личном Telegram-чате владельца.
После HITL side-effect executor должен повторно проверить текущую owner-role в БД.
Изменение типа группы пересоздаёт trust zone и удаляет данные старой области.

External group application, integration, shell, network и orchestration tools контролируются через step-scoped Eve `defineDynamic`.
Отсутствующий в allowlist инструмент блокируется, а не заменяется default-набором; исключение — нативные `glob`, `grep`, `read_file` и `write_file`, замкнутые внутри отдельного group workspace.
Eve `0.22.5` не умеет скрывать static descriptors динамически, но execution fail-closed.

## Структура проекта

`agent/agent.ts` — модель, compaction и реальные framework limits.
`agent/instructions.md` — постоянные инструкции модели, не authorization layer.
`agent/channels/telegram.ts` — Telegram channel, events и durable ingress hooks.
`agent/tools/` — model-facing typed tools; имя берётся из имени файла.
`agent/skills/` — активные нативные Eve skills.
`agent/lib/` — application logic, repositories, policies и colocated tests.
`agent/sandbox.ts` — явный backend `just-bash` без настроенных network commands.
`migrations/` и `scripts/` — schema, migration runner, bootstrap, Eve patch и workers.
`infra/nginx.conf` и `compose.yaml` — edge allowlist и Docker services.

Не размещать `*.test.ts` в `agent/tools/` или `agent/channels/`.
Eve discovery воспримет такой файл как production tool или channel.
Тесты model-facing модулей размещать рядом по смыслу в `agent/lib/`.

## Локальный патч Eve

Eve `0.22.5` не предоставляет seam для durable Telegram ingress и не допускает zero-depth delegation limit.
`scripts/apply-eve-patches.ts` добавляет verified-update/drain hooks, возврат Session и `maxSubagentDepth: 0`.
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
После tool/channel edits проверять `.eve/compile/compiled-agent-manifest.json`.
Production image собирается только из canonical repository state через CI/CD.
Не запускать ручной production build и не менять production database в рамках обычной задачи.

## Перед началом любой новой сессии

1. Прочитать этот файл.
2. Прочитать релевантный раздел `SPECIFICATION.md`.
3. Проверить начало `docs/plan.md`; нижняя часть хранит исходный audit context.
4. Найти существующий модуль, repository и тест до создания нового файла.
5. Для Eve API открыть локальный guide и установленный `.d.ts`.
6. Не трогать память, deployment или persisted contract без явного scope задачи.
