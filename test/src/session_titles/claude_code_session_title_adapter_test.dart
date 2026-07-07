import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/session_titles/claude_code_session_title_adapter.dart';
import 'package:xterm/xterm.dart';

void main() {
  group('ClaudeCodeSessionTitleAdapter', () {
    test('uses explicit metadata name when Claude provides it', () async {
      final home = await Directory.systemTemp.createTemp('osinara-claude-');
      addTearDown(() => home.delete(recursive: true));
      final adapter = const ClaudeCodeSessionTitleAdapter();
      final session = _session(processId: 4242);

      await _writeClaudeSessionMetadata(
        home: home,
        processId: 4242,
        metadata: const {
          'pid': 4242,
          'sessionId': 'session-1',
          'cwd': '/workspace/osinara',
          'name': 'Implement title sync',
          'nameSource': 'manual',
        },
      );

      final title = await adapter.readTitle(
        session: session,
        environment: {'HOME': home.path},
      );

      expect(title, 'Implement title sync');
    });

    test(
      'falls back to the latest transcript prompt for derived names',
      () async {
        final home = await Directory.systemTemp.createTemp('osinara-claude-');
        addTearDown(() => home.delete(recursive: true));
        final adapter = const ClaudeCodeSessionTitleAdapter();
        final session = _session(processId: 4243);

        await _writeClaudeSessionMetadata(
          home: home,
          processId: 4243,
          metadata: const {
            'pid': 4243,
            'sessionId': 'session-2',
            'cwd': '/workspace/osinara',
            'name': 'osinara-72',
            'nameSource': 'derived',
          },
        );
        await _writeClaudeTranscript(
          home: home,
          projectPath: '/workspace/osinara',
          sessionId: 'session-2',
          entries: const [
            {'type': 'last-prompt', 'lastPrompt': 'Как дела'},
          ],
        );

        final title = await adapter.readTitle(
          session: session,
          environment: {'HOME': home.path},
        );

        expect(title, 'Как дела');
      },
    );

    test('returns null while Claude has not written a useful title', () async {
      final home = await Directory.systemTemp.createTemp('osinara-claude-');
      addTearDown(() => home.delete(recursive: true));
      final adapter = const ClaudeCodeSessionTitleAdapter();
      final session = _session(processId: 4244);

      await _writeClaudeSessionMetadata(
        home: home,
        processId: 4244,
        metadata: const {
          'pid': 4244,
          'sessionId': 'session-3',
          'cwd': '/workspace/osinara',
          'name': 'osinara-73',
          'nameSource': 'derived',
        },
      );

      final title = await adapter.readTitle(
        session: session,
        environment: {'HOME': home.path},
      );

      expect(title, isNull);
    });

    test(
      'ignores an incomplete transcript line while Claude is writing',
      () async {
        final home = await Directory.systemTemp.createTemp('osinara-claude-');
        addTearDown(() => home.delete(recursive: true));
        final adapter = const ClaudeCodeSessionTitleAdapter();
        final session = _session(processId: 4245);

        await _writeClaudeSessionMetadata(
          home: home,
          processId: 4245,
          metadata: const {
            'pid': 4245,
            'sessionId': 'session-4',
            'cwd': '/workspace/osinara',
            'name': 'osinara-74',
            'nameSource': 'derived',
          },
        );
        await _writeClaudeTranscript(
          home: home,
          projectPath: '/workspace/osinara',
          sessionId: 'session-4',
          entries: const [
            {'type': 'last-prompt', 'lastPrompt': 'Проверь tabs'},
          ],
          rawSuffix: '\n{"type":"last-prompt","lastPrompt":"partial',
        );

        final title = await adapter.readTitle(
          session: session,
          environment: {'HOME': home.path},
        );

        expect(title, 'Проверь tabs');
      },
    );

    test('returns null while Claude metadata file is incomplete', () async {
      final home = await Directory.systemTemp.createTemp('osinara-claude-');
      addTearDown(() => home.delete(recursive: true));
      final adapter = const ClaudeCodeSessionTitleAdapter();
      final session = _session(processId: 4246);
      final sessions = Directory('${home.path}/.claude/sessions');
      await sessions.create(recursive: true);
      await File('${sessions.path}/4246.json').writeAsString('{"pid":4246');

      final title = await adapter.readTitle(
        session: session,
        environment: {'HOME': home.path},
      );

      expect(title, isNull);
    });
  });
}

EmbeddedTerminalSession _session({required int processId}) {
  return EmbeddedTerminalSession(
    id: 'terminal-$processId',
    projectName: 'osinara',
    projectPath: '/workspace/osinara',
    profile: const LaunchProfile(agentName: 'Claude Code', command: 'claude'),
    terminal: Terminal(),
    processId: processId,
    startedAt: DateTime.utc(2026, 7, 6, 12),
  );
}

Future<void> _writeClaudeSessionMetadata({
  required Directory home,
  required int processId,
  required Map<String, Object?> metadata,
}) async {
  final sessions = Directory('${home.path}/.claude/sessions');
  await sessions.create(recursive: true);
  await File(
    '${sessions.path}/$processId.json',
  ).writeAsString(jsonEncode(metadata));
}

Future<void> _writeClaudeTranscript({
  required Directory home,
  required String projectPath,
  required String sessionId,
  required List<Map<String, Object?>> entries,
  String rawSuffix = '',
}) async {
  final encodedProjectPath = projectPath.replaceAll(RegExp(r'[\\/]+'), '-');
  final projectDirectory = Directory(
    '${home.path}/.claude/projects/$encodedProjectPath',
  );
  await projectDirectory.create(recursive: true);
  final content = '${entries.map(jsonEncode).join('\n')}$rawSuffix';
  await File(
    '${projectDirectory.path}/$sessionId.jsonl',
  ).writeAsString(content);
}
