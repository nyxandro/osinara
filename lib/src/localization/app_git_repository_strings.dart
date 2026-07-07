/// Localized strings for Git repository actions.
///
/// Key constructs:
/// - [GitRepositoryAppStrings]: labels, validation text, and user-facing errors
///   for repository initialization and publish flows.
library;

import '../git/git_repository_actions.dart';
import 'app_locale.dart';
import 'app_strings.dart';

extension GitRepositoryAppStrings on AppStrings {
  String get gitPublishRepository => switch (locale) {
    AppLocale.english => 'Publish repository',
    AppLocale.russian => 'Опубликовать репозиторий',
  };

  String get gitPublishDescription => switch (locale) {
    AppLocale.english =>
      'Create a remote repository with the selected provider and push the current branch.',
    AppLocale.russian =>
      'Создайте удалённый репозиторий у выбранного провайдера и отправьте текущую ветку.',
  };

  String get gitPublishProvider => switch (locale) {
    AppLocale.english => 'Provider',
    AppLocale.russian => 'Провайдер',
  };

  String get gitPublishOwner => switch (locale) {
    AppLocale.english => 'Owner or namespace',
    AppLocale.russian => 'Владелец или namespace',
  };

  String get gitPublishRepositoryName => switch (locale) {
    AppLocale.english => 'Repository name',
    AppLocale.russian => 'Название репозитория',
  };

  String get gitPublishRemoteName => switch (locale) {
    AppLocale.english => 'Remote name',
    AppLocale.russian => 'Имя remote',
  };

  String get gitPublishVisibility => switch (locale) {
    AppLocale.english => 'Visibility',
    AppLocale.russian => 'Видимость',
  };

  String get gitPublishSubmit => switch (locale) {
    AppLocale.english => 'Publish',
    AppLocale.russian => 'Опубликовать',
  };

  String get gitPublishRequiredField => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_PUBLISH_FIELD_REQUIRED: Заполните обязательное поле перед публикацией.',
    AppLocale.russian =>
      'OSI_GIT_PUBLISH_FIELD_REQUIRED: Заполните обязательное поле перед публикацией.',
  };

  String get gitPublishVisibilityRequired => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_PUBLISH_VISIBILITY_REQUIRED: Выберите видимость репозитория перед публикацией.',
    AppLocale.russian =>
      'OSI_GIT_PUBLISH_VISIBILITY_REQUIRED: Выберите видимость репозитория перед публикацией.',
  };

  String get gitPublishProviderRequired => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_PUBLISH_PROVIDER_REQUIRED: Выберите провайдера репозитория перед публикацией.',
    AppLocale.russian =>
      'OSI_GIT_PUBLISH_PROVIDER_REQUIRED: Выберите провайдера репозитория перед публикацией.',
  };

  String get gitPublishFailed => switch (locale) {
    AppLocale.english =>
      'OSI_GIT_PUBLISH_FAILED: Не удалось опубликовать репозиторий. Проверьте авторизацию провайдера, имя репозитория и доступность сети.',
    AppLocale.russian =>
      'OSI_GIT_PUBLISH_FAILED: Не удалось опубликовать репозиторий. Проверьте авторизацию провайдера, имя репозитория и доступность сети.',
  };

  String gitPublishProviderLabel(GitRemoteProvider provider) {
    return switch (provider) {
      GitRemoteProvider.github => 'GitHub',
      GitRemoteProvider.gitlab => 'GitLab',
    };
  }

  String gitPublishVisibilityLabel(GitRepositoryVisibility visibility) {
    return switch (visibility) {
      GitRepositoryVisibility.private => switch (locale) {
        AppLocale.english => 'Private',
        AppLocale.russian => 'Приватный',
      },
      GitRepositoryVisibility.internal => switch (locale) {
        AppLocale.english => 'Internal',
        AppLocale.russian => 'Внутренний',
      },
      GitRepositoryVisibility.public => switch (locale) {
        AppLocale.english => 'Public',
        AppLocale.russian => 'Публичный',
      },
    };
  }
}
