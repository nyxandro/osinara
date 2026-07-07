/// Events emitted by the future terminal wrapper and agent-specific hooks.
library;

enum AgentSessionEventType {
  launched,
  heartbeat,
  toolStarted,
  toolFinished,
  waitingForUser,
  permissionRequired,
  finished,
  failed,
  lost,
}

final class AgentSessionEvent {
  const AgentSessionEvent._({
    required this.type,
    required this.sessionId,
    required this.occurredAt,
    this.projectName,
    this.agentName,
    this.processId,
    this.exitCode,
    this.failureCode,
    this.failureMessage,
  });

  final AgentSessionEventType type;
  final String sessionId;
  final DateTime occurredAt;
  final String? projectName;
  final String? agentName;
  final int? processId;
  final int? exitCode;
  final String? failureCode;
  final String? failureMessage;

  factory AgentSessionEvent.launched({
    required String sessionId,
    required String projectName,
    required String agentName,
    required int processId,
    required DateTime occurredAt,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(projectName, 'projectName', 'OSI_PROJECT_NAME_MISSING');
    _requireText(agentName, 'agentName', 'OSI_AGENT_NAME_MISSING');
    _requirePositiveProcessId(processId);

    return AgentSessionEvent._(
      type: AgentSessionEventType.launched,
      sessionId: sessionId,
      projectName: projectName,
      agentName: agentName,
      processId: processId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.heartbeat({
    required String sessionId,
    required DateTime occurredAt,
  }) {
    return AgentSessionEvent._status(
      type: AgentSessionEventType.heartbeat,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.toolStarted({
    required String sessionId,
    required DateTime occurredAt,
  }) {
    return AgentSessionEvent._status(
      type: AgentSessionEventType.toolStarted,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.toolFinished({
    required String sessionId,
    required DateTime occurredAt,
  }) {
    return AgentSessionEvent._status(
      type: AgentSessionEventType.toolFinished,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.waitingForUser({
    required String sessionId,
    required DateTime occurredAt,
  }) {
    return AgentSessionEvent._status(
      type: AgentSessionEventType.waitingForUser,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.permissionRequired({
    required String sessionId,
    required DateTime occurredAt,
  }) {
    return AgentSessionEvent._status(
      type: AgentSessionEventType.permissionRequired,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }

  factory AgentSessionEvent.finished({
    required String sessionId,
    required DateTime occurredAt,
    required int exitCode,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');

    return AgentSessionEvent._(
      type: AgentSessionEventType.finished,
      sessionId: sessionId,
      occurredAt: occurredAt,
      exitCode: exitCode,
    );
  }

  factory AgentSessionEvent.failed({
    required String sessionId,
    required DateTime occurredAt,
    required String failureCode,
    required String failureMessage,
    int? exitCode,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(failureCode, 'failureCode', 'OSI_FAILURE_CODE_MISSING');
    _requireText(
      failureMessage,
      'failureMessage',
      'OSI_FAILURE_MESSAGE_MISSING',
    );

    return AgentSessionEvent._(
      type: AgentSessionEventType.failed,
      sessionId: sessionId,
      occurredAt: occurredAt,
      failureCode: failureCode,
      failureMessage: failureMessage,
      exitCode: exitCode,
    );
  }

  factory AgentSessionEvent.lost({
    required String sessionId,
    required DateTime occurredAt,
    required String failureMessage,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(
      failureMessage,
      'failureMessage',
      'OSI_FAILURE_MESSAGE_MISSING',
    );

    return AgentSessionEvent._(
      type: AgentSessionEventType.lost,
      sessionId: sessionId,
      occurredAt: occurredAt,
      failureCode: 'OSI_AGENT_SESSION_LOST',
      failureMessage: failureMessage,
    );
  }

  factory AgentSessionEvent._status({
    required AgentSessionEventType type,
    required String sessionId,
    required DateTime occurredAt,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');

    return AgentSessionEvent._(
      type: type,
      sessionId: sessionId,
      occurredAt: occurredAt,
    );
  }
}

// Required identifiers must fail fast because status events are the source of UI truth.
void _requireText(String value, String fieldName, String errorCode) {
  if (value.trim().isNotEmpty) {
    return;
  }

  throw ArgumentError.value(
    value,
    fieldName,
    '$errorCode: Не удалось обработать событие агента: обязательное поле $fieldName не заполнено. Повторите запуск агента.',
  );
}

// Process ids must come from a real launched process, not from an invented placeholder.
void _requirePositiveProcessId(int processId) {
  if (processId > 0) {
    return;
  }

  throw ArgumentError.value(
    processId,
    'processId',
    'OSI_PROCESS_ID_INVALID: Не удалось запустить индикацию агента: идентификатор процесса некорректен. Повторите запуск агента.',
  );
}
