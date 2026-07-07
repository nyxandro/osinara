import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/terminal/launch_request.dart';
import 'package:osinara/src/terminal/terminal_launcher.dart';
import 'package:osinara/src/terminal/terminal_profile.dart';
import 'package:osinara/src/wrapper/osinara_run_command.dart';

void main() {
  group('TerminalCommandBuilder', () {
    test(
      'builds a gnome-terminal command with explicit cwd and wrapper args',
      () {
        final request = _request(
          terminalProfile: TerminalProfile.gnomeTerminal,
          wrapperCommand: const OsiRunCommand(
            executable: '/usr/bin/osinara-run',
            arguments: ['--session-id', 'session-1', '--', 'claude'],
          ),
        );

        final command = TerminalCommandBuilder().build(request);

        expect(command.executable, 'gnome-terminal');
        expect(command.workingDirectory, '/workspace/osinara');
        expect(command.arguments, [
          '--working-directory=/workspace/osinara',
          '--',
          '/usr/bin/osinara-run',
          '--session-id',
          'session-1',
          '--',
          'claude',
        ]);
      },
    );

    test('builds a Windows Terminal command with explicit project path', () {
      final request = _request(
        terminalProfile: TerminalProfile.windowsTerminal,
        projectPath: r'C:\workspace\osinara',
        wrapperCommand: const OsiRunCommand(
          executable: r'C:\tools\osinara-run.exe',
          arguments: ['--session-id', 'session-1', '--', 'claude'],
        ),
      );

      final command = TerminalCommandBuilder().build(request);

      expect(command.executable, 'wt.exe');
      expect(command.workingDirectory, r'C:\workspace\osinara');
      expect(command.arguments, [
        '-d',
        r'C:\workspace\osinara',
        r'C:\tools\osinara-run.exe',
        '--session-id',
        'session-1',
        '--',
        'claude',
      ]);
    });

    test('builds a WSL Windows Terminal command for the active distro', () {
      final request = _request(
        terminalProfile: TerminalProfile.wslWindowsTerminal,
        environment: const {'WSL_DISTRO_NAME': 'Ubuntu'},
        wrapperCommand: const OsiRunCommand(
          executable: 'dart',
          arguments: [
            '/workspace/osinara/bin/osinara_run.dart',
            '--session-id',
            'session-1',
            '--',
            'claude',
          ],
        ),
      );

      final command = TerminalCommandBuilder().build(request);

      expect(command.executable, 'wt.exe');
      expect(command.workingDirectory, '/workspace/osinara');
      expect(command.arguments, [
        'new-tab',
        'wsl.exe',
        '--distribution',
        'Ubuntu',
        '--cd',
        '/workspace/osinara',
        '--exec',
        'bash',
        '-lc',
        "'dart' '/workspace/osinara/bin/osinara_run.dart' '--session-id' 'session-1' '--' 'claude'",
      ]);
    });

    test('rejects a terminal profile for a different platform', () {
      final request = _request(
        terminalProfile: TerminalProfile.windowsTerminal,
      );

      expect(
        () => TerminalCommandBuilder(
          platform: LaunchPlatform.linux,
        ).build(request),
        throwsA(isA<StateError>()),
      );
    });
  });
}

TerminalLaunchRequest _request({
  required TerminalProfile terminalProfile,
  String projectPath = '/workspace/osinara',
  OsiRunCommand wrapperCommand = const OsiRunCommand(
    executable: '/usr/bin/osinara-run',
    arguments: ['--session-id', 'session-1', '--', 'opencode'],
  ),
  Map<String, String>? environment,
}) {
  return TerminalLaunchRequest(
    sessionId: 'session-1',
    projectName: 'osinara',
    agentName: 'OpenCode',
    projectPath: projectPath,
    terminalProfile: terminalProfile,
    wrapperCommand: wrapperCommand,
    environment: environment ?? Platform.environment,
  );
}
