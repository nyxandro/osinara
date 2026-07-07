import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/wrapper/osinara_run_arguments.dart';

void main() {
  group('OsiRunArguments', () {
    test('parses required wrapper metadata and child command', () {
      final parsed = OsiRunArguments.parse([
        '--session-id',
        'session-1',
        '--project-name',
        'osinara',
        '--agent-name',
        'Claude Code',
        '--event-log',
        '/tmp/osinara/events.jsonl',
        '--working-directory',
        '/workspace/osinara',
        '--heartbeat-interval-ms',
        '5000',
        '--',
        'claude',
        '--dangerously-skip-permissions',
      ]);

      expect(parsed.sessionId, 'session-1');
      expect(parsed.projectName, 'osinara');
      expect(parsed.agentName, 'Claude Code');
      expect(parsed.eventLogPath, '/tmp/osinara/events.jsonl');
      expect(parsed.workingDirectory, '/workspace/osinara');
      expect(parsed.heartbeatInterval, const Duration(seconds: 5));
      expect(parsed.command, 'claude');
      expect(parsed.commandArguments, ['--dangerously-skip-permissions']);
    });

    test('requires a child command after separator', () {
      expect(
        () => OsiRunArguments.parse([
          '--session-id',
          'session-1',
          '--project-name',
          'osinara',
          '--agent-name',
          'Claude Code',
          '--event-log',
          '/tmp/osinara/events.jsonl',
          '--working-directory',
          '/workspace/osinara',
          '--',
        ]),
        throwsA(isA<FormatException>()),
      );
    });

    test('requires explicit wrapper metadata', () {
      expect(
        () => OsiRunArguments.parse(['--', 'claude']),
        throwsA(isA<FormatException>()),
      );
    });
  });
}
