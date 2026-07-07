/// Runtime paths for local Osinara state that should not live in a project tree.
///
/// Key constructs:
/// - [AppPaths]: resolves state/settings files in platform-appropriate user directories.
library;

import 'dart:io';

abstract final class AppPaths {
  static File sessionEventLogFile({
    required String runId,
    Map<String, String>? environment,
  }) {
    final env = environment ?? Platform.environment;
    final stateDir = _stateDirectory(env);
    return File(_join(stateDir.path, 'session-events-$runId.jsonl'));
  }

  static File settingsFile({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    final stateDir = _stateDirectory(env);
    return File(_join(stateDir.path, 'settings.json'));
  }

  static File workspaceStateFile({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    final stateDir = _stateDirectory(env);
    return File(_join(stateDir.path, 'workspace-state.json'));
  }

  static Directory _stateDirectory(Map<String, String> environment) {
    if (Platform.isLinux) {
      final xdgStateHome = environment['XDG_STATE_HOME'];
      if (xdgStateHome != null && xdgStateHome.trim().isNotEmpty) {
        return Directory(_join(xdgStateHome, 'osinara'));
      }

      final home = _requiredHome(environment);
      return Directory(_join(home, '.local/state/osinara'));
    }

    if (Platform.isMacOS) {
      final home = _requiredHome(environment);
      return Directory(_join(home, 'Library/Application Support/Osinara'));
    }

    if (Platform.isWindows) {
      final appData = environment['APPDATA'];
      if (appData != null && appData.trim().isNotEmpty) {
        return Directory(_join(appData, 'Osinara'));
      }

      throw StateError(
        'OSI_STATE_DIR_UNAVAILABLE: Не удалось определить папку состояния приложения: переменная APPDATA не задана.',
      );
    }

    throw UnsupportedError(
      'OSI_PLATFORM_UNSUPPORTED: Не удалось определить папку состояния приложения: текущая ОС не поддерживается.',
    );
  }

  static String _requiredHome(Map<String, String> environment) {
    final home = environment['HOME'];
    if (home != null && home.trim().isNotEmpty) {
      return home;
    }

    throw StateError(
      'OSI_HOME_MISSING: Не удалось определить папку состояния приложения: переменная HOME не задана.',
    );
  }

  static String _join(String left, String right) {
    final separator = Platform.pathSeparator;
    if (left.endsWith(separator)) {
      return '$left$right';
    }

    return '$left$separator$right';
  }
}
