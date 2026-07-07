import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/agent_sessions/agent_session_event.dart';
import 'package:osinara/src/agent_sessions/agent_session_snapshot.dart';
import 'package:osinara/src/agent_sessions/agent_session_store.dart';

void main() {
  group('AgentSessionStore', () {
    test('creates a running session from a launch event', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'Claude Code',
          processId: 9001,
          occurredAt: launchedAt,
        ),
      );

      final session = store.sessionById('session-1');
      expect(session.state, AgentSessionState.running);
      expect(session.isActive, isTrue);
      expect(session.processId, 9001);
      expect(session.startedAt, launchedAt);
    });

    test('uses heartbeat events to keep a launched session alive', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);
      final heartbeatAt = launchedAt.add(const Duration(seconds: 5));

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'OpenCode',
          processId: 9002,
          occurredAt: launchedAt,
        ),
      );
      store.apply(
        AgentSessionEvent.heartbeat(
          sessionId: 'session-1',
          occurredAt: heartbeatAt,
        ),
      );

      final session = store.sessionById('session-1');
      expect(session.state, AgentSessionState.running);
      expect(session.lastHeartbeatAt, heartbeatAt);
    });

    test('shows working only while an agent action is active', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'Claude Code',
          processId: 9003,
          occurredAt: launchedAt,
        ),
      );
      store.apply(
        AgentSessionEvent.toolStarted(
          sessionId: 'session-1',
          occurredAt: launchedAt.add(const Duration(seconds: 2)),
        ),
      );

      expect(store.sessionById('session-1').state, AgentSessionState.working);

      store.apply(
        AgentSessionEvent.toolFinished(
          sessionId: 'session-1',
          occurredAt: launchedAt.add(const Duration(seconds: 8)),
        ),
      );

      expect(store.sessionById('session-1').state, AgentSessionState.running);
    });

    test('marks attention states without finishing the session', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'Claude Code',
          processId: 9004,
          occurredAt: launchedAt,
        ),
      );
      store.apply(
        AgentSessionEvent.waitingForUser(
          sessionId: 'session-1',
          occurredAt: launchedAt.add(const Duration(seconds: 3)),
        ),
      );

      final session = store.sessionById('session-1');
      expect(session.state, AgentSessionState.waitingForUser);
      expect(session.needsAttention, isTrue);
      expect(session.isActive, isTrue);
    });

    test('keeps terminal states immutable after finish', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'OpenCode',
          processId: 9005,
          occurredAt: launchedAt,
        ),
      );
      store.apply(
        AgentSessionEvent.finished(
          sessionId: 'session-1',
          occurredAt: launchedAt.add(const Duration(minutes: 1)),
          exitCode: 0,
        ),
      );
      store.apply(
        AgentSessionEvent.heartbeat(
          sessionId: 'session-1',
          occurredAt: launchedAt.add(const Duration(minutes: 2)),
        ),
      );

      final session = store.sessionById('session-1');
      expect(session.state, AgentSessionState.finished);
      expect(session.isActive, isFalse);
      expect(session.exitCode, 0);
    });

    test('marks stale active sessions as lost', () {
      final store = AgentSessionStore();
      final launchedAt = DateTime.utc(2026, 7, 6, 12);

      store.apply(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'Codex',
          processId: 9006,
          occurredAt: launchedAt,
        ),
      );

      store.markStaleSessionsLost(
        now: launchedAt.add(const Duration(seconds: 31)),
        heartbeatTimeout: const Duration(seconds: 30),
      );

      final session = store.sessionById('session-1');
      expect(session.state, AgentSessionState.lost);
      expect(session.isActive, isFalse);
    });

    test('rejects events without a session id', () {
      expect(
        () => AgentSessionEvent.heartbeat(
          sessionId: '',
          occurredAt: DateTime.utc(2026, 7, 6, 12),
        ),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
