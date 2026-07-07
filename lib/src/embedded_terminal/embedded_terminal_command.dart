/// Builds platform shell invocations for embedded CLI terminal sessions.
///
/// Key constructs:
/// - [EmbeddedTerminalPlatform]: simplified platform family for shell selection.
/// - [EmbeddedTerminalCommand]: executable plus arguments passed to PTY.
/// - [EmbeddedTerminalCommandBuilder]: validates and quotes launch profile commands.
library;

import 'dart:io';

enum EmbeddedTerminalPlatform { linux, macos, windows }

final class EmbeddedTerminalCommand {
  const EmbeddedTerminalCommand({
    required this.executable,
    required this.arguments,
  });

  final String executable;
  final List<String> arguments;
}

final class EmbeddedTerminalCommandBuilder {
  const EmbeddedTerminalCommandBuilder({this.platform});

  final EmbeddedTerminalPlatform? platform;

  EmbeddedTerminalCommand build({
    required String command,
    required List<String> arguments,
    required Map<String, String> environment,
  }) {
    if (command.trim().isEmpty) {
      throw ArgumentError.value(
        command,
        'command',
        'OSI_EMBEDDED_TERMINAL_COMMAND_MISSING: Не удалось открыть встроенный терминал: команда профиля не указана.',
      );
    }

    return switch (platform ?? EmbeddedTerminalPlatformRuntime.current()) {
      EmbeddedTerminalPlatform.linux ||
      EmbeddedTerminalPlatform.macos => _posixCommand(
        command: command,
        arguments: arguments,
        environment: environment,
      ),
      EmbeddedTerminalPlatform.windows => _windowsCommand(
        command: command,
        arguments: arguments,
      ),
    };
  }

  EmbeddedTerminalCommand _posixCommand({
    required String command,
    required List<String> arguments,
    required Map<String, String> environment,
  }) {
    final shell = _posixShell(environment);
    final shellCommand = [
      _posixShellQuote(command),
      ...arguments.map(_posixShellQuote),
    ].join(' ');

    // A shell command gives agents the same PATH customisation users expect.
    return EmbeddedTerminalCommand(
      executable: shell,
      arguments: ['-lc', shellCommand],
    );
  }

  EmbeddedTerminalCommand _windowsCommand({
    required String command,
    required List<String> arguments,
  }) {
    return EmbeddedTerminalCommand(
      executable: 'cmd.exe',
      arguments: [
        '/c',
        [command, ...arguments].join(' '),
      ],
    );
  }
}

extension EmbeddedTerminalPlatformRuntime on EmbeddedTerminalPlatform {
  static EmbeddedTerminalPlatform current() {
    if (Platform.isLinux) {
      return EmbeddedTerminalPlatform.linux;
    }

    if (Platform.isMacOS) {
      return EmbeddedTerminalPlatform.macos;
    }

    if (Platform.isWindows) {
      return EmbeddedTerminalPlatform.windows;
    }

    throw UnsupportedError(
      'OSI_EMBEDDED_TERMINAL_PLATFORM_UNSUPPORTED: Не удалось открыть встроенный терминал: текущая ОС не поддерживается.',
    );
  }
}

String _posixShell(Map<String, String> environment) {
  final shell = environment['SHELL'];
  if (shell != null && shell.trim().isNotEmpty) {
    return shell;
  }

  return '/bin/bash';
}

String _posixShellQuote(String value) {
  if (value.isEmpty) {
    return "''";
  }

  return "'${value.replaceAll("'", "'\\''")}'";
}
