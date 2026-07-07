import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/agent_sessions/agent_session_event.dart';
import 'package:osinara/src/agent_sessions/agent_session_event_codec.dart';
import 'package:osinara/src/agent_sessions/agent_session_event_log.dart';

void main() {
  group('AgentSessionEventCodec', () {
    test('round-trips launched events through JSON', () {
      final event = AgentSessionEvent.launched(
        sessionId: 'session-1',
        projectName: 'osinara',
        agentName: 'Claude Code',
        processId: 42,
        occurredAt: DateTime.utc(2026, 7, 6, 12),
      );

      final json = AgentSessionEventCodec.toJson(event);
      final decoded = AgentSessionEventCodec.fromJson(json);

      expect(decoded.type, AgentSessionEventType.launched);
      expect(decoded.sessionId, 'session-1');
      expect(decoded.projectName, 'osinara');
      expect(decoded.agentName, 'Claude Code');
      expect(decoded.processId, 42);
    });

    test('rejects events with an unknown type', () {
      expect(
        () => AgentSessionEventCodec.fromJson({
          'type': 'unknown',
          'sessionId': 'session-1',
          'occurredAt': '2026-07-06T12:00:00.000Z',
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('AgentSessionEventLog', () {
    test('appends and reads JSONL session events', () async {
      final tempDir = await Directory.systemTemp.createTemp(
        'osinara-event-log-',
      );
      addTearDown(() async => tempDir.delete(recursive: true));
      final log = AgentSessionEventLog(File('${tempDir.path}/events.jsonl'));

      await log.append(
        AgentSessionEvent.launched(
          sessionId: 'session-1',
          projectName: 'osinara',
          agentName: 'OpenCode',
          processId: 77,
          occurredAt: DateTime.utc(2026, 7, 6, 12),
        ),
      );
      await log.append(
        AgentSessionEvent.heartbeat(
          sessionId: 'session-1',
          occurredAt: DateTime.utc(2026, 7, 6, 12, 0, 5),
        ),
      );

      final events = await log.readAll();
      expect(events, hasLength(2));
      expect(events.first.type, AgentSessionEventType.launched);
      expect(events.last.type, AgentSessionEventType.heartbeat);
    });

    test(
      'returns an empty list when the log file does not exist yet',
      () async {
        final tempDir = await Directory.systemTemp.createTemp(
          'osinara-event-log-',
        );
        addTearDown(() async => tempDir.delete(recursive: true));
        final log = AgentSessionEventLog(File('${tempDir.path}/missing.jsonl'));

        expect(await log.readAll(), isEmpty);
      },
    );
  });
}
