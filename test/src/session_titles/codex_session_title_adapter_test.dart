import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/session_titles/codex_session_title_adapter.dart';
import 'package:xterm/xterm.dart';

void main() {
  group('CodexSessionTitleAdapter', () {
    test('reads the first Codex user message as a session title', () async {
      final home = await Directory.systemTemp.createTemp('osinara-codex-');
      addTearDown(() => home.delete(recursive: true));
      final adapter = const CodexSessionTitleAdapter();
      final session = _session();

      await _writeCodexTranscript(
        home: home,
        fileName: 'rollout-2026-07-06T12-00-00-session.jsonl',
        entries: [
          _sessionMeta(
            cwd: '/workspace/osinara',
            timestamp: '2026-07-06T12:00:05.000Z',
          ),
          _userMessage('Сделай Projects panel'),
        ],
      );

      final title = await adapter.readTitle(
        session: session,
        environment: {'HOME': home.path},
      );

      expect(title, 'Сделай Projects panel');
    });

    test('ignores Codex sessions from another cwd', () async {
      final home = await Directory.systemTemp.createTemp('osinara-codex-');
      addTearDown(() => home.delete(recursive: true));
      final adapter = const CodexSessionTitleAdapter();
      final session = _session();

      await _writeCodexTranscript(
        home: home,
        fileName: 'rollout-2026-07-06T12-00-00-session.jsonl',
        entries: [
          _sessionMeta(
            cwd: '/workspace/other',
            timestamp: '2026-07-06T12:00:05.000Z',
          ),
          _userMessage('Wrong project'),
        ],
      );

      final title = await adapter.readTitle(
        session: session,
        environment: {'HOME': home.path},
      );

      expect(title, isNull);
    });
  });
}

EmbeddedTerminalSession _session() {
  return EmbeddedTerminalSession(
    id: 'terminal-codex',
    projectName: 'osinara',
    projectPath: '/workspace/osinara',
    profile: const LaunchProfile(agentName: 'Codex', command: 'codex'),
    terminal: Terminal(),
    startedAt: DateTime.utc(2026, 7, 6, 12),
  );
}

Map<String, Object?> _sessionMeta({
  required String cwd,
  required String timestamp,
}) {
  return {
    'timestamp': timestamp,
    'type': 'session_meta',
    'payload': {'cwd': cwd, 'timestamp': timestamp},
  };
}

Map<String, Object?> _userMessage(String message) {
  return {
    'timestamp': '2026-07-06T12:00:06.000Z',
    'type': 'event_msg',
    'payload': {'type': 'user_message', 'message': message},
  };
}

Future<void> _writeCodexTranscript({
  required Directory home,
  required String fileName,
  required List<Map<String, Object?>> entries,
}) async {
  final sessionsDirectory = Directory(
    '${home.path}/.codex/sessions/2026/07/06',
  );
  await sessionsDirectory.create(recursive: true);
  final content = entries.map(jsonEncode).join('\n');
  await File('${sessionsDirectory.path}/$fileName').writeAsString(content);
}
