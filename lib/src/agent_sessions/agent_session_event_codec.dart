/// JSON codec for agent session events exchanged through the local event log.
library;

import 'agent_session_event.dart';

abstract final class AgentSessionEventCodec {
  static Map<String, Object?> toJson(AgentSessionEvent event) {
    final json = <String, Object?>{
      'type': event.type.name,
      'sessionId': event.sessionId,
      'occurredAt': event.occurredAt.toUtc().toIso8601String(),
      'projectName': event.projectName,
      'agentName': event.agentName,
      'processId': event.processId,
      'exitCode': event.exitCode,
      'failureCode': event.failureCode,
      'failureMessage': event.failureMessage,
    };

    // Keep event lines compact and avoid encoding absent optional fields as nulls.
    json.removeWhere((_, value) => value == null);
    return json;
  }

  static AgentSessionEvent fromJson(Map<String, Object?> json) {
    final type = _eventType(json['type']);
    final sessionId = _text(json, 'sessionId');
    final occurredAt = _dateTime(json, 'occurredAt');

    return switch (type) {
      AgentSessionEventType.launched => AgentSessionEvent.launched(
        sessionId: sessionId,
        projectName: _text(json, 'projectName'),
        agentName: _text(json, 'agentName'),
        processId: _integer(json, 'processId'),
        occurredAt: occurredAt,
      ),
      AgentSessionEventType.heartbeat => AgentSessionEvent.heartbeat(
        sessionId: sessionId,
        occurredAt: occurredAt,
      ),
      AgentSessionEventType.toolStarted => AgentSessionEvent.toolStarted(
        sessionId: sessionId,
        occurredAt: occurredAt,
      ),
      AgentSessionEventType.toolFinished => AgentSessionEvent.toolFinished(
        sessionId: sessionId,
        occurredAt: occurredAt,
      ),
      AgentSessionEventType.waitingForUser => AgentSessionEvent.waitingForUser(
        sessionId: sessionId,
        occurredAt: occurredAt,
      ),
      AgentSessionEventType.permissionRequired =>
        AgentSessionEvent.permissionRequired(
          sessionId: sessionId,
          occurredAt: occurredAt,
        ),
      AgentSessionEventType.finished => AgentSessionEvent.finished(
        sessionId: sessionId,
        occurredAt: occurredAt,
        exitCode: _integer(json, 'exitCode'),
      ),
      AgentSessionEventType.failed => AgentSessionEvent.failed(
        sessionId: sessionId,
        occurredAt: occurredAt,
        failureCode: _text(json, 'failureCode'),
        failureMessage: _text(json, 'failureMessage'),
        exitCode: _optionalInteger(json, 'exitCode'),
      ),
      AgentSessionEventType.lost => AgentSessionEvent.lost(
        sessionId: sessionId,
        occurredAt: occurredAt,
        failureMessage: _text(json, 'failureMessage'),
      ),
    };
  }

  static AgentSessionEventType _eventType(Object? value) {
    if (value is! String || value.trim().isEmpty) {
      throw const FormatException(
        'OSI_EVENT_TYPE_MISSING: Не удалось прочитать событие агента: тип события не указан.',
      );
    }

    for (final type in AgentSessionEventType.values) {
      if (type.name == value) {
        return type;
      }
    }

    throw FormatException(
      'OSI_EVENT_TYPE_UNKNOWN: Не удалось прочитать событие агента: неизвестный тип события $value.',
    );
  }

  static String _text(Map<String, Object?> json, String fieldName) {
    final value = json[fieldName];
    if (value is String && value.trim().isNotEmpty) {
      return value;
    }

    throw FormatException(
      'OSI_EVENT_FIELD_MISSING: Не удалось прочитать событие агента: поле $fieldName не заполнено.',
    );
  }

  static int _integer(Map<String, Object?> json, String fieldName) {
    final value = json[fieldName];
    if (value is int) {
      return value;
    }

    throw FormatException(
      'OSI_EVENT_FIELD_INVALID: Не удалось прочитать событие агента: поле $fieldName должно быть числом.',
    );
  }

  static int? _optionalInteger(Map<String, Object?> json, String fieldName) {
    final value = json[fieldName];
    if (value == null) {
      return null;
    }

    if (value is int) {
      return value;
    }

    throw FormatException(
      'OSI_EVENT_FIELD_INVALID: Не удалось прочитать событие агента: поле $fieldName должно быть числом.',
    );
  }

  static DateTime _dateTime(Map<String, Object?> json, String fieldName) {
    final value = json[fieldName];
    if (value is! String || value.trim().isEmpty) {
      throw FormatException(
        'OSI_EVENT_FIELD_MISSING: Не удалось прочитать событие агента: поле $fieldName не заполнено.',
      );
    }

    return DateTime.parse(value).toUtc();
  }
}
