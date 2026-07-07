import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/wrapper/osinara_run_command.dart';
import 'package:osinara/src/wrapper/osinara_run_command_resolver.dart';

void main() {
  group('OsiRunCommand', () {
    test('builds arguments for a compiled wrapper executable', () {
      final command = OsiRunCommand.compiledExecutable(
        executable: '/workspace/osinara/build/osinara-run',
        sessionId: 'session-1',
        projectName: 'osinara',
        agentName: 'OpenCode',
        eventLogPath: '/tmp/osinara/events.jsonl',
        workingDirectory: '/workspace/osinara',
        heartbeatInterval: const Duration(seconds: 2),
        agentCommand: 'opencode',
        agentArguments: const ['--model', 'test'],
      );

      expect(command.executable, '/workspace/osinara/build/osinara-run');
      expect(command.arguments, [
        '--session-id',
        'session-1',
        '--project-name',
        'osinara',
        '--agent-name',
        'OpenCode',
        '--event-log',
        '/tmp/osinara/events.jsonl',
        '--working-directory',
        '/workspace/osinara',
        '--heartbeat-interval-ms',
        '2000',
        '--',
        'opencode',
        '--model',
        'test',
      ]);
    });
  });

  group('OsiRunCommandResolver', () {
    test('prefers the compiled wrapper executable when it exists', () async {
      final project = await Directory.systemTemp.createTemp('osinara-project-');
      addTearDown(() => project.delete(recursive: true));
      final wrapper = File('${project.path}/build/osinara-run');
      await wrapper.parent.create(recursive: true);
      await wrapper.writeAsString('');

      final command = await OsiRunCommandResolver().resolve(
        projectPath: project.path,
        sessionId: 'session-1',
        projectName: 'osinara',
        agentName: 'OpenCode',
        eventLogPath: '/tmp/osinara/events.jsonl',
        heartbeatInterval: const Duration(seconds: 2),
        agentCommand: 'opencode',
        agentArguments: const [],
        environment: const {'PATH': '/nowhere'},
      );

      expect(command.executable, wrapper.path);
      expect(command.arguments.first, '--session-id');
    });

    test('uses an absolute dart executable for dev script mode', () async {
      final project = await Directory.systemTemp.createTemp('osinara-project-');
      final tools = await Directory.systemTemp.createTemp('osinara-tools-');
      addTearDown(() => project.delete(recursive: true));
      addTearDown(() => tools.delete(recursive: true));
      final script = File('${project.path}/bin/osinara_run.dart');
      await script.parent.create(recursive: true);
      await script.writeAsString('void main() {}');
      final dart = File('${tools.path}/dart');
      await dart.writeAsString('');

      final command = await OsiRunCommandResolver().resolve(
        projectPath: project.path,
        sessionId: 'session-1',
        projectName: 'osinara',
        agentName: 'OpenCode',
        eventLogPath: '/tmp/osinara/events.jsonl',
        heartbeatInterval: const Duration(seconds: 2),
        agentCommand: 'opencode',
        agentArguments: const [],
        environment: {'PATH': tools.path},
      );

      expect(command.executable, dart.path);
      expect(command.arguments.first, script.path);
    });
  });
}
