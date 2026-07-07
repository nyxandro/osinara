/// Bottom status bar with compact icon-only controls for all major panels.
///
/// Key constructs:
/// - [BottomStatusBar]: app-wide status strip with panel toggles and settings button.
/// - [_StatusToggle]: icon-only accessible toggle with tooltip and selected state.
library;

import 'package:flutter/material.dart';

import '../../localization/app_strings.dart';
import '../../theme/osinara_theme.dart';

const _statusButtonSize = 30.0;
const _statusButtonIconSize = 16.0;
const _inactiveStatusIconOpacity = 0.45;

class BottomStatusBar extends StatelessWidget {
  const BottomStatusBar({
    super.key,
    required this.filesVisible,
    required this.gitVisible,
    required this.centerVisible,
    required this.projectsVisible,
    required this.onToggleFiles,
    required this.onToggleGit,
    required this.onToggleCenter,
    required this.onToggleProjects,
    required this.onOpenSettings,
  });

  final bool filesVisible;
  final bool gitVisible;
  final bool centerVisible;
  final bool projectsVisible;
  final VoidCallback onToggleFiles;
  final VoidCallback onToggleGit;
  final VoidCallback onToggleCenter;
  final VoidCallback onToggleProjects;
  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.statusBarBackground,
        border: Border(top: BorderSide(color: colorScheme.outlineVariant)),
      ),
      child: SizedBox(
        height: 38,
        child: Row(
          children: [
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Text(
                strings.appTitle,
                style: TextStyle(
                  color: colorScheme.onSurface,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            _StatusToggle(
              buttonKey: const Key('status-files-toggle'),
              icon: Icons.account_tree_rounded,
              label: strings.filesPanel,
              selected: filesVisible,
              onPressed: onToggleFiles,
            ),
            _StatusToggle(
              buttonKey: const Key('status-git-toggle'),
              icon: Icons.source_rounded,
              label: strings.gitPanel,
              selected: gitVisible,
              onPressed: onToggleGit,
            ),
            _StatusToggle(
              buttonKey: const Key('status-center-toggle'),
              icon: Icons.view_sidebar_rounded,
              label: strings.centerPanel,
              selected: centerVisible,
              onPressed: onToggleCenter,
            ),
            _StatusToggle(
              buttonKey: const Key('status-projects-toggle'),
              icon: Icons.folder_copy_rounded,
              label: strings.projectsPanel,
              selected: projectsVisible,
              onPressed: onToggleProjects,
            ),
            const Spacer(),
            _StatusToggle(
              buttonKey: const Key('status-settings-button'),
              icon: Icons.tune_rounded,
              label: strings.settings,
              selected: false,
              onPressed: onOpenSettings,
            ),
            const SizedBox(width: 8),
          ],
        ),
      ),
    );
  }
}

class _StatusToggle extends StatelessWidget {
  const _StatusToggle({
    required this.buttonKey,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  final Key buttonKey;
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final foreground = selected
        ? colorScheme.primary
        : colorScheme.onSurfaceVariant.withValues(
            alpha: _inactiveStatusIconOpacity,
          );

    return Tooltip(
      message: label,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            key: buttonKey,
            borderRadius: BorderRadius.circular(_statusButtonSize / 2),
            onTap: onPressed,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOutCubic,
              width: _statusButtonSize,
              height: _statusButtonSize,
              child: Icon(icon, size: _statusButtonIconSize, color: foreground),
            ),
          ),
        ),
      ),
    );
  }
}
