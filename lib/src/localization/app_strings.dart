/// Localized UI strings for the current app shell.
///
/// Key constructs:
/// - [AppStrings]: localized labels, descriptions, and user-facing error messages.
/// - [_AppStringsDelegate]: Flutter localization delegate for supported locales.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../agent_sessions/agent_session_snapshot.dart';
import 'app_locale.dart';

class AppStrings {
  const AppStrings(this.locale);

  final AppLocale locale;

  static const delegate = _AppStringsDelegate();

  static const supportedLocales = [Locale('en'), Locale('ru')];

  static AppStrings of(BuildContext context) {
    final strings = Localizations.of<AppStrings>(context, AppStrings);
    if (strings != null) {
      return strings;
    }

    throw StateError(
      'OSI_LOCALIZATION_MISSING: Не удалось загрузить локализацию интерфейса. Перезапустите приложение.',
    );
  }

  String get appTitle => 'Osinara';

  String get sidebarSubtitle => switch (locale) {
    AppLocale.english => 'CLI agent workspace',
    AppLocale.russian => 'Рабочая область CLI-агентов',
  };

  String get projects => switch (locale) {
    AppLocale.english => 'Projects',
    AppLocale.russian => 'Проекты',
  };

  String get filesPanel => switch (locale) {
    AppLocale.english => 'Files',
    AppLocale.russian => 'Файлы',
  };

  String get gitPanel => switch (locale) {
    AppLocale.english => 'Git',
    AppLocale.russian => 'Git',
  };

  String get centerPanel => switch (locale) {
    AppLocale.english => 'Center',
    AppLocale.russian => 'Центр',
  };

  String get projectsPanel => switch (locale) {
    AppLocale.english => 'Projects',
    AppLocale.russian => 'Проекты',
  };

  String get workspace => switch (locale) {
    AppLocale.english => 'Workspace',
    AppLocale.russian => 'Рабочая область',
  };

  String get settings => switch (locale) {
    AppLocale.english => 'Settings',
    AppLocale.russian => 'Настройки',
  };

  String get close => switch (locale) {
    AppLocale.english => 'Close',
    AppLocale.russian => 'Закрыть',
  };

  String get cancel => switch (locale) {
    AppLocale.english => 'Cancel',
    AppLocale.russian => 'Отмена',
  };

  String get copy => switch (locale) {
    AppLocale.english => 'Copy',
    AppLocale.russian => 'Скопировать',
  };

  String get minimizeWindow => switch (locale) {
    AppLocale.english => 'Minimize window',
    AppLocale.russian => 'Свернуть окно',
  };

  String get maximizeWindow => switch (locale) {
    AppLocale.english => 'Maximize window',
    AppLocale.russian => 'Развернуть окно',
  };

  String get restoreWindow => switch (locale) {
    AppLocale.english => 'Restore window',
    AppLocale.russian => 'Восстановить окно',
  };

  String get enterFullScreen => switch (locale) {
    AppLocale.english => 'Enter full screen',
    AppLocale.russian => 'Во весь экран',
  };

  String get exitFullScreen => switch (locale) {
    AppLocale.english => 'Exit full screen',
    AppLocale.russian => 'Выйти из полноэкранного режима',
  };

  String get closeWindow => switch (locale) {
    AppLocale.english => 'Close window',
    AppLocale.russian => 'Закрыть окно',
  };

  String get addProject => switch (locale) {
    AppLocale.english => 'Add project',
    AppLocale.russian => 'Добавить проект',
  };

  String get searchRemoteProjects => switch (locale) {
    AppLocale.english => 'Search remote projects...',
    AppLocale.russian => 'Поиск удалённых проектов...',
  };

  String get connectSshServer => switch (locale) {
    AppLocale.english => 'Connect SSH Server',
    AppLocale.russian => 'Подключить SSH-сервер',
  };

  String get addWslDistro => switch (locale) {
    AppLocale.english => 'Add WSL Distro',
    AppLocale.russian => 'Добавить WSL-дистрибутив',
  };

  String get openFolder => switch (locale) {
    AppLocale.english => 'Open Folder',
    AppLocale.russian => 'Открыть папку',
  };

  String get viewServerOptions => switch (locale) {
    AppLocale.english => 'View Server Options',
    AppLocale.russian => 'Параметры сервера',
  };

  String get sshServerHost => switch (locale) {
    AppLocale.english => 'SSH server, for example user@example.com',
    AppLocale.russian => 'SSH-сервер, например user@example.com',
  };

  String get wslDistroName => switch (locale) {
    AppLocale.english => 'WSL distro name, for example Ubuntu',
    AppLocale.russian => 'Имя WSL-дистрибутива, например Ubuntu',
  };

  String get projectFolderPath => switch (locale) {
    AppLocale.english => 'Project folder path',
    AppLocale.russian => 'Путь к папке проекта',
  };

  String get projectSettings => switch (locale) {
    AppLocale.english => 'Project settings',
    AppLocale.russian => 'Настройки проекта',
  };

  String get projectName => switch (locale) {
    AppLocale.english => 'Project name',
    AppLocale.russian => 'Название проекта',
  };

  String get projectIcon => switch (locale) {
    AppLocale.english => 'Project icon',
    AppLocale.russian => 'Иконка проекта',
  };

  String get removeProject => switch (locale) {
    AppLocale.english => 'Remove from list',
    AppLocale.russian => 'Удалить из списка',
  };

  String get saveProject => switch (locale) {
    AppLocale.english => 'Save project',
    AppLocale.russian => 'Сохранить проект',
  };

  String get removeProjectDescription => switch (locale) {
    AppLocale.english =>
      'Removing a project only deletes it from Osinara. Files on disk or remote servers are not touched.',
    AppLocale.russian =>
      'Удаление проекта убирает его только из списка Osinara. Файлы на диске или удалённых серверах не трогаются.',
  };

  String get select => switch (locale) {
    AppLocale.english => 'Select',
    AppLocale.russian => 'Выбрать',
  };

  String get launchProfiles => switch (locale) {
    AppLocale.english => 'Launch profiles',
    AppLocale.russian => 'Профили запуска',
  };

  String get launchProfilesDescription => switch (locale) {
    AppLocale.english =>
      'Saved commands open as embedded terminal tabs inside the selected project.',
    AppLocale.russian =>
      'Сохранённые команды открываются как вкладки встроенного терминала внутри выбранного проекта.',
  };

  String get terminal => switch (locale) {
    AppLocale.english => 'Terminal',
    AppLocale.russian => 'Терминал',
  };

  String get launch => switch (locale) {
    AppLocale.english => 'Launch',
    AppLocale.russian => 'Запустить',
  };

  String get launcherTab => switch (locale) {
    AppLocale.english => 'Launcher',
    AppLocale.russian => 'Запуск',
  };

  String get newTerminalTab => switch (locale) {
    AppLocale.english => 'New tab',
    AppLocale.russian => 'Новая вкладка',
  };

  String get newSession => switch (locale) {
    AppLocale.english => 'New session',
    AppLocale.russian => 'Новая сессия',
  };

  String get closeTerminal => switch (locale) {
    AppLocale.english => 'Close terminal',
    AppLocale.russian => 'Закрыть терминал',
  };

  String get fileTree => switch (locale) {
    AppLocale.english => 'File tree',
    AppLocale.russian => 'Дерево файлов',
  };

  String get gitNotRepository => switch (locale) {
    AppLocale.english => 'Not a Git repository',
    AppLocale.russian => 'Это не Git-репозиторий',
  };

  String get gitCleanTree => switch (locale) {
    AppLocale.english => 'No changes',
    AppLocale.russian => 'Нет изменений',
  };

  String get gitDetachedHead => switch (locale) {
    AppLocale.english => 'Detached HEAD',
    AppLocale.russian => 'Detached HEAD',
  };

  String get gitStatusFailed => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_STATUS_FAILED: Не удалось прочитать состояние Git. Проверьте, что Git установлен и проект доступен.',
    AppLocale.russian =>
      'OSI_GIT_STATUS_FAILED: Не удалось прочитать состояние Git. Проверьте, что Git установлен и проект доступен.',
  };

  String get gitInitializeRepository => switch (locale) {
    AppLocale.english => 'Initialize repository',
    AppLocale.russian => 'Инициализировать репозиторий',
  };

  String get gitInitializeFailed => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_INIT_FAILED: Не удалось инициализировать Git-репозиторий. Проверьте, что Git установлен и папка проекта доступна для записи.',
    AppLocale.russian =>
      'OSI_GIT_INIT_FAILED: Не удалось инициализировать Git-репозиторий. Проверьте, что Git установлен и папка проекта доступна для записи.',
  };

  String get interfaceSettings => switch (locale) {
    AppLocale.english => 'Interface preferences',
    AppLocale.russian => 'Параметры интерфейса',
  };

  String get settingsDescription => switch (locale) {
    AppLocale.english =>
      'Configure how Osinara looks and behaves on this computer.',
    AppLocale.russian =>
      'Настройте внешний вид и поведение Osinara на этом компьютере.',
  };

  String get language => switch (locale) {
    AppLocale.english => 'Language',
    AppLocale.russian => 'Язык интерфейса',
  };

  String get languageDescription => switch (locale) {
    AppLocale.english => 'Choose the language used by the app interface.',
    AppLocale.russian =>
      'Выберите язык, на котором отображается интерфейс приложения.',
  };

  String get theme => switch (locale) {
    AppLocale.english => 'Theme',
    AppLocale.russian => 'Тема',
  };

  String get themeDescription => switch (locale) {
    AppLocale.english => 'Choose the color theme used by all app panels.',
    AppLocale.russian => 'Выберите цветовую тему для всех панелей приложения.',
  };

  String get english => switch (locale) {
    AppLocale.english => 'English',
    AppLocale.russian => 'English',
  };

  String get russian => 'Русский';

  String get projectPathLabel => switch (locale) {
    AppLocale.english => 'Project',
    AppLocale.russian => 'Проект',
  };

  String get processIdLabel => switch (locale) {
    AppLocale.english => 'PID',
    AppLocale.russian => 'PID',
  };

  String get notAvailable => switch (locale) {
    AppLocale.english => 'not available',
    AppLocale.russian => 'нет данных',
  };

  String embeddedLaunchFailedMessage() => switch (locale) {
    AppLocale.english =>
      'OSI_EMBEDDED_TERMINAL_LAUNCH_FAILED: Не удалось открыть встроенный терминал для агента. Проверьте, что команда агента установлена и доступна в PATH.',
    AppLocale.russian =>
      'OSI_EMBEDDED_TERMINAL_LAUNCH_FAILED: Не удалось открыть встроенный терминал для агента. Проверьте, что команда агента установлена и доступна в PATH.',
  };

  String sessionStateLabel(AgentSessionState state) {
    return switch (state) {
      AgentSessionState.running => switch (locale) {
        AppLocale.english => 'Running',
        AppLocale.russian => 'Запущен',
      },
      AgentSessionState.working => switch (locale) {
        AppLocale.english => 'Working',
        AppLocale.russian => 'Работает',
      },
      AgentSessionState.waitingForUser => switch (locale) {
        AppLocale.english => 'Needs input',
        AppLocale.russian => 'Ждёт ввода',
      },
      AgentSessionState.permissionRequired => switch (locale) {
        AppLocale.english => 'Permission',
        AppLocale.russian => 'Нужно разрешение',
      },
      AgentSessionState.finished => switch (locale) {
        AppLocale.english => 'Finished',
        AppLocale.russian => 'Завершён',
      },
      AgentSessionState.failed => switch (locale) {
        AppLocale.english => 'Failed',
        AppLocale.russian => 'Ошибка',
      },
      AgentSessionState.lost => switch (locale) {
        AppLocale.english => 'Lost',
        AppLocale.russian => 'Потерян',
      },
    };
  }
}

class _AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const _AppStringsDelegate();

  @override
  bool isSupported(Locale locale) {
    return AppLocale.values.any(
      (appLocale) => appLocale.locale.languageCode == locale.languageCode,
    );
  }

  @override
  Future<AppStrings> load(Locale locale) {
    return SynchronousFuture(AppStrings(AppLocale.fromLocale(locale)));
  }

  @override
  bool shouldReload(_AppStringsDelegate old) => false;
}
