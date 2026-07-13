# Osinara

Семейный Telegram-агент на Eve `0.22.5` с PostgreSQL, Groq и нативными skills.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```

Полная проверка в Docker:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

## Skills

Активные skills находятся только в `agent/skills` и загружаются Eve по требованию. Runtime не изменяет каталог skills и не активирует новые процедуры.
