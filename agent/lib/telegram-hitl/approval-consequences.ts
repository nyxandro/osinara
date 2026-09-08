/**
 * Consequence wording shared by approval composition and settlement.
 *
 * Exports:
 * - `DEFAULT_CONSEQUENCE`, `GOOGLE_WORKSPACE_CONSEQUENCE`, `SCHEDULE_CONSEQUENCES`.
 * - `allApprovalConsequences`: every sentence a settled prompt may need stripped.
 *
 * Key constructs:
 * - Pure text only. The settlement path — including the background timeout sweep — must not pull a
 *   PostgreSQL repository in just to learn how a sentence is worded.
 */
export const DEFAULT_CONSEQUENCE =
  "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.";

export const PROFILE_PROJECTION_ENABLE_CONSEQUENCE =
  "Подходящие факты из этой группы станут доступны в личных чатах только после доставки уведомления в группу. Настройка действует до отключения владельцем.";
export const PROFILE_PROJECTION_DISABLE_CONSEQUENCE =
  "Перенос будет отключён до следующего включения владельцем. Групповые факты больше не будут подбираться в личные профили по этой настройке. Факты в памяти группы и ранее отправленные ответы не удаляются.";

export const GOOGLE_WORKSPACE_CONSEQUENCE =
  "Команда будет выполнена один раз в текущем профиле. Автоматического повтора при ошибке не будет.";

export const GROUP_SKILLS_BASH_CONSEQUENCE =
  "Скиллы будут разрешены до отзыва. Для их работы также включатся Bash и доступ к публичным сайтам в отдельном окружении группы. Личные файлы и авторизации туда не передаются. Текущие процессы группы будут остановлены, её файлы сохранятся.";
export const GROUP_SKILLS_CONSEQUENCE =
  "Полный список скиллов группы будет заменён указанным и сохранится до следующего изменения. Текущие процессы группы будут остановлены, её файлы сохранятся.";
export const GROUP_TOOLS_BASH_CONSEQUENCE =
  "Права группы будут заменены указанным списком. Bash позволяет выполнять команды и менять файлы группы; доступ к публичным сайтам идёт через защищённый шлюз. Личные файлы и авторизации не передаются. Текущие процессы группы будут остановлены.";
export const GROUP_TOOLS_NO_BASH_CONSEQUENCE =
  "Права группы будут заменены указанным списком. Bash и все скиллы, которым он нужен, будут отключены. Текущие процессы группы будут остановлены, её файлы сохранятся.";

export const SCHEDULE_CONSEQUENCES: Readonly<Record<string, string>> = {
  create: "Будет создан новый автоматический запуск агента по указанному сценарию.",
  delete: "Расписание и все его будущие автоматические запуски будут удалены.",
  pause: "Будущие автоматические запуски остановятся до ручного возобновления.",
  resume: "Автоматические запуски возобновятся по сохранённому расписанию.",
  run_now: "Сценарий будет запущен один раз сейчас; обычное расписание не изменится.",
  update: "Сохранённые параметры расписания будут заменены указанными изменениями.",
};

export function allApprovalConsequences(): string[] {
  return [
    DEFAULT_CONSEQUENCE,
    PROFILE_PROJECTION_ENABLE_CONSEQUENCE,
    PROFILE_PROJECTION_DISABLE_CONSEQUENCE,
    GOOGLE_WORKSPACE_CONSEQUENCE,
    GROUP_SKILLS_BASH_CONSEQUENCE, GROUP_SKILLS_CONSEQUENCE, GROUP_TOOLS_BASH_CONSEQUENCE, GROUP_TOOLS_NO_BASH_CONSEQUENCE,
    ...Object.values(SCHEDULE_CONSEQUENCES),
  ];
}
