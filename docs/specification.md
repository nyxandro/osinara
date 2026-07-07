# Osinara Specification

## Идея

Osinara — локальное desktop-приложение для работы с проектами и CLI-агентами. Пользователь выбирает проект, видит его структуру, выбирает профиль агента и запускает нужную CLI-команду во встроенном терминале внутри окна приложения.

Приложение выступает как workspace: файлы проекта, список проектов, профили запуска и активные terminal tabs находятся в одном окне. Запущенные CLI-агенты закрепляются как вкладки внутри выбранного проекта, чтобы пользователь мог быстро переключаться между процессами.

## Целевая Платформа

- Windows.
- macOS.
- Linux.

## Основной Сценарий

1. Пользователь открывает приложение.
2. Выбирает проект из списка или добавляет новый путь к проекту.
3. Видит файловое дерево выбранного проекта.
4. Выбирает профиль агента: Claude Code, OpenCode, Codex или custom command.
5. Нажимает запуск внутри текущей launcher-вкладки.
6. Launcher-вкладка заменяется встроенной terminal tab и запускает указанную команду через PTY в директории проекта.
7. После запуска в tab bar появляется кнопка `+`, через которую можно открыть новую launcher-вкладку и запустить ещё одну CLI-сессию.

## Что Входит В Первую Версию

- Список проектов.
- Добавление, редактирование и удаление проекта из списка приложения.
- Project picker в стиле Zed: поиск, local/current WSL кандидаты, ручное добавление local/WSL/SSH project locations.
- Файловое дерево выбранного проекта.
- Read-only file viewer tabs для файлов, выбранных из дерева проекта.
- Профили CLI-агентов на проект или глобально.
- Встроенный терминал на базе PTY с вкладками внутри workspace.
- Постоянная верхняя tab bar в центральной зоне: launcher-вкладки, file-вкладки и terminal-вкладки являются одним типом workspace tabs.
- Отображение запущенных terminal sessions внутри выбранного проекта в правой панели Projects.
- Переключение проекта из правой панели меняет состояние всего окна: файловое дерево, центральные вкладки и выбранную сессию.
- Динамическое обновление уже загруженных уровней файлового дерева через filesystem watcher.
- Локальное хранение настроек и проектов.

## Что Не Входит В Первую Версию

- Внешнее терминальное приложение как основной режим запуска.
- Собственный terminal renderer с нуля: используется готовый Flutter terminal widget.
- ACP-интеграция.
- Парсинг вывода Claude/OpenCode/Codex.
- Семантическое управление активной агентской сессией поверх CLI-протокола.
- Облачный backend.
- Хранение токенов или credentials агентов.

## Профили Агентов

Профиль агента описывает команду, которую нужно запустить для проекта.

Примеры:

```text
Claude Code
command: claude
args: []

OpenCode
command: opencode
args: []

OpenCode GPT
command: opencode
args: ["--model", "openai/gpt-5.5"]

Custom Shell
command: user-defined
args: user-defined
```

## UX Направление

Интерфейс должен восприниматься как agent workspace, а не как IDE и не как обычный terminal launcher.

Основные зоны UI:

- левая панель выбранного проекта с взаимоисключаемыми режимами Files/Git;
- верхняя themed window title bar с drag region и системными кнопками окна;
- центральная рабочая зона с постоянной верхней tab bar, launcher-вкладками, file viewer tabs и полноразмерными embedded terminal tabs;
- правая панель проектов со списком запущенных terminal sessions внутри проекта;
- нижняя тонкая status bar с icon-only переключателями `Files`, `Git`, `Center`, `Projects` и icon-only кнопкой `Settings`;
- настройки приложения и команд в центральной зоне.

Левая панель файлового дерева не имеет отдельного заголовка. Дерево начинается от верхнего края панели и занимает всю доступную высоту, чтобы не тратить место на декоративный header. Git panel использует тот же левый слот и заменяет file tree: Files и Git не отображаются одновременно.

Native title bar операционной системы скрывается. Верхняя панель окна рисуется внутри Flutter в текущей теме Osinara и содержит `Minimize`, `Maximize/Restore` и `Close`. Свободная область title bar служит drag region, double click по ней переключает maximize/restore.

Нижняя status bar не использует фоновые кнопки и обводки вокруг иконок. Состояние панели показывается только цветом и прозрачностью иконки: активная иконка primary-colored, неактивная приглушённая.

Левая и правая панели должны менять ширину мышью через границу панели. При наведении на границу курсор показывает column-resize режим. Перетаскивание ограничено так, чтобы центральная рабочая зона оставалась пригодной для использования.

Центральная зона не должна добавлять внешний padding/margin вокруг активного терминала. Когда terminal tab выбрана, под tab bar остаётся только полноразмерный terminal viewport без карточек, заголовков, обводок и промежуточных отступов.

Активная terminal tab должна визуально сливаться с terminal viewport: нижние скругления активной terminal tab отключаются, separator между tab strip и terminal body окрашивается в цвет terminal background. Цвет активной terminal tab берётся из dominant edge color уже отрисованного терминала, чтобы вкладка совпадала с фактическим фоном Claude Code/OpenCode/Codex TUI, а не только с общей темой Osinara.

Launcher UI является содержимым вкладки, а не отдельным блоком над терминалом. Если пользователь запускает CLI из launcher-вкладки, эта же вкладка становится terminal-вкладкой. Новая launcher-вкладка создаётся через `+` в tab bar.

Клик по файлу в дереве открывает read-only file tab в центральной зоне. Повторный клик по тому же файлу выбирает уже открытую вкладку, а не создаёт дубликат.

Клик по проекту в правой панели переключает выбранный проект всего приложения. Клик по terminal session внутри проекта выбирает соответствующий проект и terminal tab.

Кнопка `Add project` открывает модалку выбора проекта. Модалка должна быть ближе к Zed project picker: поисковая строка сверху, быстрые команды `Connect SSH Server`, `Add WSL Distro`, `Open Folder`, затем сгруппированные project candidates. Выбор кандидата добавляет проект в список и выбирает его.

У каждого проекта в правой панели есть кнопка настроек, появляющаяся при наведении или когда проект выбран. Settings modal редактирует название, путь и иконку проекта, а также удаляет проект только из списка Osinara. Файлы на диске или на удалённом сервере удалять нельзя.

Внутренние окна, которые открываются в центральной зоне, должны иметь явную icon-only кнопку закрытия в правом верхнем углу. Для текущей версии это относится к окну настроек: закрытие возвращает пользователя к рабочей области.

## Мультиязычность

Интерфейс должен поддерживать два языка:

```text
English
Русский
```

Переключение языка находится в разделе настроек. Настройки открываются из нижней status bar через отдельную кнопку `Settings` / `Настройки`.

Текущий подход реализации:

- `MaterialApp.locale` управляется состоянием приложения;
- `supportedLocales` содержит `en` и `ru`;
- `flutter_localizations` подключён для системных Material/Cupertino/Widgets строк;
- все пользовательские UI-строки проходят через `AppStrings`;
- текущее выбранное значение языка передаётся в экран настроек как `AppLocale`.

## Темы

Интерфейс поддерживает светлую и тёмную темы. Переключение находится в разделе настроек рядом с выбором языка.

Текущая реализация хранит темы в отдельном модуле:

```text
lib/src/theme/osinara_theme.dart
  -> OsinaraThemeId
  -> OsinaraThemeOption
  -> OsinaraThemeTokens
  -> OsinaraThemeCatalog
```

`OsinaraThemeCatalog` является единой точкой расширения списка тем. Новая тема добавляется как новый `OsinaraThemeOption` с собственным `ThemeData` builder и `OsinaraThemeTokens`. App-specific цвета панелей, window title bar, status bar, resize handles и файловых иконок не хардкодятся в виджетах, а берутся из `OsinaraThemeTokens`.

Пользовательские ошибки остаются на русском языке даже в английском интерфейсе. Это сделано намеренно: сообщения об ошибках должны быть понятными, безопасными и не раскрывать технические детали вроде raw `ProcessException`, stack trace или внутренних путей без необходимости.

## Архитектура

Приложение строится как Flutter Desktop app. Flutter отвечает за интерфейс, состояние экранов и пользовательский опыт. CLI-агенты запускаются внутри встроенного терминала через PTY-процессы.

```text
Flutter Desktop App
  -> App Window Frame
  -> Project Manager
  -> File Tree Reader
  -> Agent Profile Manager
  -> Project Workspace Store
  -> Embedded Terminal Session Store
  -> PTY Process Factory
  -> Local Settings Storage

Embedded Terminal Tab
  -> claude / opencode / codex / custom command
```

## Модули

### Project Manager

Отвечает за список проектов, выбранный проект и базовые операции управления проектами.

```text
Project
  id
  name
  location
  iconName
  agentProfiles
  createdAt
  updatedAt

ProjectLocation
  kind: local | wsl | ssh
  path
  wslDistro?
  sshHost?
```

Project location является явной частью модели. Это нужно, чтобы local, WSL и SSH проекты не смешивались в одну строку пути и позже могли получить разные adapters для файлового дерева, терминала и синхронизации.

Правила project list:

- новый проект вставляется вверх списка и сразу выбирается;
- удаление проекта убирает только запись из Osinara;
- удаление или смена пути проекта закрывает terminal sessions, привязанные к старому пути;
- последний проект нельзя удалить, чтобы workspace не остался без выбранного project context.

### File Tree Reader

Читает файловую структуру выбранного проекта для отображения в UI.

Текущая реализация читает один уровень директории за раз. Дочерние директории раскрываются лениво, чтобы большие проекты не блокировали интерфейс и не запускали полный обход дерева без явного действия пользователя.

Каждый загруженный уровень дерева подписывается на filesystem events через `FileTreeWatchService`. При изменении файла или директории controller обновляет только уже загруженный parent path. Это позволяет видеть изменения, сделанные CLI-агентом, без полного обхода проекта и без скрытого сканирования нераскрытых директорий.

Файловое дерево показывает содержимое корня проекта, но не показывает саму корневую папку отдельной строкой. Если проект называется `osinara`, в дереве видны `lib`, `test`, `pubspec.yaml` и другие дочерние элементы, но не строка `osinara`.

Требования:

- не читать скрытые или тяжелые директории без явной необходимости;
- не блокировать UI при чтении больших проектов;
- учитывать ошибки доступа к файлам;
- обновлять уже загруженные уровни дерева после изменений на диске;
- не изменять файлы проекта в первой версии.

### File Viewer Tabs

File viewer tabs показывают содержимое файла, выбранного в дереве проекта. В первой версии viewer является read-only: Osinara не пишет изменения в пользовательские файлы и не создаёт editor state.

Правила:

- file tab хранит абсолютный path файла внутри workspace state;
- повторное открытие того же path выбирает существующую file tab;
- file tab восстанавливается между запусками приложения как обычная workspace tab;
- ошибки чтения файла показываются внутри viewer с понятным сообщением и не закрывают вкладку.

### Project Workspace Store

Хранит выбранный проект и UI-состояние центральных вкладок каждого проекта.

```text
ProjectWorkspace
  id
  name
  path

ProjectWorkspaceTab
  id
  kind: launcher | file | terminal
  filePath?
  terminalSessionId?
```

Правила:

- каждый проект всегда имеет минимум одну launcher-вкладку;
- запуск CLI заменяет текущую launcher-вкладку на terminal-вкладку;
- кнопка `+` добавляет новую launcher-вкладку в текущий проект;
- клик по файлу добавляет или выбирает file-вкладку текущего проекта;
- переключение проекта восстанавливает вкладки и выбранную вкладку этого проекта;
- выбор terminal session из Projects panel переключает весь workspace на проект-владелец этой сессии.

### Agent Profile Manager

Хранит команды запуска CLI-агентов.

```text
AgentProfile
  id
  name
  command
  args
  workingDirectoryMode
  environment
  terminalSessionDefaults
```

`workingDirectoryMode` определяет, откуда запускать команду:

- корень проекта;
- выбранная поддиректория;
- фиксированный путь.

### Embedded Terminal Manager

Отвечает за создание terminal tabs, запуск PTY-процессов, ввод/вывод терминала, resize и переключение активной вкладки.

```text
launch(project, agentProfile)
  -> validate project path
  -> validate command
  -> replace selected launcher tab with terminal tab
  -> build shell invocation for current OS
  -> start PTY process in project directory
  -> attach process output to TerminalView
  -> attach TerminalView input to PTY stdin
  -> register session under selected project
```

Текущая реализация:

```text
Terminal UI
  xterm TerminalView

PTY
  flutter_pty Pty.start

Session Store
  EmbeddedTerminalSessionStore
  EmbeddedTerminalProcessFactory
  EmbeddedTerminalCommandBuilder
```

Важное правило: launch-кнопки не зависят от выбора внешнего терминала. Если команда агента отсутствует в `PATH`, ошибка должна быть видна внутри созданной terminal tab или как понятное сообщение `OSI_EMBEDDED_TERMINAL_LAUNCH_FAILED`.

Для POSIX-систем команда запускается через shell invocation, чтобы пользовательские PATH-настройки были ближе к обычному терминальному окружению:

```text
$SHELL -lc '<agent command and args>'
```

На Windows используется `cmd.exe /c <agent command and args>` как базовая стратегия первой итерации.

### CLI Session Titles

Правая Projects panel показывает для terminal session название конкретной сессии, а не имя CLI-инструмента. До появления названия отображается локализованный placeholder `New session` / `Новая сессия`.

Название сессии выводится только из provider-specific metadata/logs через adapters:

- `ClaudeCodeSessionTitleAdapter` читает `~/.claude/sessions/<pid>.json` и transcript JSONL из `~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl`;
- `CodexSessionTitleAdapter` читает Codex JSONL transcripts из `~/.codex/sessions/**/*.jsonl`, сопоставляет `session_meta.payload.cwd` и время старта, затем берёт первый `event_msg.user_message` как title;
- `OpenCodeSessionTitleAdapter` является отдельной точкой расширения для metadata/log format OpenCode CLI, когда локальный формат сессий будет доступен;
- UI-компоненты не знают внутреннюю структуру Claude/OpenCode/Codex logs и получают уже готовое `EmbeddedTerminalSession.title`.

Если adapter не нашёл полезное название, session остаётся без title и продолжает отображать placeholder. После успешного чтения title сохраняется как optional terminal tab metadata, чтобы restored terminal tab после перезапуска показывал уже найденное название при повторном запуске CLI.

### Local Settings Storage

Хранит локальные настройки приложения и восстанавливаемое UI-состояние workspace.

Для начала допустим локальный JSON-файл. Если настройки станут сложнее, можно перейти на SQLite.

Типы данных:

- проекты;
- workspace tabs per project;
- selected project and selected tab per project;
- side panel visibility, left panel Files/Git mode and preferred widths;
- глобальные профили агентов;
- embedded terminal preferences;
- UI preferences;
- recent projects.

Текущий файл состояния workspace:

```text
~/.local/state/osinara/workspace-state.json
```

Сохраняются проекты, file tabs, launcher tabs, terminal tab metadata, выбранный режим левой панели Files/Git и layout панелей. Живой PTY-процесс нельзя resume-ить после рестарта приложения, поэтому Osinara восстанавливает terminal tab и заново запускает сохранённый `LaunchProfile` в директории проекта. Если повторный запуск не удался, вкладка остаётся в `failed` состоянии с понятным сообщением об ошибке.

### Git Integration

Git-интеграция первой очереди работает локально через системный `git`, так же как базовые Git-панели в IDE. Левая панель имеет два взаимоисключаемых режима: Files и Git. Если пользователь включает Git, файловое дерево скрывается и в том же левом слоте показывается статус выбранного проекта.

Текущий источник данных:

```text
git -C <projectPath> status --porcelain=v1 --branch
```

Правила:

- проект без `.git` показывает состояние `Not a Git repository`, а не ошибку;
- проект без `.git` показывает действие `Initialize repository`, которое выполняет `git init` в директории выбранного проекта и затем перечитывает статус;
- изменённые файлы отображаются компактными строками в стиле file tree;
- Git panel не хранит credentials и tokens;
- GitHub/GitLab/self-hosted remotes авторизуются через системные Git credentials, SSH keys, Git Credential Manager, `gh` или `glab`;
- Settings показывает browser-login actions для GitHub/GitLab: Osinara запускает provider CLI в фоне (`gh auth login --web --git-protocol https` или `glab auth login --hostname gitlab.com --device --git-protocol https`), парсит одноразовый код, открывает системный браузер на verification URL и показывает код в dialog; provider CLI продолжает владеть сохранением credentials;
- при успешном завершении provider CLI auth dialog закрывается автоматически, а Settings обновляет connection status провайдера на `Connected`;
- initialized repository показывает действие `Publish repository`, которое открывает dialog с явными обязательными полями: provider, owner/namespace, repository name, remote name и visibility;
- publish не подставляет скрытые значения для обязательных полей: если поле не заполнено, provider не выбран или visibility не выбрана, команда не запускается;
- GitHub publish выполняет `gh repo create <owner>/<repo> --private|--internal|--public --source <projectPath> --remote <remote>`, затем `git push -u <remote> <branch>`;
- GitLab publish выполняет `glab repo create <owner>/<repo> --visibility <visibility> --remoteName <remote>`, затем `git push -u <remote> <branch>`;
- будущие pull/clone actions должны использовать тот же credential layer, а не собственное хранилище токенов в Osinara.

### Remote And Sync Direction

Local, WSL и SSH проекты представлены через `ProjectLocation`, а не через один общий path string. Это намеренное разделение для дальнейшей долгой разработки.

Текущие правила:

- `local` project location указывает на обычную локальную директорию;
- `wsl` project location хранит имя WSL-дистрибутива и путь внутри него;
- `ssh` project location хранит SSH host и удалённый путь;
- project picker уже умеет создавать local/WSL/SSH project records;
- filesystem adapters и terminal adapters должны выбираться по `ProjectLocation.kind`, а не по эвристикам пути.

Будущая синхронизация для SSH должна быть отдельным слоем, а не частью UI:

```text
ProjectLocation
  -> FileTreeAdapter
  -> TerminalAdapter
  -> SyncAdapter

SyncAdapter
  -> pull remote metadata
  -> watch or poll remote changes
  -> sync changed files through explicit strategy
  -> never delete remote/local files without explicit user action
```

Для первой итерации проектная модель и UI уже различают SSH/WSL/local. Полная удалённая синхронизация файлов должна добавляться через отдельные adapters, чтобы не смешивать local FS calls, WSL commands и SSH transport внутри виджетов.

## Границы Ответственности

Osinara отвечает за:

- выбор проекта;
- отображение файлового дерева;
- read-only просмотр выбранных файлов во вкладках;
- динамическое обновление уже загруженных уровней файлового дерева;
- хранение профилей запуска;
- формирование команды запуска;
- запуск и отображение встроенных terminal tabs;
- восстановление UI-состояния вкладок при переключении проектов и между запусками приложения.

Osinara не отвечает за:

- выполнение логики CLI-агентов;
- авторизацию Claude/OpenCode/Codex;
- бизнес-логику CLI-агентов;
- безопасное хранение credentials агентов;
- изменение файлов без действия пользователя.

## Ограничения Встроенного Терминала

Встроенный терминал даёт Osinara контроль над PTY-процессом, вводом, выводом, размером терминала и вкладками. Но приложение не должно притворяться, что понимает состояние агента глубже, чем сообщает процесс или agent-specific integration.

Приложение не должно обещать:

- семантическое понимание действий Claude/OpenCode/Codex без hooks/plugins;
- точное состояние `working`, `waitingForUser`, `permissionRequired` без provider-specific событий;
- автоматическое завершение задачи;
- восстановление интерактивной CLI-сессии после закрытия приложения.

Эти возможности потребуют отдельного протокола интеграции, hooks или provider-specific plugins.

## Индикация Активности Агентов

Первая версия показывает статус embedded terminal tabs внутри приложения.

Базовый механизм:

```text
Osinara
  -> заменяет launcher tab на terminal tab
  -> создаёт EmbeddedTerminalSession
  -> запускает PTY process
  -> подключает PTY output к xterm TerminalView
  -> подключает TerminalView input к PTY stdin
  -> показывает session tab в центре и внутри проекта справа
```

Текущая реализация хранит runtime state в `EmbeddedTerminalSessionStore`. Wrapper/JSONL heartbeat больше не является основным механизмом запуска UI-сессий.

Статусы вкладки:

```text
running
exited
failed
```

`running` означает, что PTY-процесс жив. `exited` означает, что процесс завершился с exit code. `failed` означает ошибку запуска или ошибку stream bridge.

В первой реализации приложение не парсит визуальный вывод терминала. Парсинг текста допускается только как дополнительная эвристика в будущем, но не как основной источник истины.

Текущие launch-профили в UI:

```text
Claude Code -> claude
OpenCode    -> opencode
Codex       -> codex
```

Пользователь не выбирает внешнее терминальное приложение. Каждая launch-card создаёт новую embedded terminal tab.

## Ошибки И Диагностика

Пользовательские ошибки должны быть понятными и на русском языке.

Примеры кодов:

```text
OSI_PROJECT_PATH_MISSING
Не удалось открыть проект: путь к папке не указан. Выберите папку проекта и повторите запуск.

OSI_PROJECT_PATH_NOT_FOUND
Не удалось открыть проект: указанная папка не найдена. Проверьте путь к проекту.

OSI_EMBEDDED_TERMINAL_LAUNCH_FAILED
Не удалось открыть встроенный терминал для агента. Проверьте, что команда агента установлена и доступна в PATH.

OSI_AGENT_COMMAND_MISSING
Не удалось запустить агента: команда профиля не указана. Проверьте настройки агента.
```

Технические детали ошибок должны попадать в локальные diagnostics logs, а не показываться пользователю напрямую.

## Принятые Решения

### Использовать Flutter Desktop

Статус: принято.

Причина:

- нужен красивый кастомный UI;
- нужны Windows, macOS и Linux из одной кодовой базы;
- не хотим Tauri и Electron;
- встроенный терминал реализуется через готовые пакеты `xterm` и `flutter_pty`, а не через собственный renderer с нуля.

### Терминал Встраивается В Окно Приложения

Статус: принято.

Причина:

- пользователь хочет видеть CLI-агентов внутри Osinara, а не во внешних окнах;
- терминалы должны закрепляться как вкладки внутри проекта;
- нужно быстро переключаться между запущенными Claude/OpenCode/Codex сессиями.

Последствие:

- приложение отвечает за lifecycle PTY-процессов;
- закрытие вкладки должно завершать соответствующий процесс;
- внешний terminal launcher больше не является основным UX.

### Рисовать Window Chrome В Теме Osinara

Статус: принято.

Причина:

- native title bar может конфликтовать с тёмной темой и выглядеть как белая системная полоса;
- системные кнопки окна должны оставаться доступными, но визуально принадлежать продукту;
- единая themed top bar даёт одинаковое поведение на Windows, macOS и Linux.

Последствие:

- native title bar скрывается через `window_manager` до показа окна;
- `AppWindowFrame` рисует title bar внутри Flutter;
- window actions идут через `AppWindowController`, чтобы UI можно было тестировать без platform channel.

### Не Использовать ACP В Первой Версии

Статус: принято на текущий этап.

Причина:

- первая версия должна запускать обычные CLI-команды;
- OpenCode, Claude Code и другие агенты могут работать как внешние CLI;
- ACP можно вернуть позже как отдельный режим интеграции.

### Использовать xterm И flutter_pty

Статус: принято.

Причина:

- нужен production-grade embedded terminal без написания собственного renderer;
- `xterm` даёт Flutter terminal widget;
- `flutter_pty` даёт PTY-процесс с input/output/resize.

### Не Использовать Wrapper И Heartbeat Как Основной UI-Механизм

Статус: заменено embedded PTY-сессиями.

Причина:

- внешний терминал больше не основной режим;
- PTY-процесс напрямую сообщает exit code;
- terminal tab state хранится внутри `EmbeddedTerminalSessionStore`.

### Хранить Настройки Локально

Статус: принято.

Причина:

- приложение локальное;
- облачный backend не нужен;
- credentials агентов не должны храниться в Osinara.

Открытый вопрос:

- JSON-файл или SQLite для первой версии.

## Критерии Успеха Первой Версии

- Пользователь может быстро выбрать проект и запустить нужного CLI-агента.
- Верхняя системная панель окна рисуется в теме Osinara и содержит системные кнопки окна.
- Запуск открывает embedded terminal tab внутри Osinara.
- Активный terminal tab занимает всю центральную панель под tab bar без дополнительных UI-блоков.
- `+` в tab bar создаёт новую launcher-вкладку для запуска следующего CLI.
- Клик по файлу открывает read-only file tab без дублирования уже открытого файла.
- Запущенные terminal sessions отображаются в правой панели внутри выбранного проекта.
- Переключение проекта из правой панели меняет файловое дерево, центральные вкладки и выбранную сессию.
- Файловое дерево обновляет уже загруженные уровни после изменений на диске.
- Настройки проектов, вкладки и layout панелей сохраняются локально между запусками.
- Интерфейс выглядит как самостоятельный продукт, а не как технический прототип.

## Открытые Вопросы

1. Какое рабочее название оставить: Osinara или продолжить поиск имени с `cli` внутри?
2. Нужен ли встроенный редактируемый editor поверх текущего read-only file viewer?
3. Нужна ли история запусков агентов?
4. Должны ли agent profiles быть глобальными, проектными или оба варианта?
