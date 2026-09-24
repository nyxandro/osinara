/** Every individually loaded Google skill includes Osinara's execution contract. */
export const GOOGLE_WORKSPACE_EXECUTION_GUIDE = [
  "## Выполнение в Osinara",
  "Все команды ниже выполняй только через execute_google_workspace, передавая argv без gws. В Bash нет ни gws, ни Google-профиля. Не ищи бинарник и учётные данные и не запускай gws через скрипты.",
  "Сохраняй знак + у helper-команд. API resource и method - отдельные элементы argv; идентификаторы передаются через --params. Для справки используй top-level schema.",
  "Примеры вызовов execute_google_workspace (фильтры, период и лимит выбирай по текущей задаче):",
  '```json\n{"argv":["gmail","+triage","--max","20","--labels"]}\n{"argv":["calendar","+agenda","--today","--timezone","Europe/Moscow"]}\n{"argv":["schema","gmail.users.messages.list"]}\n```',
  "Профиль выбирает backend по текущему чату. Отказ неверной команды не означает потерю авторизации: следуй correction и example ошибки. Изменения требуют штатного подтверждения Eve; состояние писем изменяй через manage_gmail_message одной пачкой до 30 писем, а не отдельным вызовом на каждое. Не подменяй подтверждение вопросом в чате.",
].join("\n\n");
