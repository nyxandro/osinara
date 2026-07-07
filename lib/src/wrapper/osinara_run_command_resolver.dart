/// Resolves the best available osinara-run invocation for the current project.
///
/// Key constructs:
/// - [OsiRunCommandResolver]: picks compiled wrapper when present, otherwise dev Dart script.
library;

import 'dart:io';

import 'osinara_run_command.dart';

const _compiledWrapperRelativePath = 'build/osinara-run';
const _scriptWrapperRelativePath = 'bin/osinara_run.dart';
const _pathSeparator = ':';
const _dartExecutableName = 'dart';

final class OsiRunCommandResolver {
  const OsiRunCommandResolver();

  Future<OsiRunCommand> resolve({
    required String projectPath,
    required String sessionId,
    required String projectName,
    required String agentName,
    required String eventLogPath,
    required Duration heartbeatInterval,
    required String agentCommand,
    required List<String> agentArguments,
    required Map<String, String> environment,
  }) async {
    final compiledWrapper = File(
      _joinPath(projectPath, _compiledWrapperRelativePath),
    );
    if (await compiledWrapper.exists()) {
      return OsiRunCommand.compiledExecutable(
        executable: compiledWrapper.path,
        sessionId: sessionId,
        projectName: projectName,
        agentName: agentName,
        eventLogPath: eventLogPath,
        workingDirectory: projectPath,
        heartbeatInterval: heartbeatInterval,
        agentCommand: agentCommand,
        agentArguments: agentArguments,
      );
    }

    final wrapperScript = File(
      _joinPath(projectPath, _scriptWrapperRelativePath),
    );
    if (!await wrapperScript.exists()) {
      throw StateError(
        'OSI_WRAPPER_NOT_FOUND: Не удалось запустить агента: не найден ни build/osinara-run, ни bin/osinara_run.dart. Соберите wrapper или проверьте папку проекта.',
      );
    }

    final dartExecutable = _findExecutableOnPath(
      executable: _dartExecutableName,
      environment: environment,
    );
    if (dartExecutable == null) {
      throw StateError(
        'OSI_DART_EXECUTABLE_NOT_FOUND: Не удалось запустить агента в dev-режиме: dart не найден в PATH. Соберите build/osinara-run или установите Dart SDK.',
      );
    }

    return OsiRunCommand.dartScript(
      dartExecutable: dartExecutable,
      scriptPath: wrapperScript.path,
      sessionId: sessionId,
      projectName: projectName,
      agentName: agentName,
      eventLogPath: eventLogPath,
      workingDirectory: projectPath,
      heartbeatInterval: heartbeatInterval,
      agentCommand: agentCommand,
      agentArguments: agentArguments,
    );
  }
}

String? _findExecutableOnPath({
  required String executable,
  required Map<String, String> environment,
}) {
  final pathValue = environment['PATH'];
  if (pathValue == null || pathValue.trim().isEmpty) {
    return null;
  }

  for (final directory in pathValue.split(_pathSeparator)) {
    if (directory.trim().isEmpty) {
      continue;
    }

    final candidate = File(_joinPath(directory, executable));
    if (candidate.existsSync()) {
      return candidate.path;
    }
  }

  return null;
}

String _joinPath(String left, String right) {
  if (left.endsWith(Platform.pathSeparator)) {
    return '$left$right';
  }

  return '$left${Platform.pathSeparator}$right';
}
