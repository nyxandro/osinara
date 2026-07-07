/// Settings screen for local interface preferences.
///
/// Key constructs:
/// - [SettingsContent]: renders local language and theme preferences.
/// - [_SettingsHeader]: window-like title row with a close action.
/// - [_PreferenceCard]: shared card layout for settings groups.
/// - [_SettingsChoice]: accessible selected-state chip for compact choices.
/// - [_GitAuthenticationActions]: starts provider CLI browser-auth dialogs.
library;

import 'package:flutter/material.dart';

import '../../git/git_auth_flow.dart';
import '../../localization/app_locale.dart';
import '../../localization/app_git_auth_strings.dart';
import '../../localization/app_strings.dart';
import '../../theme/osinara_theme.dart';

class SettingsContent extends StatelessWidget {
  const SettingsContent({
    super.key,
    required this.locale,
    required this.themeId,
    required this.onLocaleChanged,
    required this.onThemeChanged,
    required this.onStartGitAuth,
    required this.gitAuthStatuses,
    required this.onClose,
  });

  final AppLocale locale;
  final OsinaraThemeId themeId;
  final ValueChanged<AppLocale> onLocaleChanged;
  final ValueChanged<OsinaraThemeId> onThemeChanged;
  final ValueChanged<GitAuthProvider> onStartGitAuth;
  final Map<GitAuthProvider, GitAuthConnectionStatus> gitAuthStatuses;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SettingsHeader(
            title: strings.interfaceSettings,
            closeLabel: strings.close,
            onClose: onClose,
          ),
          const SizedBox(height: 8),
          Text(
            strings.settingsDescription,
            style: TextStyle(color: colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 28),
          _PreferenceCard(
            icon: Icons.translate_rounded,
            title: strings.language,
            description: strings.languageDescription,
            child: Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                _SettingsChoice(
                  label: strings.english,
                  selected: locale == AppLocale.english,
                  onPressed: () => onLocaleChanged(AppLocale.english),
                ),
                _SettingsChoice(
                  label: strings.russian,
                  selected: locale == AppLocale.russian,
                  onPressed: () => onLocaleChanged(AppLocale.russian),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _PreferenceCard(
            icon: Icons.contrast_rounded,
            title: strings.theme,
            description: strings.themeDescription,
            child: Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                for (final theme in OsinaraThemeCatalog.all)
                  _SettingsChoice(
                    label: theme.label(locale),
                    selected: theme.id == themeId,
                    onPressed: () => onThemeChanged(theme.id),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _PreferenceCard(
            icon: Icons.key_rounded,
            title: strings.gitAuthentication,
            description: strings.gitAuthenticationDescription,
            child: _GitAuthenticationActions(
              providerHint: strings.gitProviderHint,
              browserAuthHint: strings.gitBrowserAuthHint,
              githubLabel: strings.gitHubBrowserLogin,
              gitlabLabel: strings.gitLabBrowserLogin,
              githubStatus:
                  gitAuthStatuses[GitAuthProvider.github] ??
                  GitAuthConnectionStatus.unknown,
              gitlabStatus:
                  gitAuthStatuses[GitAuthProvider.gitlab] ??
                  GitAuthConnectionStatus.unknown,
              onStartGitAuth: onStartGitAuth,
            ),
          ),
        ],
      ),
    );
  }
}

class _GitAuthenticationActions extends StatelessWidget {
  const _GitAuthenticationActions({
    required this.providerHint,
    required this.browserAuthHint,
    required this.githubLabel,
    required this.gitlabLabel,
    required this.githubStatus,
    required this.gitlabStatus,
    required this.onStartGitAuth,
  });

  final String providerHint;
  final String browserAuthHint;
  final String githubLabel;
  final String gitlabLabel;
  final GitAuthConnectionStatus githubStatus;
  final GitAuthConnectionStatus gitlabStatus;
  final ValueChanged<GitAuthProvider> onStartGitAuth;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          providerHint,
          style: TextStyle(color: colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 14),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            _GitAuthButton(
              key: const Key('git-auth-github-button'),
              icon: Icons.hub_rounded,
              label: githubLabel,
              status: githubStatus,
              onPressed: () => onStartGitAuth(GitAuthProvider.github),
            ),
            _GitAuthButton(
              key: const Key('git-auth-gitlab-button'),
              icon: Icons.account_tree_rounded,
              label: gitlabLabel,
              status: gitlabStatus,
              onPressed: () => onStartGitAuth(GitAuthProvider.gitlab),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Text(
          browserAuthHint,
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _GitAuthButton extends StatelessWidget {
  const _GitAuthButton({
    super.key,
    required this.icon,
    required this.label,
    required this.status,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final GitAuthConnectionStatus status;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    // Outlined buttons keep auth actions visible without looking like primary app navigation.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        OutlinedButton.icon(
          icon: Icon(icon, size: 18),
          label: Text(label),
          onPressed: onPressed,
        ),
        const SizedBox(height: 6),
        _GitAuthStatusChip(status: status),
      ],
    );
  }
}

class _GitAuthStatusChip extends StatelessWidget {
  const _GitAuthStatusChip({required this.status});

  final GitAuthConnectionStatus status;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final color = switch (status) {
      GitAuthConnectionStatus.connected => colorScheme.primary,
      GitAuthConnectionStatus.failed => colorScheme.error,
      GitAuthConnectionStatus.unknown => colorScheme.onSurfaceVariant,
    };

    return Text(
      strings.gitAuthConnectionStatusLabel(status),
      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: color),
    );
  }
}

class _SettingsHeader extends StatelessWidget {
  const _SettingsHeader({
    required this.title,
    required this.closeLabel,
    required this.onClose,
  });

  final String title;
  final String closeLabel;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.displaySmall),
        ),
        IconButton(
          key: const Key('settings-close-button'),
          tooltip: closeLabel,
          onPressed: onClose,
          icon: const Icon(Icons.close_rounded),
        ),
      ],
    );
  }
}

class _PreferenceCard extends StatelessWidget {
  const _PreferenceCard({
    required this.icon,
    required this.title,
    required this.description,
    required this.child,
  });

  final IconData icon;
  final String title;
  final String description;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: colorScheme.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              description,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 20),
            child,
          ],
        ),
      ),
    );
  }
}

class _SettingsChoice extends StatelessWidget {
  const _SettingsChoice({
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    // FilterChip gives clear selected state and remains keyboard/touch accessible.
    return FilterChip(
      selected: selected,
      label: Text(label),
      avatar: selected ? const Icon(Icons.check_rounded) : null,
      onSelected: (_) => onPressed(),
    );
  }
}
