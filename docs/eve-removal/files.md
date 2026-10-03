# Отказ от Eve: затронутые файлы

Приложение к [плану](plan.md). Разметка сделана 2026-10-02 по ветке `refactor/drop-eve`
(состояние кода = v0.34.3). Таблицы по коду приложения собраны автоматически: по импортам из Eve,
по запросам к колонкам `eve_*` и по разбору назначения каждого модуля. Поэтому формулировки
«что меняется» короткие; подробности — в плане по этапам.

Ничего из прикладного (инструменты, провайдеры, подагенты, `todo`, генерация картинок, разбор
памяти, самопробуждения и т. д.) не удаляется. Удаляется только то, что существует ради Eve.

## Точки входа: файлы, которые Eve находила по расположению (14)

Становятся обычными модулями, которые явно подключает `agent/main.ts`. Остаются на своих местах, чтобы не терять историю правок.

| Файл | Что меняется |
|---|---|
| `agent/agent.ts` | конфиг агента Eve → настройки ядра: модель, лимит шагов, сжатие |
| `agent/hooks/turn-interjection-delivery.ts` | хук шага → вызов на старте шага |
| `agent/instructions/conversation-mode.ts` | динамические инструкции Eve → блок инструкций ядра в явном порядке |
| `agent/instructions/delegation.ts` | динамические инструкции Eve → блок инструкций ядра в явном порядке |
| `agent/instructions/presentation-preferences.ts` | динамические инструкции Eve → блок инструкций ядра в явном порядке |
| `agent/instructions/reaction-set.ts` | динамические инструкции Eve → блок инструкций ядра в явном порядке |
| `agent/instructions/retrieved-memory.ts` | динамические инструкции Eve → блок инструкций ядра в явном порядке |
| `agent/sandbox.ts` | defineSandbox → явная фабрика sandbox ядра |
| `agent/schedules/agent-schedule-dispatch.ts` | defineSchedule → таймер планировщика ядра |
| `agent/schedules/memory-review-dispatch.ts` | defineSchedule → таймер планировщика ядра |
| `agent/schedules/reminder-dispatch.ts` | defineSchedule → таймер планировщика ядра |
| `agent/schedules/software-update-check.ts` | defineSchedule → таймер планировщика ядра |
| `agent/skills/scoped.ts` | динамические skills Eve → каталог скиллов ядра |
| `agent/tools/capabilities.ts` | defineDynamic step.started → вызов на каждом шаге ядра |

## Обходы Eve (23)

Написаны, чтобы исправить или обойти поведение Eve. Заменяются механизмом нового ядра или удаляются.

| Файл | Что меняется |
|---|---|
| `agent/channels/hitl-approval-timeout.ts` | маршрут-обход для attachSession — удалить |
| `agent/lib/eve-empty-delivery.ts` | маркер «промолчать»: строку оставить (она в истории и промпте), модуль переименовать |
| `agent/lib/memory-review/memory-review-execution-reconciliation.ts` | сверка разбора памяти по исходу хода в базе Eve — заменить статусом хода |
| `agent/lib/runtime-admission-reconciliation.ts` | **не удаляется**: сверка по мёртвым процессам остаётся (иначе контроллер выкатки навсегда сочтёт систему занятой), сверка по сессиям Eve переходит на статус хода |
| `agent/lib/runtime-handoff.ts` | передача хода в сессию Eve; в новом ядре ход стартует напрямую |
| `agent/lib/session-auth.ts` | чтение вызывающего из сессии Eve — перейти на контекст ядра |
| `agent/lib/sessions/session-eve-event.ts` | классификация событий корня Eve — заменить статусом хода |
| `agent/lib/sessions/session-lifecycle-event-repository.ts` | запись событий жизненного цикла Eve — заменить статусом хода |
| `agent/lib/sessions/workflow-orphan-run-purge.ts` | уборка осиротевших запусков Workflow — удалить |
| `agent/lib/sessions/workflow-postgres-session-storage.ts` | физическое удаление сессий из базы Eve — удалить, хранение истории своё |
| `agent/lib/sessions/workflow-turn-outcome.ts` | чтение исхода хода из потока событий Eve — удалить, статус хода в своей таблице |
| `agent/lib/telegram-hitl/approval-timeout-sweep.ts` | таймаут подтверждений через внутренний HTTP-маршрут (attachSession) — вызывать напрямую |
| `agent/lib/telegram-ingress-binding.ts` | привязка ingress к ходу Eve — свернуть в старт хода |
| `agent/lib/telegram-ingress-dispatch-control.ts` | контроль доставки в Eve (патч) — удалить |
| `agent/lib/telegram-ingress-recovery.ts` | восстановление обработки через сессию Eve — заменить |
| `agent/lib/telegram-ingress-session-cursor-repository.ts` | курсор потока событий Eve — удалить |
| `agent/lib/telegram-preparation-recovery.ts` | восстановление непривязанной подготовки к ходу Eve — заменить |
| `agent/lib/telegram-processing-deadline.ts` | наблюдение за потоком событий Eve и подтверждение отмены — заменить AbortSignal хода |
| `agent/lib/telegram-response-recovery.ts` | восстановление ответа по статусу запуска Workflow — заменить журналом шагов |
| `agent/lib/telegram-session-boundary.ts` | ожидание границы сессии Eve по потоку событий — удалить |
| `agent/lib/telegram-session-failure.ts` | сбой сессии Eve и конфликт владения каналом — заменить статусом хода |
| `agent/lib/telegram-stable-delivery.ts` | отправка без сдвига якоря продолжения Eve — упростить до обычной отправки |
| `agent/lib/telegram-turn-preparation.ts` | обработчик turn.started канала Eve — свернуть в старт хода |

## Адаптация (59)

Логика привязана к жизненному циклу Eve (события, сессии, передача хода). Поведение для человека не меняется, код меняется.

| Файл | Что меняется |
|---|---|
| `agent/channels/google-oauth.ts` | маршрут Eve → маршрут HTTP-сервера ядра, адрес тот же |
| `agent/channels/memory-review.ts` | внутренний канал Eve для разбора памяти → фоновый ход ядра |
| `agent/channels/telegram.ts` | обработчики событий канала Eve → обработчики завершения хода в ядре (логика доставки сохраняется) |
| `agent/lib/agent-schedules/agent-schedule-dispatcher.ts` | запуск сессии Eve через to() → запуск фонового хода ядра |
| `agent/lib/agent-schedules/scheduled-session.ts` | метаданные из auth сессии Eve → из контекста хода |
| `agent/lib/conversation-wakeups/conversation-wakeup-drain.ts` | передача в сессию Eve → постановка хода в очередь чата ядра |
| `agent/lib/conversation-wakeups/conversation-wakeup-events.ts` | события канала Eve → события хода ядра |
| `agent/lib/conversation-wakeups/conversation-wakeup-orphans.ts` | сохранить, проверить |
| `agent/lib/conversation-wakeups/conversation-wakeup-run-repository.ts` | привязка к ходу Eve → к ходу ядра |
| `agent/lib/conversation-wakeups/conversation-wakeup-transitions.ts` | код «Eve отказала в передаче» → «ход не стартовал» |
| `agent/lib/conversation-wakeups/conversation-wakeup-turn.ts` | auth в формате Eve → контекст ядра (формат тот же) |
| `agent/lib/group-skills/group-load-skill-tool.ts` | обёртка над load_skill Eve → load_skill ядра |
| `agent/lib/group-skills/group-skill-definitions.ts` | то же |
| `agent/lib/group-skills/group-skill-resolver.ts` | то же |
| `agent/lib/memory-retrieval.ts` | чтение последнего текста из истории Eve — формат тот же (AI SDK) |
| `agent/lib/memory-review/memory-review-admin.ts` | операторские действия — сохранить, без повтора Eve |
| `agent/lib/memory-review/memory-review-dispatch-recovery.ts` | восстановление — проверить ветки, завязанные на Eve |
| `agent/lib/memory-review/memory-review-dispatch-repository.ts` | переходы до/после передачи в Eve → до/после старта хода |
| `agent/lib/memory-review/memory-review-dispatch-terminal-repository.ts` | ветки «неоднозначный сбой сессии Eve» сократятся |
| `agent/lib/memory-review/memory-review-dispatcher.ts` | передача в канал Eve → фоновый ход ядра |
| `agent/lib/memory-review/memory-review-lane-recovery.ts` | то же |
| `agent/lib/memory-review/memory-review-model-recovery.ts` | то же |
| `agent/lib/memory-review/memory-review-session-repository.ts` | сессии Eve для разбора → сессии ядра |
| `agent/lib/memory-review/memory-review-session-terminal.ts` | то же |
| `agent/lib/memory-review/memory-review-session.ts` | опознание сессии Eve → опознание фонового хода |
| `agent/lib/memory-review/memory-review-tool-surface.ts` | запреты встроенных инструментов Eve → явный набор ядра |
| `agent/lib/memory-review/memory-review-turn-binding.ts` | привязка к ходу Eve → к ходу ядра |
| `agent/lib/memory-turn-source.ts` | привязка источников на turn.started → на старте хода |
| `agent/lib/memory-usage-report.ts` | сохранить |
| `agent/lib/neuraldeep-session-routing.ts` | привязка к id сессии Eve → к id сессии ядра |
| `agent/lib/prompt/turn-blocks.ts` | контекст резолвера Eve → контекст ядра; порядок блоков задаётся явно |
| `agent/lib/require-tool-approval-evidence.ts` | доказательство подтверждения по вызову Eve → по записи журнала |
| `agent/lib/runtime-maintenance.ts` | забор выкатки (maintenance) — сохранить, это наш контракт с контроллером |
| `agent/lib/sandbox-runner/runner-sandbox-backend.ts` | интерфейс sandbox Eve → интерфейс ядра (методы те же) |
| `agent/lib/sessions/session-context.ts` | id приложения из auth Eve → из контекста ядра |
| `agent/lib/sessions/session-policy.ts` | убрать техническую смену сессии каждые 50 ходов; ручная и по бездействию остаются |
| `agent/lib/sessions/session-repository.ts` | привязка к eve_session_id → к сессии ядра |
| `agent/lib/sessions/session-response-preparation.ts` | подготовка ответа под диспетчер Eve — сохранить смысл |
| `agent/lib/sessions/session-retention-repository.ts` | то же |
| `agent/lib/sessions/session-retention.ts` | удаление хранилища Eve → удаление своей истории |
| `agent/lib/sessions/session-task-cleanup-repository.ts` | уборка задач-сессий — сохранить, проверить привязку к Eve |
| `agent/lib/telegram-durable-ingress.ts` | хуки Eve onVerifiedUpdate/drain → вызов из HTTP-сервера и цикла очереди ядра |
| `agent/lib/telegram-hitl/approval-timeout-repository.ts` | комментарии и аренда под 30-секундную передачу Eve — упростить |
| `agent/lib/telegram-hitl/approval-timeout.ts` | ответ через attachSession → прямое завершение ожидания |
| `agent/lib/telegram-hitl/callback-ingress-binding.ts` | привязка нажатия к ходу Eve → к ожидающему ходу ядра |
| `agent/lib/telegram-hitl/input-request.ts` | рендер input.requested Eve → рендер запроса подтверждения ядра; ветка «лимит сессии Eve» (`session_limit_continuation`) уходит |
| `agent/lib/telegram-ingress-preparation.ts` | подготовка под диспетчер Eve → подготовка хода |
| `agent/lib/telegram-ingress-processing-repository.ts` | барьер «отправлено в Eve» → барьер «ход запущен» |
| `agent/lib/telegram-ingress-recovery-admin.ts` | операторское закрытие зависшего старта — сохранить, сменить источник статуса |
| `agent/lib/telegram-on-message.ts` | возвращает результат для Eve → возвращает решение о запуске хода |
| `agent/lib/telegram-turn-result.ts` | атрибуты авторизации для Eve → контекст хода ядра (формат тот же) |
| `agent/lib/tool-policy/external-group-bash.ts` | defineBashTool Eve → bash ядра |
| `agent/lib/tool-policy/external-group-file-tools.ts` | то же |
| `agent/lib/tool-policy/mode-tool-surface.ts` | встроенные инструменты Eve → встроенные ядра |
| `agent/lib/tool-policy/scoped-file-tools.ts` | обёртки над файловыми инструментами Eve → над портированными |
| `agent/lib/tool-policy/trusted-worker-file-tools.ts` | то же |
| `agent/lib/turn-interjection/turn-interjection-delivery.ts` | хук step.started Eve → вызов на старте шага |
| `agent/lib/turn-interjection/turn-interjection-surface.ts` | переизлучение встроенных инструментов Eve → встроенные ядра |
| `agent/lib/turn-interjection/turn-interjection-tool.ts` | сохранить механику через результаты инструментов (решение владельца) |

## Переименование колонок в SQL (28)

Запросы к `eve_session_id` / `eve_turn_id`. Меняются вместе с миграцией переименования в фазе B: в фазе A в базу только добавляются таблицы, чтобы откат был простым возвратом образа.

| Файл | Что меняется |
|---|---|
| `agent/lib/agent-schedules/agent-schedule-delivery-authorization.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/agent-schedules/agent-schedule-dispatch-state.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/agent-schedules/agent-schedule-recovery.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/agent-schedules/agent-schedule-run-completion.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/agent-schedules/agent-schedule-run-failure.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/agent-schedules/agent-schedule-run-observation.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/conversation-wakeups/conversation-wakeup-preparation.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/conversation-wakeups/conversation-wakeup-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-claim-writer.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-explicit-claim-evidence.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-review/memory-review-attempt.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-review/memory-review-model-admin.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-review/memory-review-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-review/memory-review-terminal-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-show-journal.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-turn-source-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-undo-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/memory-usage-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/operational-incidents/telegram-failure.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/profile-view-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/sessions/group-timeline-cursor-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/sessions/session-route-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/telegram-ingress-claim-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/telegram-ingress-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/telegram-media-group-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/telegram-progress-notice-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |
| `agent/lib/turn-interjection/turn-interjection-repository.ts` | SQL с eve_session_id/eve_turn_id → переименование |

## Только строка импорта (112)

Ядро даёт те же имена и форму (`defineTool`, контекст сессии, типы и функции Telegram), меняется только путь импорта.

| Файл | Что меняется |
|---|---|
| `agent/lib/agent-schedules/agent-schedule-context.ts` | SessionContext |
| `agent/lib/agent-schedules/scheduled-group-history-context.ts` | SessionAuth |
| `agent/lib/attachments/telegram-attachment-download.ts` | TelegramAttachment, downloadTelegramFile, getTelegramFile |
| `agent/lib/attachments/telegram-attachment-materializer.ts` | TelegramAttachment |
| `agent/lib/attachments/telegram-group-attachment-repository.ts` | TelegramMessage |
| `agent/lib/attachments/telegram-vision-attachment.ts` | TelegramAttachment |
| `agent/lib/attachments/telegram-workspace-attachments.ts` | TelegramAttachment |
| `agent/lib/attachments/telegram-workspace-file-delivery.ts` | resolveTelegramBotToken |
| `agent/lib/attachments/workspace-file-chat-delivery.ts` | ToolContext |
| `agent/lib/behavior-preference-context.ts` | DynamicResolveContext, SessionContext |
| `agent/lib/conversation-environment.ts` | SessionAuth |
| `agent/lib/conversation-timeline-repository.ts` | TelegramMessage |
| `agent/lib/family-context.ts` | SessionContext |
| `agent/lib/google-workspace/gmail-message-approval.ts` | SessionContext |
| `agent/lib/google-workspace/google-oauth-delivery.ts` | sendTelegramMessage |
| `agent/lib/google-workspace/google-workspace-command-runner.ts` | ToolContext |
| `agent/lib/google-workspace/google-workspace-context.ts` | SessionContext |
| `agent/lib/google-workspace/google-workspace-executor.ts` | ToolContext |
| `agent/lib/groq-voice-transcription.ts` | downloadTelegramFile, getTelegramFile |
| `agent/lib/image-generation/image-generation-skill.ts` | SkillDefinition, defineSkill |
| `agent/lib/image-generation/image-generation-tool-presentation.ts` | ToolDefinition |
| `agent/lib/memory-context.ts` | DynamicResolveContext, SessionContext |
| `agent/lib/memory-review/memory-review-owner-alert-transport.ts` | callTelegramApi |
| `agent/lib/model-facing-tool.ts` | ToolDefinition, defineTool |
| `agent/lib/reminders/group-reminder-context.ts` | SessionContext |
| `agent/lib/reminders/reminder-context.ts` | SessionContext |
| `agent/lib/reminders/telegram-reminder-delivery.ts` | callTelegramApi |
| `agent/lib/sandbox-runner/sandbox-runner-contract.ts` | SandboxSpawnOptions |
| `agent/lib/software-updates/callback.ts` | TelegramCallbackQuery |
| `agent/lib/software-updates/telegram-transport.ts` | answerTelegramCallbackQuery, callTelegramApi, editTelegramMessageReplyMarkup |
| `agent/lib/telegram-conversation-timeline.ts` | TelegramMessage |
| `agent/lib/telegram-delivery.ts` | sendTelegramMessage |
| `agent/lib/telegram-enrollment-boundary.ts` | TelegramContext, TelegramMessage |
| `agent/lib/telegram-final-delivery-repository.ts` | TelegramChatType; SQL с колонками eve_* |
| `agent/lib/telegram-final-presentation.ts` | splitTelegramMessageText |
| `agent/lib/telegram-group-history.ts` | ToolContext |
| `agent/lib/telegram-group-journal-repository.ts` | TelegramMessage |
| `agent/lib/telegram-group-message-storage.ts` | TelegramMessage |
| `agent/lib/telegram-hitl/approval-auth.ts` | SessionAuthContext; SQL с колонками eve_* |
| `agent/lib/telegram-hitl/approval-presentation.ts` | SessionContext |
| `agent/lib/telegram-hitl/approval-repository.ts` | SessionAuthContext; SQL с колонками eve_* |
| `agent/lib/telegram-hitl/approval-surface.ts` | SessionContext |
| `agent/lib/telegram-hitl/approval-timeout-prompt.ts` | callTelegramApi |
| `agent/lib/telegram-hitl/callback-authorization.ts` | TelegramCallbackQuery, TelegramContext, TelegramHitlCallbackResult, telegramContinuationToken |
| `agent/lib/telegram-inbound-actor.ts` | TelegramMessage |
| `agent/lib/telegram-media-group.ts` | TelegramMessage, TelegramUpdate, parseTelegramUpdate |
| `agent/lib/telegram-memory-export-delivery.ts` | resolveTelegramBotToken |
| `agent/lib/telegram-message-policy.ts` | TelegramMessage |
| `agent/lib/telegram-message-reaction.ts` | TelegramHandle |
| `agent/lib/telegram-on-message-context.ts` | TelegramMessage |
| `agent/lib/telegram-on-message-repositories.ts` | TelegramMessage |
| `agent/lib/telegram-plain-messages.ts` | TELEGRAM_MESSAGE_TEXT_MAX_LENGTH, TelegramEventContext |
| `agent/lib/telegram-private-burst-message.ts` | TelegramMessage, TelegramUpdate, parseTelegramUpdate |
| `agent/lib/telegram-profile-subjects.ts` | TelegramMessage |
| `agent/lib/telegram-progress-notice.ts` | TelegramEventContext, splitTelegramMessageText |
| `agent/lib/telegram-reaction-policy.ts` | TelegramHandle |
| `agent/lib/telegram-reply-attachment.ts` | TelegramMessage, parseTelegramUpdate |
| `agent/lib/telegram-reply-authorization.ts` | TelegramMessage |
| `agent/lib/telegram-reply-routing.ts` | TelegramMessage, telegramContinuationToken |
| `agent/lib/telegram-reply-target-snapshot.ts` | TelegramMessage |
| `agent/lib/telegram-reply.ts` | SessionContext, TelegramChannelState |
| `agent/lib/telegram-rich-messages.ts` | TelegramApiResponse, TelegramChannelState, TelegramChatType, TelegramHandle, callTelegramApi |
| `agent/lib/telegram-session-actor.ts` | SessionAuth |
| `agent/lib/telegram-voice-authorization.ts` | TelegramMessage |
| `agent/lib/tool-policy/controlled-web-fetch.ts` | defineTool |
| `agent/lib/tool-policy/conversation-web-tools.ts` | ToolContext, defineTool |
| `agent/lib/tool-policy/external-group-policy.ts` | SessionAuth |
| `agent/lib/tool-policy/external-group-reminder-tools.ts` | ToolDefinition, defineTool |
| `agent/lib/tool-policy/scheduled-external-tool.ts` | ToolDefinition, defineTool |
| `agent/lib/tool-policy/trusted-mode-tool-catalog.ts` | ToolDefinition |
| `agent/lib/tools/execute_google_workspace.ts` | defineTool |
| `agent/lib/tools/export_memory.ts` | defineTool |
| `agent/lib/tools/generate_image.ts` | ToolContext, ToolDefinition, defineTool |
| `agent/lib/tools/get_current_time.ts` | defineTool |
| `agent/lib/tools/get_memory_source.ts` | defineTool |
| `agent/lib/tools/import_telegram_attachment.ts` | defineTool |
| `agent/lib/tools/inspect_workspace_image.ts` | defineTool |
| `agent/lib/tools/list_agent_schedules.ts` | defineTool |
| `agent/lib/tools/list_group_history.ts` | defineTool |
| `agent/lib/tools/list_memories.ts` | defineTool |
| `agent/lib/tools/list_memory_threads.ts` | defineTool |
| `agent/lib/tools/list_pending_family_invitations.ts` | defineTool |
| `agent/lib/tools/list_proactive_deliveries.ts` | defineTool |
| `agent/lib/tools/list_reminders.ts` | defineTool |
| `agent/lib/tools/list_telegram_attachments.ts` | defineTool |
| `agent/lib/tools/manage_agent_schedule.ts` | defineTool |
| `agent/lib/tools/manage_behavior_preference.ts` | defineTool |
| `agent/lib/tools/manage_external_group_schedule.ts` | defineTool |
| `agent/lib/tools/manage_family_invitation.ts` | defineTool |
| `agent/lib/tools/manage_gmail_message.ts` | ToolContext, defineTool |
| `agent/lib/tools/manage_google_workspace_connection.ts` | defineTool |
| `agent/lib/tools/manage_memory.ts` | ToolContext, defineTool |
| `agent/lib/tools/manage_memory_conflict.ts` | defineTool |
| `agent/lib/tools/manage_memory_thread.ts` | defineTool |
| `agent/lib/tools/manage_profile_projection.ts` | defineTool |
| `agent/lib/tools/manage_reminder.ts` | defineTool |
| `agent/lib/tools/manage_telegram_group.ts` | defineTool |
| `agent/lib/tools/notification_settings.ts` | defineTool |
| `agent/lib/tools/read_memory_thread.ts` | defineTool |
| `agent/lib/tools/read_profile_view.ts` | defineTool |
| `agent/lib/tools/read_scheduled_group_history.ts` | defineTool |
| `agent/lib/tools/remember.ts` | defineTool |
| `agent/lib/tools/search_memories.ts` | defineTool |
| `agent/lib/tools/search_memory_threads.ts` | defineTool |
| `agent/lib/tools/send_voice_message.ts` | ToolContext, ToolDefinition, defineTool |
| `agent/lib/tools/send_workspace_file.ts` | defineTool |
| `agent/lib/tools/start_new_context.ts` | defineTool |
| `agent/lib/turn-interjection/turn-interjection-collector.ts` | TelegramMessage, ToolContext, parseTelegramUpdate |
| `agent/lib/turn-interjection/turn-interjection-scope.ts` | SessionAuth |
| `agent/lib/voice-messages/voice-recording-status.ts` | sendTelegramChatAction |
| `agent/lib/workspaces/remove-group-file-tool.ts` | defineTool |
| `agent/lib/workspaces/workspace-context.ts` | SessionContext |

## Без изменений (16)

Eve упоминается только в комментариях; комментарии поправить при случае.

| Файл | Что меняется |
|---|---|
| `agent/lib/conversation-wakeups/conversation-wakeup-context.ts` | Eve только в комментариях |
| `agent/lib/database-recovery.ts` | Eve только в комментариях |
| `agent/lib/memory-review/memory-review-config.ts` | Eve только в комментариях |
| `agent/lib/memory-review/memory-review-known-memory.ts` | Eve только в комментариях |
| `agent/lib/memory-review/memory-review-owner-alert-dispatcher.ts` | Eve только в комментариях |
| `agent/lib/memory-review/memory-review-owner-alert-repository.ts` | Eve только в комментариях |
| `agent/lib/memory-review/memory-review-prompt.ts` | Eve только в комментариях |
| `agent/lib/memory-review/telegram-memory-review-turn.ts` | Eve только в комментариях |
| `agent/lib/sessions/group-canonical-token.ts` | Eve только в комментариях |
| `agent/lib/telegram-hitl/approval-consequences.ts` | Eve только в комментариях |
| `agent/lib/telegram-hitl/approval-message.ts` | Eve только в комментариях |
| `agent/lib/telegram-hitl/gmail-approval-prompt.ts` | Eve только в комментариях |
| `agent/lib/telegram-hitl/settled-prompt.ts` | Eve только в комментариях |
| `agent/lib/telegram-ingress-contract.ts` | Eve только в комментариях |
| `agent/lib/turn-interjection/turn-interjection-block.ts` | Eve только в комментариях |
| `agent/lib/turn-interjection/turn-interjection-config.ts` | Eve только в комментариях |

## Удаляется: существует только ради Eve

| Что | Почему |
|---|---|
| `scripts/apply-eve-patches.ts`, `scripts/eve-patches/*` | Правки собранного кода Eve |
| `scripts/eve-runtime/delta-pacing.ts`, `ndjson-stream.ts`, `paged-stream.ts` и их тесты, `stream-notification.test.ts` | Замены частей хранения потоков Eve/Workflow |
| `scripts/eve-runtime/model-inactivity.ts` | **Не удаляется, переезжает** в `agent/runtime/model-inactivity.ts`: это наша политика таймаута модели на штатных таймерах AI SDK |
| `scripts/runtime/*` (`workflow-transport.ts`, тесты очереди и восстановления воркера) | Транспорт и воркер Workflow |
| `scripts/migrate-workflow.ts` (+ тест), `scripts/run-workflow-postgres-stress.ts`, `scripts/reset-workflow-stress-database.ts` | Миграции и стресс-тесты базы Eve |
| `scripts/validate-eve-tool-surface-build.ts` (+ тест) | Проверка manifest discovery после `eve build` |
| `stress/workflow-postgres/` | Стенд нагрузки базы Eve |
| `stress/telegram-conversation/` | **Удаляется после переноса сценариев.** Это стенд сквозного теста: настоящий канал, инструменты и инструкции с моделью-заглушкой. Сначала на нём снимаются эталонные запросы к модели (этап 0, до первой правки кода), его сценарии переносятся в новый сквозной тест на ядре (этап 10), и только потом он удаляется |
| `agent/channels/hitl-approval-timeout.ts` | Маршрут-обход (см. таблицу обходов) |
| Таблица `eve_session_event_cursors` | Курсор потока событий Eve; удаляется миграцией в фазе B |
| Тесты патчей: `agent/lib/eve-hitl-batch-patch.test.ts`, `eve-hitl-context.test.ts`, `eve-memory-review-agent-policy-patch.test.ts`, `eve-model-inactivity-patch.test.ts`, `eve-model-inactivity-retry.test.ts`, `eve-model-retry-policy-patch.test.ts`, `eve-production-start-patch.test.ts`, `eve-skill-sync.test.ts`, `eve-task-origin-auth-patch.test.ts`, `eve-telegram-deadline-patch.test.ts`, `eve-telegram-ingress-patch-hitl.test.ts`, `eve-telegram-ingress-patch.test.ts`, `eve-tool-refusal-logging-patch.test.ts`, `eve-turn-preparation-patch.test.ts` | Проверяют наложение патчей. Поведение, которое они защищали, переносится в тесты ядра (этапы 3–5) |
| Корневой `workflow-postgres-runtime.test.ts` | Проверяет запуск Workflow на PostgreSQL |

## Дополнения после второй проверки

| Файл | Категория | Что меняется |
|---|---|---|
| `agent/lib/turn-model-step-limit.ts` | обход Eve | Подмена модели «блокирующей» на 33-м шаге — заменить прямой проверкой в цикле с тем же кодом ошибки |
| `agent/lib/tool-policy/group-tool-catalog.ts` | обход Eve | Заглушки-запреты встроенных инструментов (`FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS`, `UNVERIFIED_CONTEXT_DENIALS`) — в ядре инструмента просто нет в наборе |
| `agent/lib/memory-review/memory-review-tool-surface.ts` | обход Eve | То же для `MEMORY_REVIEW_DENIED_TOOL_NAMES` |
| `scripts/memory-review-admin.ts` | адаптация | Проверяет завершённость сессии через базу Eve (`isConfiguredEveSessionTerminal`) → через статус хода ядра |
| `scripts/telegram-ingress-admin.ts` | адаптация | Тексты и проверки про «состояние Eve» |
| `tsconfig.json` | сборка | Убрать `.eve/**/*.d.ts` из `include` |
| `scripts/docker-entrypoint.sh` | сборка | `npm run start` (Eve CLI) → `node .runtime/agent/main.js`; проверки до старта и `start-after-migration` остаются |
| `Dockerfile` (образ `runtime`) | сборка | Не копировать `.output/` и `.eve/`; `agent/` оставить — на нём держится ручной запуск проверки обновлений через `tsx` |
| `infra/nginx.conf` | сборка | Закрыть `/.well-known/workflow/` уже в фазе A |
| `agent/lib/sandbox-runner/sandbox-runner-contract.ts` | без изменений в фазе A | Проверяет id сессии по формату Eve (`wrun_` + 26 символов); ядро выдаёт новые id того же вида, смена формата — фаза B |
| `stress/telegram-conversation/agent/agent.ts` | доработка перед удалением | Записывать полный запрос к модели (система, сообщения, инструменты) с настоящим `instructions.md` — это эталон для ядра |

## Тесты, которые переводятся, а не удаляются

| Тест | Что сделать |
|---|---|
| `agent/lib/eve-callback-deduplication.test.ts`, `eve-current-turn-instructions.test.ts`, `eve-empty-delivery-marker.test.ts` | Защищают наше поведение (повторное нажатие кнопки, инструкции текущего хода, маркер «промолчать»). Переименовать и перевести на ядро |
| `agent/lib/eve-032-session-cutover-migration.integration.test.ts`, `eve-turn-identity-migration.integration.test.ts` | Проверяют старые миграции, которые по-прежнему применяются к чистой базе. Оставить; поправить, если их затронет переименование колонок |
| `agent/lib/telegram-conversation.e2e.integration.test.ts` | Главный сквозной тест разговора. Перевести на ядро; он — критерий готовности этапа 5 |
| 93 теста, импортирующих Eve, и 44 теста, собирающих её контекст вручную | Контекст ядра повторяет форму контекста Eve, поэтому большинство меняет только импорт |
| 38 тестов с колонками `eve_*` | Вместе с переименованием колонок |

## Сборка, инфраструктура, выкатка

| Файл | Фаза A (первый релиз без Eve) | Фаза B (уборка) |
|---|---|---|
| `package.json` | Убрать `eve`, `@workflow/world-postgres`, `postinstall`; `build`, `dev`, `start`, `migrate` — свои команды; добавить явные зависимости импорта истории (`cbor-x`, `devalue`) | Убрать зависимости импорта истории вместе с ним |
| `Dockerfile` | Не копировать патчи, `.output`, `.eve`; собирать `agent/main.ts` так же, как сейчас собираются воркеры (`build:runtime`) | — |
| `compose.yaml`, `compose.production.yaml` | Тот же набор сервисов и томов: контроллер выкатки сверяет его с фиксированным списком в `release.sh`. Меняются только команды запуска. `WORKFLOW_POSTGRES_URL` остаётся у сервиса `migrate` для импорта истории | Убрать `telegram-ingress-worker`, том `sandbox-data` по пути `/app/.eve/sandbox-cache`, `WORKFLOW_*` |
| `compose.test.yaml` | База Eve нужна только тесту импорта истории | Убрать |
| `infra/nginx.conf` | Адреса `/eve/v1/telegram`, `/eve/v1/google-oauth/callback`, `/eve/v1/health` без изменений; закрыть `/.well-known/workflow/` | Переименовать upstream `eve_agent`, если захотим |
| `scripts/production-deploy/*` | Не меняются: новое ядро отвечает на те же проверки простоя и рукопожатие допуска | Убрать проверку простоя по базе Eve и обработку томов переезда с Eve 0.32; обновить контроллер на сервере вручную, как раньше |
| `scripts/provider-installer/host-executor.ts` | Продолжает создавать базу `osinara_workflow`: без неё текущий контроллер не сможет проверить простой перед следующим обновлением | Перестать создавать |
| `.github/workflows/ci-release.yaml` | Сверить шаги сборки с новыми командами | — |
| Корневые тесты выкатки (`compose-runtime.test.ts`, `production-release-contract.test.ts` и др.) | Поправить ожидания про команды запуска | Поправить под уборку |
| `AGENTS.md`, `README.md`, `docs/production-deployment.md` | Переписать разделы про Eve, discovery, патчи, правило «не класть тесты в `agent/tools/`» | Убрать упоминания базы Eve |
| `agent/config.ts` | Убрать константы ради Eve: `SESSION_MAX_COMPLETED_TURNS`, `WORKFLOW_ORPHAN_RUN_*`, `EVE_RUN_ABANDONED_AFTER_HOURS`, `AGENT_INTERNAL_SELF_BASE_URL`, коды уборки Eve; поправить комментарии про Eve у таймаутов подтверждения | — |
