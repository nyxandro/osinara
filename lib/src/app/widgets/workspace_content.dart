/// Project workspace center with a persistent tab strip and full-size terminal tabs.
///
/// Key constructs:
/// - [WorkspaceContent]: renders selected project tabs and the active tab body.
/// - [_WorkspaceTabStrip]: top tab row with terminal tabs and the new-tab action.
/// - [_LauncherPanel]: base tab used to choose a CLI profile before launch.
library;

import 'package:flutter/material.dart';

import '../../embedded_terminal/embedded_terminal_session.dart';
import '../../launch_profiles/launch_profile.dart';
import '../../localization/app_strings.dart';
import '../../projects/project_workspace_store.dart';
import '../../projects/project_workspace_tab.dart';
import 'embedded_terminal_workspace.dart';
import 'file_viewer.dart';
import 'launch_message.dart';
import 'launch_profile_card.dart';

const _workspaceTabStripHeight = 44.0;
const _workspaceTabGap = 6.0;
const _workspaceInactiveTabHeight = 32.0;
const _workspaceFusedTabHeight = _workspaceTabStripHeight - _workspaceTabGap;
const _workspaceTabRadius = 10.0;

class WorkspaceContent extends StatefulWidget {
  const WorkspaceContent({
    super.key,
    required this.workspace,
    required this.launchErrorMessage,
    required this.isLaunching,
    required this.fileContentReader,
    required this.onLaunch,
  });

  final ProjectWorkspaceStore workspace;
  final String? launchErrorMessage;
  final bool isLaunching;
  final FileContentReader fileContentReader;
  final ValueChanged<LaunchProfile> onLaunch;

  @override
  State<WorkspaceContent> createState() => _WorkspaceContentState();
}

class _WorkspaceContentState extends State<WorkspaceContent> {
  final _terminalBackgroundBySessionId = <String, Color>{};

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.workspace,
      builder: (context, _) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _WorkspaceTabStrip(
              workspace: widget.workspace,
              terminalBackgroundBySessionId: _terminalBackgroundBySessionId,
            ),
            Expanded(
              child: _ActiveTabBody(
                workspace: widget.workspace,
                launchErrorMessage: widget.launchErrorMessage,
                isLaunching: widget.isLaunching,
                fileContentReader: widget.fileContentReader,
                terminalBackgroundBySessionId: _terminalBackgroundBySessionId,
                onLaunch: widget.onLaunch,
                onTerminalBackgroundSampled: _handleTerminalBackgroundSampled,
              ),
            ),
          ],
        );
      },
    );
  }

  void _handleTerminalBackgroundSampled({
    required String sessionId,
    required Color color,
  }) {
    if (_terminalBackgroundBySessionId[sessionId] == color) {
      return;
    }

    setState(() {
      _terminalBackgroundBySessionId[sessionId] = color;
    });
  }
}

class _ActiveTabBody extends StatelessWidget {
  const _ActiveTabBody({
    required this.workspace,
    required this.launchErrorMessage,
    required this.isLaunching,
    required this.fileContentReader,
    required this.terminalBackgroundBySessionId,
    required this.onLaunch,
    required this.onTerminalBackgroundSampled,
  });

  final ProjectWorkspaceStore workspace;
  final String? launchErrorMessage;
  final bool isLaunching;
  final FileContentReader fileContentReader;
  final Map<String, Color> terminalBackgroundBySessionId;
  final ValueChanged<LaunchProfile> onLaunch;
  final void Function({required String sessionId, required Color color})
  onTerminalBackgroundSampled;

  @override
  Widget build(BuildContext context) {
    final tab = workspace.selectedTab;
    if (tab.isLauncher) {
      return _LauncherPanel(
        launchErrorMessage: launchErrorMessage,
        isLaunching: isLaunching,
        onLaunch: onLaunch,
      );
    }

    final session = workspace.terminalSessionForTab(tab);
    if (tab.isTerminal) {
      if (session == null) {
        return const SizedBox.shrink();
      }

      return EmbeddedTerminalWorkspace(
        session: session,
        backgroundColor: terminalBackgroundBySessionId[session.id],
        onBackgroundColorSampled: (color) =>
            onTerminalBackgroundSampled(sessionId: session.id, color: color),
      );
    }

    final filePath = tab.filePath;
    if (filePath == null) {
      return const SizedBox.shrink();
    }

    return FileViewer(filePath: filePath, reader: fileContentReader);
  }
}

class _WorkspaceTabStrip extends StatelessWidget {
  const _WorkspaceTabStrip({
    required this.workspace,
    required this.terminalBackgroundBySessionId,
  });

  final ProjectWorkspaceStore workspace;
  final Map<String, Color> terminalBackgroundBySessionId;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final selectedTerminalBackground = _terminalBackgroundForTab(
      workspace.selectedTab,
    );

    // The tab strip is the only chrome above terminal tabs and stays visible for every project.
    return Container(
      key: const Key('workspace-tab-strip'),
      height: _workspaceTabStripHeight,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: colorScheme.surface,
        border: Border(
          bottom: BorderSide(
            color: selectedTerminalBackground ?? colorScheme.outlineVariant,
          ),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final tab in workspace.selectedProjectTabs)
                    _WorkspaceTabButton(
                      workspace: workspace,
                      tab: tab,
                      selected: tab.id == workspace.selectedTab.id,
                      terminalBackgroundColor: _terminalBackgroundForTab(tab),
                    ),
                ],
              ),
            ),
          ),
          if (workspace.selectedProjectHasContentTabs)
            IconButton(
              key: const Key('workspace-new-tab-button'),
              tooltip: strings.newTerminalTab,
              onPressed: workspace.openLauncherTab,
              icon: const Icon(Icons.add_rounded),
            ),
        ],
      ),
    );
  }

  Color? _terminalBackgroundForTab(ProjectWorkspaceTab tab) {
    final sessionId = tab.terminalSessionId;
    if (sessionId == null) {
      return null;
    }

    return terminalBackgroundBySessionId[sessionId];
  }
}

class _WorkspaceTabButton extends StatelessWidget {
  const _WorkspaceTabButton({
    required this.workspace,
    required this.tab,
    required this.selected,
    required this.terminalBackgroundColor,
  });

  final ProjectWorkspaceStore workspace;
  final ProjectWorkspaceTab tab;
  final bool selected;
  final Color? terminalBackgroundColor;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final session = workspace.terminalSessionForTab(tab);
    final colorScheme = Theme.of(context).colorScheme;
    final fusedWithTerminal =
        selected && tab.isTerminal && terminalBackgroundColor != null;
    final tabBackground = _tabBackgroundColor(
      colorScheme: colorScheme,
      fusedWithTerminal: fusedWithTerminal,
    );
    final foreground = fusedWithTerminal
        ? _foregroundFor(tabBackground)
        : selected
        ? colorScheme.primary
        : colorScheme.onSurface;
    final canClose =
        !tab.isLauncher || workspace.selectedProjectTabs.length > 1;

    return Padding(
      padding: const EdgeInsets.only(right: _workspaceTabGap),
      child: Material(
        key: _tabShellKey(tab),
        color: tabBackground,
        borderRadius: _tabBorderRadius(fusedWithTerminal),
        child: InkWell(
          key: _tabKey(tab),
          borderRadius: _tabBorderRadius(fusedWithTerminal),
          onTap: () => workspace.selectTab(tab.id),
          child: SizedBox(
            height: fusedWithTerminal
                ? _workspaceFusedTabHeight
                : _workspaceInactiveTabHeight,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(width: 10),
                Icon(_tabIcon(tab), size: 15, color: foreground),
                const SizedBox(width: 8),
                Text(
                  _tabLabel(strings, tab, session),
                  style: TextStyle(
                    color: foreground,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (session != null) ...[
                  const SizedBox(width: 8),
                  _StatusDot(status: session.status),
                ],
                if (canClose)
                  IconButton(
                    tooltip: strings.closeTerminal,
                    visualDensity: VisualDensity.compact,
                    onPressed: () => workspace.closeSelectedProjectTab(tab.id),
                    icon: const Icon(Icons.close_rounded, size: 16),
                  )
                else
                  const SizedBox(width: 10),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Color _tabBackgroundColor({
    required ColorScheme colorScheme,
    required bool fusedWithTerminal,
  }) {
    if (fusedWithTerminal) {
      return terminalBackgroundColor!;
    }

    return selected
        ? colorScheme.primaryContainer.withValues(alpha: 0.32)
        : colorScheme.surfaceContainerHighest.withValues(alpha: 0.35);
  }

  Color _foregroundFor(Color background) {
    final brightness = ThemeData.estimateBrightnessForColor(background);
    return brightness == Brightness.dark ? Colors.white : Colors.black;
  }

  BorderRadius _tabBorderRadius(bool fusedWithTerminal) {
    const topRadius = Radius.circular(_workspaceTabRadius);
    final bottomRadius = fusedWithTerminal
        ? Radius.zero
        : const Radius.circular(_workspaceTabRadius);

    return BorderRadius.only(
      topLeft: topRadius,
      topRight: topRadius,
      bottomLeft: bottomRadius,
      bottomRight: bottomRadius,
    );
  }

  IconData _tabIcon(ProjectWorkspaceTab tab) {
    if (tab.isLauncher) {
      return Icons.add_box_rounded;
    }
    if (tab.isFile) {
      return Icons.description_outlined;
    }

    return Icons.terminal_rounded;
  }

  Key _tabKey(ProjectWorkspaceTab tab) {
    if (tab.isLauncher) {
      return Key('workspace-launcher-tab-${tab.id}');
    }
    if (tab.isFile) {
      return Key('workspace-file-tab-${tab.id}');
    }

    return Key('workspace-terminal-tab-${tab.id}');
  }

  Key _tabShellKey(ProjectWorkspaceTab tab) {
    return Key('workspace-tab-shell-${tab.id}');
  }

  String _tabLabel(
    AppStrings strings,
    ProjectWorkspaceTab tab,
    EmbeddedTerminalSession? session,
  ) {
    if (tab.isLauncher) {
      return strings.launcherTab;
    }
    if (tab.isFile) {
      return _basename(tab.filePath!);
    }

    return session?.profile.agentName ?? strings.terminal;
  }
}

String _basename(String path) {
  final normalized = path.endsWith('/')
      ? path.substring(0, path.length - 1)
      : path;
  final separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex < 0) {
    return normalized;
  }

  return normalized.substring(separatorIndex + 1);
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final EmbeddedTerminalStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      EmbeddedTerminalStatus.starting ||
      EmbeddedTerminalStatus.running => Theme.of(context).colorScheme.primary,
      EmbeddedTerminalStatus.exited => const Color(0xFF34D399),
      EmbeddedTerminalStatus.failed => Theme.of(context).colorScheme.error,
    };

    return DecoratedBox(
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: const SizedBox.square(dimension: 8),
    );
  }
}

class _LauncherPanel extends StatelessWidget {
  const _LauncherPanel({
    required this.launchErrorMessage,
    required this.isLaunching,
    required this.onLaunch,
  });

  final String? launchErrorMessage;
  final bool isLaunching;
  final ValueChanged<LaunchProfile> onLaunch;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return SingleChildScrollView(
      key: const Key('workspace-launcher-panel'),
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            strings.launchProfiles,
            style: Theme.of(context).textTheme.displaySmall,
          ),
          const SizedBox(height: 8),
          Text(
            strings.launchProfilesDescription,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          if (launchErrorMessage != null) ...[
            const SizedBox(height: 12),
            LaunchMessage(message: launchErrorMessage!),
          ],
          const SizedBox(height: 20),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final profile in defaultLaunchProfiles)
                  Padding(
                    padding: const EdgeInsets.only(right: 16),
                    child: LaunchProfileCard(
                      profile: profile,
                      enabled: !isLaunching,
                      onLaunch: () => onLaunch(profile),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
