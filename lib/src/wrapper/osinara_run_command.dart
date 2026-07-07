/// Command line builder for invoking the osinara-run wrapper from a terminal.
///
/// Key constructs:
/// - [OsiRunCommand]: executable plus arguments for wrapper invocation.
/// - [OsiRunCommand.dartScript]: development invocation through a Dart SDK executable.
/// - [OsiRunCommand.compiledExecutable]: production invocation through compiled wrapper binary.
library;

import 'osinara_run_arguments.dart';

final class OsiRunCommand {
  const OsiRunCommand({required this.executable, required this.arguments});

  final String executable;
  final List<String> arguments;

  factory OsiRunCommand.dartScript({
    required String dartExecutable,
    required String scriptPath,
    required String sessionId,
    required String projectName,
    required String agentName,
    required String eventLogPath,
    required String workingDirectory,
    required Duration heartbeatInterval,
    required String agentCommand,
    required List<String> agentArguments,
  }) {
    _requireText(
      dartExecutable,
      'dartExecutable',
      'OSI_DART_EXECUTABLE_MISSING',
    );
    _requireText(scriptPath, 'scriptPath', 'OSI_WRAPPER_SCRIPT_MISSING');
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(projectName, 'projectName', 'OSI_PROJECT_NAME_MISSING');
    _requireText(agentName, 'agentName', 'OSI_AGENT_NAME_MISSING');
    _requireText(eventLogPath, 'eventLogPath', 'OSI_EVENT_LOG_MISSING');
    _requireText(
      workingDirectory,
      'workingDirectory',
      'OSI_WORKING_DIRECTORY_MISSING',
    );
    _requireText(agentCommand, 'agentCommand', 'OSI_AGENT_COMMAND_MISSING');

    if (heartbeatInterval.inMilliseconds <= 0) {
      throw ArgumentError.value(
        heartbeatInterval,
        'heartbeatInterval',
        'OSI_HEARTBEAT_INTERVAL_INVALID: Не удалось запустить агента: интервал heartbeat должен быть больше нуля.',
      );
    }

    return OsiRunCommand(
      executable: dartExecutable,
      arguments: [
        scriptPath,
        ..._wrapperArguments(
          sessionId: sessionId,
          projectName: projectName,
          agentName: agentName,
          eventLogPath: eventLogPath,
          workingDirectory: workingDirectory,
          heartbeatInterval: heartbeatInterval,
          agentCommand: agentCommand,
          agentArguments: agentArguments,
        ),
      ],
    );
  }

  factory OsiRunCommand.compiledExecutable({
    required String executable,
    required String sessionId,
    required String projectName,
    required String agentName,
    required String eventLogPath,
    required String workingDirectory,
    required Duration heartbeatInterval,
    required String agentCommand,
    required List<String> agentArguments,
  }) {
    _requireText(executable, 'executable', 'OSI_WRAPPER_EXECUTABLE_MISSING');
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(projectName, 'projectName', 'OSI_PROJECT_NAME_MISSING');
    _requireText(agentName, 'agentName', 'OSI_AGENT_NAME_MISSING');
    _requireText(eventLogPath, 'eventLogPath', 'OSI_EVENT_LOG_MISSING');
    _requireText(
      workingDirectory,
      'workingDirectory',
      'OSI_WORKING_DIRECTORY_MISSING',
    );
    _requireText(agentCommand, 'agentCommand', 'OSI_AGENT_COMMAND_MISSING');

    return OsiRunCommand(
      executable: executable,
      arguments: _wrapperArguments(
        sessionId: sessionId,
        projectName: projectName,
        agentName: agentName,
        eventLogPath: eventLogPath,
        workingDirectory: workingDirectory,
        heartbeatInterval: heartbeatInterval,
        agentCommand: agentCommand,
        agentArguments: agentArguments,
      ),
    );
  }
}

List<String> _wrapperArguments({
  required String sessionId,
  required String projectName,
  required String agentName,
  required String eventLogPath,
  required String workingDirectory,
  required Duration heartbeatInterval,
  required String agentCommand,
  required List<String> agentArguments,
}) {
  if (heartbeatInterval.inMilliseconds <= 0) {
    throw ArgumentError.value(
      heartbeatInterval,
      'heartbeatInterval',
      'OSI_HEARTBEAT_INTERVAL_INVALID: Не удалось запустить агента: интервал heartbeat должен быть больше нуля.',
    );
  }

  return [
    '--session-id',
    sessionId,
    '--project-name',
    projectName,
    '--agent-name',
    agentName,
    '--event-log',
    eventLogPath,
    '--working-directory',
    workingDirectory,
    '--heartbeat-interval-ms',
    heartbeatInterval.inMilliseconds.toString(),
    wrapperArgumentSeparator,
    agentCommand,
    ...agentArguments,
  ];
}

void _requireText(String value, String fieldName, String errorCode) {
  if (value.trim().isNotEmpty) {
    return;
  }

  throw ArgumentError.value(
    value,
    fieldName,
    '$errorCode: Не удалось собрать команду запуска агента: поле $fieldName не заполнено.',
  );
}
