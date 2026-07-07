/// Localized Git authentication strings.
///
/// Key constructs:
/// - [GitAuthAppStrings]: extension with settings and dialog text for provider CLI auth.
library;

import '../git/git_auth_flow.dart';
import 'app_locale.dart';
import 'app_strings.dart';

extension GitAuthAppStrings on AppStrings {
  String get gitAuthentication => switch (locale) {
    AppLocale.english => 'Git authentication',
    AppLocale.russian => 'Авторизация Git',
  };

  String get gitAuthenticationDescription => switch (locale) {
    AppLocale.english =>
      'Osinara uses the same credentials as Git in your shell: SSH keys, Git Credential Manager, GitHub CLI or GitLab CLI. Tokens are not stored inside Osinara.',
    AppLocale.russian =>
      'Osinara использует те же доступы, что и Git в терминале: SSH-ключи, Git Credential Manager, GitHub CLI или GitLab CLI. Токены внутри Osinara не сохраняются.',
  };

  String get gitProviderHint => switch (locale) {
    AppLocale.english => 'Providers: GitHub, GitLab, self-hosted Git remotes',
    AppLocale.russian => 'Провайдеры: GitHub, GitLab, self-hosted Git remotes',
  };

  String get gitHubBrowserLogin => switch (locale) {
    AppLocale.english => 'Sign in to GitHub',
    AppLocale.russian => 'Войти в GitHub',
  };

  String get gitLabBrowserLogin => switch (locale) {
    AppLocale.english => 'Sign in to GitLab',
    AppLocale.russian => 'Войти в GitLab',
  };

  String get gitBrowserAuthHint => switch (locale) {
    AppLocale.english =>
      'Osinara starts the provider CLI in the background, opens your browser, and shows the one-time code here. Keep `gh` or `glab` installed in PATH.',
    AppLocale.russian =>
      'Osinara запустит CLI провайдера в фоне, откроет браузер и покажет одноразовый код здесь. Установите `gh` или `glab` и добавьте их в PATH.',
  };

  String gitAuthProviderName(GitAuthProvider provider) {
    return switch (provider) {
      GitAuthProvider.github => 'GitHub',
      GitAuthProvider.gitlab => 'GitLab',
    };
  }

  String gitAuthDialogTitle(String providerName) => switch (locale) {
    AppLocale.english => 'Sign in to $providerName',
    AppLocale.russian => 'Вход в $providerName',
  };

  String gitAuthStarting(String providerName) => switch (locale) {
    AppLocale.english => 'Starting $providerName CLI authentication...',
    AppLocale.russian => 'Запускаем авторизацию через CLI $providerName...',
  };

  String gitAuthWaitingForCode(String providerName) => switch (locale) {
    AppLocale.english =>
      'Waiting for $providerName to issue a one-time code...',
    AppLocale.russian => 'Ждём одноразовый код от $providerName...',
  };

  String gitAuthWaitingForConfirmation(String providerName) => switch (locale) {
    AppLocale.english =>
      'Enter this code in the browser. $providerName CLI will save credentials after confirmation.',
    AppLocale.russian =>
      'Введите этот код в браузере. После подтверждения CLI $providerName сохранит доступы.',
  };

  String gitAuthSucceeded(String providerName) => switch (locale) {
    AppLocale.english => '$providerName authentication is complete.',
    AppLocale.russian => 'Авторизация $providerName завершена.',
  };

  String gitAuthFailed(String providerName) => switch (locale) {
    AppLocale.english => '$providerName authentication failed.',
    AppLocale.russian => 'Авторизация $providerName не удалась.',
  };

  String gitAuthCancelled(String providerName) => switch (locale) {
    AppLocale.english => '$providerName authentication was cancelled.',
    AppLocale.russian => 'Авторизация $providerName отменена.',
  };

  String get gitAuthBrowserOpenFailed => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_AUTH_BROWSER_OPEN_FAILED: Не удалось открыть браузер автоматически. Откройте ссылку ниже вручную и введите код.',
    AppLocale.russian =>
      'OSI_GIT_AUTH_BROWSER_OPEN_FAILED: Не удалось открыть браузер автоматически. Откройте ссылку ниже вручную и введите код.',
  };

  String get gitAuthCodeLabel => switch (locale) {
    AppLocale.english => 'One-time code',
    AppLocale.russian => 'Одноразовый код',
  };

  String get gitAuthUrlLabel => switch (locale) {
    AppLocale.english => 'Verification URL',
    AppLocale.russian => 'Ссылка для подтверждения',
  };

  String get gitAuthOpenBrowser => switch (locale) {
    AppLocale.english => 'Open browser',
    AppLocale.russian => 'Открыть браузер',
  };

  String get gitAuthCodeCopied => switch (locale) {
    AppLocale.english => 'Copied',
    AppLocale.russian => 'Скопировано',
  };

  String get gitAuthTechnicalLog => switch (locale) {
    AppLocale.english => 'CLI output',
    AppLocale.russian => 'Вывод CLI',
  };

  String gitAuthConnectionStatusLabel(GitAuthConnectionStatus status) {
    return switch (status) {
      GitAuthConnectionStatus.unknown => switch (locale) {
        AppLocale.english => 'Not checked',
        AppLocale.russian => 'Не проверено',
      },
      GitAuthConnectionStatus.connected => switch (locale) {
        AppLocale.english => 'Connected',
        AppLocale.russian => 'Подключено',
      },
      GitAuthConnectionStatus.failed => switch (locale) {
        AppLocale.english => 'Needs attention',
        AppLocale.russian => 'Нужна проверка',
      },
    };
  }
}
