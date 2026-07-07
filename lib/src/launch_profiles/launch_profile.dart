/// Saved command profile for one CLI agent launcher card.
library;

final class LaunchProfile {
  const LaunchProfile({
    required this.agentName,
    required this.command,
    this.arguments = const [],
  });

  final String agentName;
  final String command;
  final List<String> arguments;

  Map<String, Object?> toJson() {
    return {'agentName': agentName, 'command': command, 'arguments': arguments};
  }

  static LaunchProfile fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_LAUNCH_PROFILE_INVALID: Не удалось загрузить вкладку терминала: профиль запуска имеет неверный формат.',
      );
    }

    final agentName = _requiredString(json, 'agentName');
    final command = _requiredString(json, 'command');
    final rawArguments = json['arguments'];
    if (rawArguments is! List<Object?>) {
      throw StateError(
        'OSI_LAUNCH_PROFILE_ARGUMENTS_INVALID: Не удалось загрузить вкладку терминала: arguments имеет неверный формат.',
      );
    }

    final arguments = rawArguments
        .map((argument) {
          if (argument is String) {
            return argument;
          }

          throw StateError(
            'OSI_LAUNCH_PROFILE_ARGUMENT_INVALID: Не удалось загрузить вкладку терминала: один из arguments имеет неверный формат.',
          );
        })
        .toList(growable: false);

    return LaunchProfile(
      agentName: agentName,
      command: command,
      arguments: arguments,
    );
  }
}

String _requiredString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }

  throw StateError(
    'OSI_LAUNCH_PROFILE_FIELD_INVALID: Не удалось загрузить профиль запуска: поле $key отсутствует или имеет неверный формат.',
  );
}

const defaultLaunchProfiles = [
  LaunchProfile(agentName: 'Claude Code', command: 'claude'),
  LaunchProfile(agentName: 'OpenCode', command: 'opencode'),
  LaunchProfile(agentName: 'Codex', command: 'codex'),
];
