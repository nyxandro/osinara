/// Builds and starts external terminal processes for agent launch requests.
library;

import 'dart:io';

import '../wrapper/osinara_run_command.dart';
import 'launch_request.dart';
import 'terminal_profile.dart';

final class TerminalCommand {
  const TerminalCommand({
    required this.executable,
    required this.arguments,
    required this.workingDirectory,
  });

  final String executable;
  final List<String> arguments;
  final String workingDirectory;
}

final class TerminalCommandBuilder {
  const TerminalCommandBuilder({this.platform});

  final LaunchPlatform? platform;

  TerminalCommand build(TerminalLaunchRequest request) {
    final effectivePlatform = platform ?? request.terminalProfile.platform;
    if (request.terminalProfile.platform != effectivePlatform) {
      throw StateError(
        'OSI_TERMINAL_PLATFORM_MISMATCH: Не удалось запустить терминал: профиль ${request.terminalProfile.label} не подходит для текущей ОС.',
      );
    }

    return switch (request.terminalProfile) {
      TerminalProfile.gnomeTerminal => _gnomeTerminal(request),
      TerminalProfile.kitty => _kitty(request),
      TerminalProfile.konsole => _konsole(request),
      TerminalProfile.xterm => _xterm(request),
      TerminalProfile.wslWindowsTerminal => _wslWindowsTerminal(request),
      TerminalProfile.macosTerminal => _macosTerminal(request),
      TerminalProfile.windowsTerminal => _windowsTerminal(request),
    };
  }

  TerminalCommand _gnomeTerminal(TerminalLaunchRequest request) {
    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '--working-directory=${request.projectPath}',
        '--',
        request.wrapperCommand.executable,
        ...request.wrapperCommand.arguments,
      ],
    );
  }

  TerminalCommand _kitty(TerminalLaunchRequest request) {
    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '--directory',
        request.projectPath,
        request.wrapperCommand.executable,
        ...request.wrapperCommand.arguments,
      ],
    );
  }

  TerminalCommand _konsole(TerminalLaunchRequest request) {
    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '--workdir',
        request.projectPath,
        '-e',
        request.wrapperCommand.executable,
        ...request.wrapperCommand.arguments,
      ],
    );
  }

  TerminalCommand _xterm(TerminalLaunchRequest request) {
    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '-e',
        request.wrapperCommand.executable,
        ...request.wrapperCommand.arguments,
      ],
    );
  }

  TerminalCommand _windowsTerminal(TerminalLaunchRequest request) {
    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '-d',
        request.projectPath,
        request.wrapperCommand.executable,
        ...request.wrapperCommand.arguments,
      ],
    );
  }

  TerminalCommand _wslWindowsTerminal(TerminalLaunchRequest request) {
    final distroName = request.environment['WSL_DISTRO_NAME'];
    if (distroName == null || distroName.trim().isEmpty) {
      throw StateError(
        'OSI_WSL_DISTRO_MISSING: Не удалось запустить Windows Terminal: имя WSL-дистрибутива не найдено. Перезапустите приложение из WSL.',
      );
    }

    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        'new-tab',
        'wsl.exe',
        '--distribution',
        distroName,
        '--cd',
        request.projectPath,
        '--exec',
        'bash',
        '-lc',
        _shellCommand(request.wrapperCommand),
      ],
    );
  }

  TerminalCommand _macosTerminal(TerminalLaunchRequest request) {
    final shellCommand = [
      'cd',
      _posixShellQuote(request.projectPath),
      '&&',
      _posixShellQuote(request.wrapperCommand.executable),
      ...request.wrapperCommand.arguments.map(_posixShellQuote),
    ].join(' ');

    return TerminalCommand(
      executable: request.terminalProfile.executable,
      workingDirectory: request.projectPath,
      arguments: [
        '-e',
        'tell application "Terminal" to do script ${_appleScriptString(shellCommand)}',
      ],
    );
  }
}

final class TerminalLauncher {
  TerminalLauncher({TerminalCommandBuilder? builder})
    : _builder =
          builder ??
          TerminalCommandBuilder(platform: LaunchPlatformRuntime.current());

  final TerminalCommandBuilder _builder;

  Future<int> launch(TerminalLaunchRequest request) async {
    final projectDirectory = Directory(request.projectPath);
    if (!await projectDirectory.exists()) {
      throw StateError(
        'OSI_PROJECT_PATH_NOT_FOUND: Не удалось запустить агента: папка проекта не найдена. Проверьте путь к проекту.',
      );
    }

    final command = _builder.build(request);
    final process = await Process.start(
      command.executable,
      command.arguments,
      workingDirectory: command.workingDirectory,
      environment: request.environment,
      mode: ProcessStartMode.detached,
    );

    return process.pid;
  }
}

String _posixShellQuote(String value) {
  if (value.isEmpty) {
    return "''";
  }

  return "'${value.replaceAll("'", "'\\''")}'";
}

String _shellCommand(OsiRunCommand command) {
  return [
    _posixShellQuote(command.executable),
    ...command.arguments.map(_posixShellQuote),
  ].join(' ');
}

String _appleScriptString(String value) {
  return '"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"';
}
