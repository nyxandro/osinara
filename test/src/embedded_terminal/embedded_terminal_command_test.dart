import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_command.dart';

void main() {
  group('EmbeddedTerminalCommandBuilder', () {
    test('builds a POSIX shell command with quoted profile arguments', () {
      final command =
          EmbeddedTerminalCommandBuilder(
            platform: EmbeddedTerminalPlatform.linux,
          ).build(
            command: 'opencode',
            arguments: const ['--model', "openai/gpt-5.5", "quote'value"],
            environment: const {'SHELL': '/bin/bash'},
          );

      expect(command.executable, '/bin/bash');
      expect(command.arguments, [
        '-lc',
        "'opencode' '--model' 'openai/gpt-5.5' 'quote'\\''value'",
      ]);
    });

    test('uses cmd on Windows', () {
      final command =
          EmbeddedTerminalCommandBuilder(
            platform: EmbeddedTerminalPlatform.windows,
          ).build(
            command: 'codex',
            arguments: const ['--full-auto'],
            environment: const {},
          );

      expect(command.executable, 'cmd.exe');
      expect(command.arguments, ['/c', 'codex --full-auto']);
    });

    test('rejects a missing command', () {
      expect(
        () =>
            EmbeddedTerminalCommandBuilder(
              platform: EmbeddedTerminalPlatform.linux,
            ).build(
              command: ' ',
              arguments: const [],
              environment: Platform.environment,
            ),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
