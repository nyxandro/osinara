/// Immutable launch request for opening an external terminal with osinara-run.
library;

import '../wrapper/osinara_run_command.dart';
import 'terminal_profile.dart';

final class TerminalLaunchRequest {
  TerminalLaunchRequest({
    required this.sessionId,
    required this.projectName,
    required this.agentName,
    required this.projectPath,
    required this.terminalProfile,
    required this.wrapperCommand,
    required this.environment,
  }) {
    _requireText(sessionId, 'sessionId', 'OSI_SESSION_ID_MISSING');
    _requireText(projectName, 'projectName', 'OSI_PROJECT_NAME_MISSING');
    _requireText(agentName, 'agentName', 'OSI_AGENT_NAME_MISSING');
    _requireText(projectPath, 'projectPath', 'OSI_PROJECT_PATH_MISSING');
  }

  final String sessionId;
  final String projectName;
  final String agentName;
  final String projectPath;
  final TerminalProfile terminalProfile;
  final OsiRunCommand wrapperCommand;
  final Map<String, String> environment;
}

void _requireText(String value, String fieldName, String errorCode) {
  if (value.trim().isNotEmpty) {
    return;
  }

  throw ArgumentError.value(
    value,
    fieldName,
    '$errorCode: Не удалось собрать запуск терминала: поле $fieldName не заполнено.',
  );
}
