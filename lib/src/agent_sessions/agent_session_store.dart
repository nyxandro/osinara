/// In-memory session store that powers tab status indicators.
library;

import 'package:flutter/foundation.dart';

import 'agent_session_event.dart';
import 'agent_session_snapshot.dart';

final class AgentSessionStore extends ChangeNotifier {
  final Map<String, AgentSessionSnapshot> _sessions = {};

  List<AgentSessionSnapshot> get sessions =>
      List.unmodifiable(_sessions.values);

  AgentSessionSnapshot sessionById(String sessionId) {
    final session = _sessions[sessionId];
    if (session != null) {
      return session;
    }

    throw StateError(
      'OSI_SESSION_NOT_FOUND: Не удалось найти сессию агента $sessionId. Повторите запуск агента.',
    );
  }

  void apply(AgentSessionEvent event) {
    final previous = _sessions[event.sessionId];

    // Terminal states are immutable to prevent stale heartbeats from reviving closed tabs.
    if (previous?.isTerminal ?? false) {
      return;
    }

    _sessions[event.sessionId] = switch (event.type) {
      AgentSessionEventType.launched => _fromLaunch(event),
      AgentSessionEventType.heartbeat => _activeSession(event).copyWith(
        updatedAt: event.occurredAt,
        lastHeartbeatAt: event.occurredAt,
      ),
      AgentSessionEventType.toolStarted => _activeSession(
        event,
      ).copyWith(state: AgentSessionState.working, updatedAt: event.occurredAt),
      AgentSessionEventType.toolFinished => _activeSession(
        event,
      ).copyWith(state: AgentSessionState.running, updatedAt: event.occurredAt),
      AgentSessionEventType.waitingForUser => _activeSession(event).copyWith(
        state: AgentSessionState.waitingForUser,
        updatedAt: event.occurredAt,
      ),
      AgentSessionEventType.permissionRequired =>
        _activeSession(event).copyWith(
          state: AgentSessionState.permissionRequired,
          updatedAt: event.occurredAt,
        ),
      AgentSessionEventType.finished => _activeSession(event).copyWith(
        state: AgentSessionState.finished,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        exitCode: event.exitCode,
      ),
      AgentSessionEventType.failed => _activeSession(event).copyWith(
        state: AgentSessionState.failed,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        exitCode: event.exitCode,
        failureCode: event.failureCode,
        failureMessage: event.failureMessage,
      ),
      AgentSessionEventType.lost => _activeSession(event).copyWith(
        state: AgentSessionState.lost,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        failureCode: event.failureCode,
        failureMessage: event.failureMessage,
      ),
    };

    notifyListeners();
  }

  void markStaleSessionsLost({
    required DateTime now,
    required Duration heartbeatTimeout,
  }) {
    var changed = false;

    // Only active sessions can become lost; finished/failed sessions are final.
    for (final entry in _sessions.entries.toList()) {
      final session = entry.value;
      if (!session.isActive) {
        continue;
      }

      if (now.difference(session.livenessAt) <= heartbeatTimeout) {
        continue;
      }

      _sessions[entry.key] = session.copyWith(
        state: AgentSessionState.lost,
        updatedAt: now,
        finishedAt: now,
        failureCode: 'OSI_AGENT_HEARTBEAT_TIMEOUT',
        failureMessage:
            'Связь с процессом агента потеряна. Проверьте открытый терминал или запустите агента заново.',
      );
      changed = true;
    }

    if (changed) {
      notifyListeners();
    }
  }

  AgentSessionSnapshot _fromLaunch(AgentSessionEvent event) {
    return AgentSessionSnapshot(
      sessionId: event.sessionId,
      projectName: event.projectName!,
      agentName: event.agentName!,
      state: AgentSessionState.running,
      processId: event.processId,
      startedAt: event.occurredAt,
      updatedAt: event.occurredAt,
      lastHeartbeatAt: event.occurredAt,
    );
  }

  AgentSessionSnapshot _activeSession(AgentSessionEvent event) {
    final session = _sessions[event.sessionId];
    if (session != null) {
      return session;
    }

    throw StateError(
      'OSI_SESSION_EVENT_OUT_OF_ORDER: Не удалось обновить сессию агента ${event.sessionId}: событие пришло до запуска сессии. Повторите запуск агента.',
    );
  }
}
