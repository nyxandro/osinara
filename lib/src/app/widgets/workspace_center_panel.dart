/// Center panel switcher for workspace and settings content.
///
/// Key constructs:
/// - [WorkspaceCenterPanel]: renders the visible center section or an empty collapsed panel.
library;

import 'package:flutter/material.dart';

import '../../git/git_auth_flow.dart';
import '../../launch_profiles/launch_profile.dart';
import '../../localization/app_locale.dart';
import '../../projects/project_workspace_store.dart';
import '../../theme/osinara_theme.dart';
import '../workspace_section.dart';
import 'file_viewer.dart';
import 'resizable_panels.dart';
import 'settings_content.dart';
import 'workspace_content.dart';

final class WorkspaceCenterPanel extends StatelessWidget {
  const WorkspaceCenterPanel({
    super.key,
    required this.visible,
    required this.section,
    required this.workspace,
    required this.locale,
    required this.themeId,
    required this.launchErrorMessage,
    required this.isLaunching,
    required this.fileContentReader,
    required this.gitAuthStatuses,
    required this.onLaunch,
    required this.onStartGitAuth,
    required this.onLocaleChanged,
    required this.onThemeChanged,
    required this.onCloseSettings,
  });

  final bool visible;
  final WorkspaceSection section;
  final ProjectWorkspaceStore workspace;
  final AppLocale locale;
  final OsinaraThemeId themeId;
  final String? launchErrorMessage;
  final bool isLaunching;
  final FileContentReader fileContentReader;
  final Map<GitAuthProvider, GitAuthConnectionStatus> gitAuthStatuses;
  final ValueChanged<LaunchProfile> onLaunch;
  final ValueChanged<GitAuthProvider> onStartGitAuth;
  final ValueChanged<AppLocale> onLocaleChanged;
  final ValueChanged<OsinaraThemeId> onThemeChanged;
  final VoidCallback onCloseSettings;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: panelAnimationDuration,
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      child: visible
          ? KeyedSubtree(
              key: ValueKey(section),
              child: switch (section) {
                WorkspaceSection.workspace => WorkspaceContent(
                  workspace: workspace,
                  launchErrorMessage: launchErrorMessage,
                  isLaunching: isLaunching,
                  fileContentReader: fileContentReader,
                  onLaunch: onLaunch,
                ),
                WorkspaceSection.settings => Padding(
                  padding: const EdgeInsets.all(24),
                  child: SettingsContent(
                    locale: locale,
                    themeId: themeId,
                    onLocaleChanged: onLocaleChanged,
                    onThemeChanged: onThemeChanged,
                    onStartGitAuth: onStartGitAuth,
                    gitAuthStatuses: gitAuthStatuses,
                    onClose: onCloseSettings,
                  ),
                ),
              },
            )
          : const SizedBox.expand(),
    );
  }
}
