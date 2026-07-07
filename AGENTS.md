# Osinara

## Что это

Osinara — Flutter Desktop workspace для CLI-агентов. Цель: одно окно с проектами, file tree, file tabs, embedded PTY terminal tabs и правой панелью Projects с сессиями внутри проектов.

Текущая платформа разработки: Linux/WSL. Основной runtime — Flutter Desktop, не Tauri/Electron.

## Ключевая модель

- `ProjectWorkspaceStore` управляет проектами, выбранным проектом и центральными workspace tabs.
- `EmbeddedTerminalSessionStore` управляет PTY-сессиями, terminal lifecycle и session titles.
- Launcher tab заменяется terminal tab при запуске профиля.
- File tab открывается из file tree и живёт в центральной tab bar.
- Левая панель имеет взаимоисключаемые режимы Files/Git; Git panel читает локальный статус через системный `git`.
- После рестарта старый PTY не resume-ится, но сохранённые terminal tabs автоматически заново запускают свой `LaunchProfile` в той же вкладке.
- Workspace state хранится в `~/.local/state/osinara/workspace-state.json`.
- Единственная продуктовая спецификация: `docs/specification.md`.

## UI-правила

- Центр: постоянная верхняя tab bar; terminal viewport без padding/margin под tab bar.
- Active terminal tab сливается с terminal background через sampled edge color.
- Левый file tree без root folder row и без header; Git panel заменяет file tree в том же левом слоте.
- Правая Projects panel: проект выглядит как папка, session как вложенный файл; path проекта показывается только на hover; session row без статуса, только icon + title.
- Project settings gear должен оставаться на project row.
- Native title bar скрыт; кастомный title bar содержит только minimize, maximize/restore, close.

## Session Titles

- UI показывает `session.title ?? New session/Новая сессия`, не имя CLI-инструмента.
- Claude Code adapter читает `~/.claude/sessions/<pid>.json` и transcript JSONL.
- Codex adapter читает `~/.codex/sessions/**/*.jsonl`.
- OpenCode adapter пока placeholder: локальный session/log format не найден.
- Title сохраняется как optional terminal tab metadata.

## Разработка

## Git

- Локальная Git-интеграция работает через `git status --porcelain=v1 --branch`.
- GitHub/GitLab авторизация не хранится в Osinara: использовать системные Git credentials, SSH keys, Git Credential Manager, `gh` или `glab`, как в IDE.
- Не добавлять токены Git-провайдеров в `.env` или workspace state.

Dev-run без release rebuild:

```bash
/home/nyxandro/dev/flutter/bin/flutter run -d linux
```

Внутри `flutter run`:

- `r` — hot reload, обычно достаточно для UI/Dart правок;
- `R` — hot restart, если менялся init/main/window setup;
- `q` — остановить debug-run.

Release build нужен только для финальной проверки:

```bash
/home/nyxandro/dev/flutter/bin/flutter build linux
```

Запуск release bundle:

```bash
setsid /home/nyxandro/projects/osinara/build/linux/x64/release/bundle/osinara >/tmp/opencode/osinara.log 2>&1 &
```

WSL/Mesa warnings в `/tmp/opencode/osinara.log` ожидаемы и обычно не являются ошибкой.

## Проверки

Перед завершением изменений запускать:

```bash
/home/nyxandro/dev/flutter/bin/dart format lib test bin
/home/nyxandro/dev/flutter/bin/flutter analyze
/home/nyxandro/dev/flutter/bin/flutter test
```

Для финальной runtime-проверки дополнительно:

```bash
/home/nyxandro/dev/flutter/bin/flutter build linux
```

## Кодовые ограничения

- Держать source-файлы меньше 500 строк; если близко к лимиту — выносить виджеты/логику.
- Новые non-trivial `.dart` файлы начинать с JSDoc-style header с ключевыми exports/constructs.
- Не добавлять fallback values для required data/config; fail fast с понятным error code.
- Не трогать legacy external terminal launcher без явной задачи: активный путь запуска — embedded PTY.
- Проект сейчас без git repo, `git status` недоступен.
