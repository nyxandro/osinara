/// Argument parser for the osinara-run process wrapper.
library;

const wrapperArgumentSeparator = '--';

final class OsiRunArguments {
  const OsiRunArguments({
    required this.sessionId,
    required this.projectName,
    required this.agentName,
    required this.eventLogPath,
    required this.workingDirectory,
    required this.heartbeatInterval,
    required this.command,
    required this.commandArguments,
  });

  final String sessionId;
  final String projectName;
  final String agentName;
  final String eventLogPath;
  final String workingDirectory;
  final Duration heartbeatInterval;
  final String command;
  final List<String> commandArguments;

  static OsiRunArguments parse(List<String> args) {
    final separatorIndex = args.indexOf(wrapperArgumentSeparator);
    if (separatorIndex < 0) {
      throw const FormatException(
        'OSI_WRAPPER_SEPARATOR_MISSING: Не удалось запустить агента: после параметров wrapper должен быть разделитель --.',
      );
    }

    final metadataArgs = args.take(separatorIndex).toList();
    final commandArgs = args.skip(separatorIndex + 1).toList();
    if (commandArgs.isEmpty || commandArgs.first.trim().isEmpty) {
      throw const FormatException(
        'OSI_AGENT_COMMAND_MISSING: Не удалось запустить агента: команда после -- не указана.',
      );
    }

    final metadata = _parseMetadata(metadataArgs);
    final heartbeatMs = _requiredPositiveInt(
      metadata,
      '--heartbeat-interval-ms',
      'OSI_HEARTBEAT_INTERVAL_MISSING',
    );

    return OsiRunArguments(
      sessionId: _required(metadata, '--session-id', 'OSI_SESSION_ID_MISSING'),
      projectName: _required(
        metadata,
        '--project-name',
        'OSI_PROJECT_NAME_MISSING',
      ),
      agentName: _required(metadata, '--agent-name', 'OSI_AGENT_NAME_MISSING'),
      eventLogPath: _required(metadata, '--event-log', 'OSI_EVENT_LOG_MISSING'),
      workingDirectory: _required(
        metadata,
        '--working-directory',
        'OSI_WORKING_DIRECTORY_MISSING',
      ),
      heartbeatInterval: Duration(milliseconds: heartbeatMs),
      command: commandArgs.first,
      commandArguments: List.unmodifiable(commandArgs.skip(1)),
    );
  }

  static Map<String, String> _parseMetadata(List<String> args) {
    final metadata = <String, String>{};

    for (var index = 0; index < args.length; index += 2) {
      final key = args[index];
      if (!key.startsWith('--')) {
        throw FormatException(
          'OSI_WRAPPER_ARGUMENT_INVALID: Не удалось запустить агента: параметр $key должен начинаться с --.',
        );
      }

      if (index + 1 >= args.length) {
        throw FormatException(
          'OSI_WRAPPER_ARGUMENT_VALUE_MISSING: Не удалось запустить агента: для параметра $key не указано значение.',
        );
      }

      metadata[key] = args[index + 1];
    }

    return metadata;
  }

  static String _required(
    Map<String, String> metadata,
    String key,
    String errorCode,
  ) {
    final value = metadata[key];
    if (value != null && value.trim().isNotEmpty) {
      return value;
    }

    throw FormatException(
      '$errorCode: Не удалось запустить агента: обязательный параметр $key не указан.',
    );
  }

  static int _requiredPositiveInt(
    Map<String, String> metadata,
    String key,
    String errorCode,
  ) {
    final value = _required(metadata, key, errorCode);
    final parsed = int.tryParse(value);
    if (parsed != null && parsed > 0) {
      return parsed;
    }

    throw FormatException(
      'OSI_WRAPPER_ARGUMENT_INVALID: Не удалось запустить агента: параметр $key должен быть положительным числом.',
    );
  }
}
