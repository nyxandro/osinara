/// External browser opener used by Git authentication flows.
///
/// Key constructs:
/// - [BrowserLauncher]: abstraction for opening verification URLs.
/// - [ProcessBrowserLauncher]: production opener with WSL/Linux command candidates.
/// - [BrowserProcessRunner], [BrowserProcessResult]: testable process boundary.
library;

import 'dart:io';

abstract interface class BrowserLauncher {
  Future<void> open(String url);
}

abstract interface class BrowserProcessRunner {
  Future<BrowserProcessResult> run(String executable, List<String> arguments);
}

final class BrowserProcessResult {
  const BrowserProcessResult({required this.exitCode, required this.stderr});

  final int exitCode;
  final String stderr;
}

final class ProcessBrowserRunner implements BrowserProcessRunner {
  const ProcessBrowserRunner();

  @override
  Future<BrowserProcessResult> run(
    String executable,
    List<String> arguments,
  ) async {
    final result = await Process.run(executable, arguments, runInShell: false);
    return BrowserProcessResult(
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
    );
  }
}

final class ProcessBrowserLauncher implements BrowserLauncher {
  const ProcessBrowserLauncher({
    this.runner = const ProcessBrowserRunner(),
    required this.environment,
  });

  final BrowserProcessRunner runner;
  final Map<String, String> environment;

  @override
  Future<void> open(String url) async {
    _validateUrl(url);
    final failures = <String>[];

    for (final command in _browserOpenCommands(url)) {
      try {
        final result = await runner.run(command.executable, command.arguments);
        if (result.exitCode == 0 || command.detachedExitCodeIsUnreliable) {
          return;
        }
        failures.add(
          '${command.executable} exited with ${result.exitCode}: ${result.stderr.trim()}',
        );
      } on Object catch (error) {
        failures.add('${command.executable} failed: $error');
      }
    }

    throw StateError(
      'OSI_BROWSER_OPEN_FAILED: Не удалось открыть браузер автоматически. Откройте ссылку вручную: $url. Попытки запуска: ${failures.join(' | ')}',
    );
  }

  List<_BrowserOpenCommand> _browserOpenCommands(String url) {
    if (_isWslEnvironment(environment)) {
      return [
        _BrowserOpenCommand('explorer.exe', [
          url,
        ], detachedExitCodeIsUnreliable: true),
        _BrowserOpenCommand('cmd.exe', [
          '/c',
          'start',
          '',
          url,
        ], detachedExitCodeIsUnreliable: true),
        _BrowserOpenCommand('powershell.exe', [
          '-NoProfile',
          '-Command',
          'Start-Process',
          url,
        ], detachedExitCodeIsUnreliable: true),
        _BrowserOpenCommand('wslview', [url]),
        _BrowserOpenCommand('xdg-open', [url]),
      ];
    }
    if (Platform.isWindows) {
      return [
        _BrowserOpenCommand('cmd.exe', ['/c', 'start', '', url]),
      ];
    }
    if (Platform.isMacOS) {
      return [
        _BrowserOpenCommand('open', [url]),
      ];
    }

    return [
      _BrowserOpenCommand('xdg-open', [url]),
    ];
  }
}

final class _BrowserOpenCommand {
  const _BrowserOpenCommand(
    this.executable,
    this.arguments, {
    this.detachedExitCodeIsUnreliable = false,
  });

  final String executable;
  final List<String> arguments;
  final bool detachedExitCodeIsUnreliable;
}

bool _isWslEnvironment(Map<String, String> environment) {
  return environment.containsKey('WSL_DISTRO_NAME') ||
      environment.containsKey('WSL_INTEROP');
}

void _validateUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || !uri.hasScheme || uri.host.trim().isEmpty) {
    throw ArgumentError.value(
      url,
      'url',
      'OSI_BROWSER_URL_INVALID: Не удалось открыть браузер: ссылка авторизации имеет неверный формат.',
    );
  }
}
