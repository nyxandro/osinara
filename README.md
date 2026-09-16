<h1 align="center">Osinara</h1>

<p align="center">
  <strong>Личный и семейный Telegram-агент: помнит контекст, ведёт дела, работает с файлами и сервисами — и держит строгие границы между личным, семейным и групповым.</strong>
</p>

<p align="center">
  <a href="https://github.com/nyxandro/osinara/actions/workflows/ci-release.yaml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/nyxandro/osinara/ci-release.yaml?branch=main&label=CI&style=flat-square"></a>
  <a href="https://github.com/nyxandro/osinara/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/nyxandro/osinara?style=flat-square&label=release"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24.x-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Eve" src="https://img.shields.io/badge/Eve-0.40.0-111827?style=flat-square">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-pgvector%2017-4169E1?style=flat-square&logo=postgresql&logoColor=white">
</p>

---

## Что это

Osinara — self-hosted агент, который живёт в Telegram и работает как личный ассистент одной семьи.
Он говорит по-русски, понимает голосовые, помнит договорённости между сессиями,
сам напоминает о делах и умеет доводить задачи до результата через инструменты: документы, Google Workspace,
браузер, брокерский счёт, файлы, sandbox.

Ключевое отличие от обычного бота: **права не живут в промте**. Кто ты, из какой ты семьи, что тебе доступно
в этом чате — определяется проверенным Telegram-апдейтом и базой, а не текстом от модели. Личная память
никогда не попадает в групповой чат, внешняя группа никогда не получает доступ к личным данным и сервисам.

**Рассчитан на:** одну семью на своём сервере. Один владелец, приглашённые участники, закрытые семейные группы
и отдельно — внешние группы (рабочие, дружеские), где агент работает в урезанном режиме.

| Блок | Что умеет |
| --- | --- |
| Telegram | Durable webhook ingress, быстрый ACK Telegram, FIFO-drain по chat/topic, обычные и rich replies, HITL callbacks с ограниченным окном подтверждения. |
| Семья и группы | Bootstrap владельца, приглашения, подтверждение участников, owner-only операции, семейные и внешние группы. |
| Память | Root-agent source-backed writes, semantic integrity для изменений, versioned mutations, soft delete, atomic memory threads, локальный hybrid retrieval, экспорт и отдельные scopes. |
| Расписания | Напоминания и автономные agent schedules: личные и семейные сценарии, а также owner-approved отчёты во внешние группы с отдельной fresh session, минимальным capability allowlist и bounded snapshot истории. |
| Голос | Groq Whisper transcription перед основным agent turn с повторной проверкой authorization. |
| Workspaces | Изолированные personal, family и group файловые области, attachment persistence, безопасная отправка файлов. |
| Изображения | Root-agent создаёт одно WebP через `gpt-image-2`, сохраняет его в authorized workspace и доставляет в Telegram без скрытых повторов; внешней группе capability выдаёт владелец из личного чата. |
| Google Workspace | Native `gws` skills для Gmail, Calendar, Drive, Docs, Sheets и People через workspace-bound OAuth credentials. |
| Sandbox | Долгоживущие Docker sandbox sessions с scoped mounts, isolated tools volume, egress proxy и fail-closed policy. |
| Оркестрация | В trusted private/family режимах root-agent делегирует большие задачи нативному Eve `agent` со свежим контекстом и теми же разрешёнными tools, skills, connections, sandbox и workspace; во внешних группах child delegation запрещена. |
| Production | Immutable GitHub releases, GHCR digest images, Telegram approval перед deploy, systemd timer на сервере. |

---

## Функционал

### 🧠 Долговременная память

- Помнит факты и договорённости; каждая запись привязана к источнику — можно спросить «откуда ты это взяла».
- **Треды** — незакрытые сюжеты (поиск квартиры, ремонт, лечение): агент сам поднимает их, когда тема возвращается.
- Гибридный поиск по памяти (pgvector + локальные эмбеддинги `multilingual-e5-small`), без отправки памяти во внешние сервисы.
- Конфликты («раньше говорил одно, теперь другое») выносятся на ваше решение, а не переписываются молча.
- Отдельные области: `personal`, `family`, `group`. Экспорт всей личной памяти в JSON + Markdown одной командой.

### ⏰ Напоминания и автономные сценарии

- Напоминания: разовые, ежедневные, еженедельные; личные и семейные.
- Агентные сценарии по расписанию — не просто текст в срок, а полноценный запуск с инструментами
  («каждое утро собери погоду, календарь и почту», «в пятницу — сводка по портфелю»).
- Часовой пояс и тихие часы: ночью не разбудит.
- Для внешних групп — отчёты по расписанию с отдельным подтверждением владельца.

### 🎙 Голос, файлы и вложения

- Голосовые сообщения расшифровываются через Groq Whisper до основного хода агента.
- Присланные файлы и фото сохраняются в рабочую область чата и доступны инструментам.
- Агент может прислать файл из рабочей области обратно в Telegram и посмотреть картинку.
- Изолированные области: `personal`, `family`, `group` — файлы одной области не видны в другой.

### 📄 Документы

- `pdf`, `docx`, `xlsx` — чтение, правка, сборка: договор, таблица, отчёт, презентационный документ.
- Работа идёт в sandbox-контейнере, результат приходит файлом в чат.

### 📬 Google Workspace

- Нативный `gws`-доступ к Gmail, Calendar, Drive, Docs, Sheets, People.
- OAuth-подключение владельца; токены шифруются и не попадают в текст модели.
- Пример: «что у меня в календаре на среду», «найди письмо от подрядчика и вытащи сумму».

### 📈 Т-Инвестиции

- Портфель, позиции, свободные деньги, котировки, операции, дивиденды, комиссии, доходность.
- Сделки — только по явной команде. Это доступ к данным и расчётам, не инвестиционные рекомендации.

### 🌐 Веб

- `agent-browser` — автоматизация браузера: открыть, заполнить, нажать, забрать данные.
- `find-docs` — актуальная документация библиотек и API вместо памяти модели.
- Во внешних группах веб-доступ идёт только через контролируемую обёртку и отдельное разрешение.

### 👨‍👩‍👧 Семья, приглашения, роли

- Bootstrap владельца по одноразовому коду при установке.
- Приглашение участника: владелец создаёт одноразовую ссылку → человек переходит → владелец подтверждает.
- Административные операции возможны только в личном чате владельца — и перепроверяются в базе перед выполнением.

### 💬 Группы

- **Семейная группа** (`family_private`): только подтверждённые участники семьи, доступна семейная память.
- **Внешняя группа** (`external`): своя изолированная область, без личных и семейных данных, без Bash и произвольной сети.
- Режимы реакции: только по обращению, на все сообщения, либо только на сообщения владельца.
- Для внешней группы владелец точечно выдаёт allowlist инструментов и skills; смена типа группы пересоздаёт зону доверия и удаляет данные прежней области.

### 🎛 Стиль и подтверждения

- Пожелания к стилю общения сохраняются на чат: короче, без смайлов, другой язык, свой формат.
- Действия с последствиями подтверждаются кнопкой в Telegram (HITL), включая деплой обновлений.
- Ручная ротация контекста, когда тема сменилась и старый диалог мешает.

### 💬 Живая переписка

- Ответ может прийти не одним сообщением: сначала по делу, а через пару секунд отдельная мысль
  вдогонку, как пишут люди. Реплаем помечено только первое сообщение.
- Пока идёт долгая работа, агент присылает короткую отбивку о том, что делает прямо сейчас,
  вместо молчания до готового результата.
- Вместо ответа на короткое «спасибо» или упоминание без вопроса агент ставит реакцию. Набор
  реакций берётся из настроек самого чата: сузили список или отключили реакции, агент это учтёт.

---

## Границы доступа

| Где | Память | Файлы | Инструменты |
| --- | --- | --- | --- |
| Личный чат | `personal` и `family` | `/workspace/personal`, `/workspace/family` | Полный trusted sandbox и personal tools environment; при активной Codex-подписке root-agent может создавать изображения. |
| Семейная группа | Только `family` | `/workspace/family` | Trusted sandbox и family tools environment; при активной Codex-подписке root-agent может создавать изображения. |
| Внешняя группа | Только `group` | `/workspace/group` | Без Bash, произвольного сетевого доступа и persistent credentials; `web_fetch` и `generate_image` доступны только через отдельные owner grants, причём `generate_image` предлагается владельцу лишь при активном provider `codex-subscription`; безопасные file tools и настраиваемый импорт UTF-8 TXT/MD/JSON/CSV/TSV/HTML/XML/YAML/YML из Telegram. |
| Native child | Та же проверенная identity и scopes, что у parent turn | Тот же разрешённый workspace и sandbox | Тот же trust-zone surface, кроме root-owned `remember` и `generate_image`; отдельные history и state. |

---

## Как пользоваться

**1. Поставить на сервер.** Нужен GNU/Linux x86_64 (glibc), Docker Engine + Compose v2, свободный порт `8082`; если Osinara ставит свой Traefik, ещё и свободные `80` и `443`.
Скачайте `install.sh` из последнего [релиза](https://github.com/nyxandro/osinara/releases/latest) и передайте ему URL CLI-ассета и его SHA-256 из того же релиза:

```bash
sudo ./install.sh \
  https://github.com/nyxandro/osinara/releases/download/vX.Y.Z/osinara-linux-x64 \
  <SHA-256 из osinara-linux-x64.sha256>
```

Установщик спросит домен (или предложит `sslip.io`) и способ публикации HTTPS: поставить свой Traefik
или использовать уже работающий на сервере прокси. Затем проверит Telegram-бота и модель, поднимет
digest-pinned образы, HTTPS и webhook, и выдаст ссылку владельца.

**2. Стать владельцем.** Перейдите по ссылке из установщика и напишите боту. Если ссылка не появилась —
`sudo osinara owner-bootstrap` выдаст новый код на 15 минут (прежний отзывается).

**3. Позвать своих.** В личном чате: «пригласи Анну» → отправьте ссылку → после её перехода подтвердите кандидата.

**4. Подключить группы.** Добавьте бота в группу и в личном чате владельца скажите, чем эта группа является:
семейной или внешней. Для внешней сразу задайте режим реакции и что ей разрешено.

**5. Дальше — обычным языком.** «Напомни в четверг про садик», «расшифруй голосовое и вынеси задачи»,
«собери из этих чеков таблицу», «что по портфелю», «каждое утро в 8 присылай сводку», «запомни, что мы выбрали клинику».

**Обслуживание:**

```bash
osinara status     # состояние сервисов
osinara doctor     # диагностика установки
osinara logs       # логи
osinara restart    # перезапуск
osinara config     # конфигурация модели и провайдера
```

Обновления агент сам предлагает в Telegram; деплой начинается только после подтверждения владельца.

---

## Локальная разработка

```bash
npm ci                      # postinstall применяет локальные Eve-патчи
cp .env.example .env        # заполнить обязательные секреты
docker compose up --build   # edge: http://localhost:8080
```

Полный список переменных — в [`.env.example`](.env.example): только секреты, доступы и привязки
к инфраструктуре. Поведение агента (таймауты, лимиты, расписания, настройки модели) живёт в
конфигурации в репозитории, а не в окружении. Отсутствующий обязательный секрет — ошибка на старте,
а не подставленное значение по умолчанию. Блок Google Workspace нужен только при включённой интеграции.

Проверки:

```bash
npm run typecheck && npm test && npm run build

# production-equivalent прогон
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

Миграции запускаются только внутри backend/test-контейнера: `npm run migrate`.

---

## Стек

TypeScript на Node 24 · [Eve](https://eve.dev/docs) `0.40.0` · PostgreSQL 17 + pgvector ·
Docker Compose · Groq Whisper · локальные эмбеддинги E5 · Telegram как единственный канал.

Архитектурные заметки и рантбуки — в [`docs/`](docs/), правила разработки — в [`CLAUDE.md`](CLAUDE.md)
и [`AGENTS.md`](AGENTS.md), деплой — в [`docs/production-deployment.md`](docs/production-deployment.md).

## Безопасность

- Авторизация принадлежит приложению: identity, семья, роль и область доступа никогда не берутся из текста модели.
- Память, документы, сайты и результаты инструментов — это данные, а не инструкции для агента.
- Отсутствие обязательного конфига — быстрая ошибка со стабильным кодом, а не догадка со значением по умолчанию.
- Внешние группы не получают личную и семейную память, учётные данные, Bash и произвольную сеть.
- Production-образы собирает только CI из канонического `main`; деплой требует подтверждения владельца и точной проверки манифеста релиза.

## Skills

Highlighted skill groups:

| Skill group | Examples |
| --- | --- |
| Google Workspace | `gws-gmail`, `gws-calendar`, `gws-drive`, `gws-docs`, `gws-sheets`, `gws-people`. |
| Documents | `pdf`, `docx`, `xlsx`. |
| Browser and research | `agent-browser`, `find-docs`. |
| Personalization | `behavior-preferences`. |
| Tone, opt-in | `pohuy` — режим ответов с матом, грузится только по явной просьбе. |
| Image generation | Dynamic `imagegen` доступен root-agent только вместе с активным subscription-backed `generate_image`; без provider `codex-subscription` ни tool, ни skill не существуют и не выдаются. |

## Release Badges

<p>
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-pgvector%2017-4169E1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker%20Compose-required-2496ED?style=flat-square&logo=docker&logoColor=white">
  <img alt="Telegram" src="https://img.shields.io/badge/Telegram-primary%20channel-26A5E4?style=flat-square&logo=telegram&logoColor=white">
  <img alt="Google Workspace" src="https://img.shields.io/badge/Google%20Workspace-native%20gws-4285F4?style=flat-square&logo=google&logoColor=white">
  <img alt="Groq" src="https://img.shields.io/badge/Groq-Whisper%20voice-F55036?style=flat-square">
</p>
