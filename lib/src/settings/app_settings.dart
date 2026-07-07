/// Persistent user preferences for the local Osinara installation.
///
/// Key constructs:
/// - [AppSettings]: typed settings currently persisted in the app settings JSON file.
library;

import '../terminal/terminal_profile.dart';

final class AppSettings {
  const AppSettings({required this.selectedTerminalProfile});

  final TerminalProfile? selectedTerminalProfile;

  Map<String, Object?> toJson() {
    return {'selectedTerminalProfile': selectedTerminalProfile?.id};
  }

  static AppSettings fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_SETTINGS_INVALID: Не удалось загрузить настройки приложения: файл настроек имеет неверный формат.',
      );
    }

    final terminalId = json['selectedTerminalProfile'];
    if (terminalId == null) {
      return const AppSettings(selectedTerminalProfile: null);
    }

    if (terminalId is! String || terminalId.trim().isEmpty) {
      throw StateError(
        'OSI_TERMINAL_SETTING_INVALID: Не удалось загрузить настройки терминала: идентификатор терминала имеет неверный формат.',
      );
    }

    return AppSettings(
      selectedTerminalProfile: TerminalProfileInfo.fromId(terminalId),
    );
  }
}
