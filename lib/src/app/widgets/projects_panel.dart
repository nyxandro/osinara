/// Right-side projects panel separated from the file tree and workspace.
///
/// Key constructs:
/// - [ProjectsPanel]: project list with embedded terminal sessions nested under projects.
/// - [_ProjectTile]: compact project row used inside the right panel.
/// - [_ProjectExpandButton]: file-tree-like chevron for showing and hiding project sessions.
/// - [_TerminalSessionTile]: switchable running process row inside a project.
library;

import 'dart:io';

import 'package:flutter/material.dart';

import '../../embedded_terminal/embedded_terminal_session.dart';
import '../../localization/app_strings.dart';
import '../../projects/project_workspace.dart';
import '../../projects/project_workspace_store.dart';
import '../../theme/osinara_theme.dart';

const _treeRowHeight = 26.0;
const _treeIndent = 18.0;
const _expandGlyphWidth = 12.0;
const _rowStartPadding = 4.0;
const _iconTextGap = 6.0;
const _settingsButtonSize = 22.0;
const _settingsIconSize = 14.0;

class ProjectsPanel extends StatelessWidget {
  const ProjectsPanel({
    super.key,
    required this.workspace,
    required this.onAddProjectPressed,
    required this.onProjectSettingsPressed,
  });

  final ProjectWorkspaceStore workspace;
  final VoidCallback onAddProjectPressed;
  final ValueChanged<ProjectWorkspace> onProjectSettingsPressed;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);

    return AnimatedBuilder(
      animation: workspace,
      builder: (context, _) {
        return DecoratedBox(
          decoration: BoxDecoration(
            color: tokens.projectPanelBackground,
            border: Border(left: BorderSide(color: colorScheme.outlineVariant)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    for (final project in workspace.projects)
                      _ProjectTile(
                        key: ValueKey('project-folder-${project.id}'),
                        project: project,
                        selected: workspace.isProjectSelected(project),
                        sessions: workspace.sessionsForProject(project),
                        isSessionSelected: workspace.isTerminalSessionSelected,
                        onProjectSelected: () =>
                            workspace.selectProject(project.id),
                        onProjectSettingsPressed: () =>
                            onProjectSettingsPressed(project),
                        onTerminalSessionSelected:
                            workspace.selectTerminalSession,
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                child: FilledButton.icon(
                  key: const Key('add-project-button'),
                  onPressed: onAddProjectPressed,
                  icon: const Icon(Icons.add_rounded),
                  label: Text(strings.addProject),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _ProjectTile extends StatefulWidget {
  const _ProjectTile({
    super.key,
    required this.project,
    required this.selected,
    required this.sessions,
    required this.isSessionSelected,
    required this.onProjectSelected,
    required this.onProjectSettingsPressed,
    required this.onTerminalSessionSelected,
  });

  final ProjectWorkspace project;
  final bool selected;
  final List<EmbeddedTerminalSession> sessions;
  final bool Function(EmbeddedTerminalSession session) isSessionSelected;
  final VoidCallback onProjectSelected;
  final VoidCallback onProjectSettingsPressed;
  final ValueChanged<String> onTerminalSessionSelected;

  @override
  State<_ProjectTile> createState() => _ProjectTileState();
}

class _ProjectTileState extends State<_ProjectTile> {
  late var _expanded = widget.sessions.isNotEmpty;
  var _hovered = false;

  @override
  void didUpdateWidget(_ProjectTile oldWidget) {
    super.didUpdateWidget(oldWidget);

    // A project with newly-created sessions should open once so the user sees the launched tab.
    if (oldWidget.sessions.isEmpty && widget.sessions.isNotEmpty) {
      _expanded = true;
    }
    if (widget.sessions.isEmpty) {
      _expanded = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);
    final mutedColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.72);
    final projectPath = _compactPath(widget.project.path);
    final hasSessions = widget.sessions.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: Tooltip(
            message: projectPath,
            waitDuration: const Duration(milliseconds: 450),
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                key: Key('project-tile-${widget.project.id}'),
                borderRadius: BorderRadius.circular(6),
                onTap: () {
                  widget.onProjectSelected();
                  if (hasSessions) {
                    _toggleExpanded();
                  }
                },
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: widget.selected
                        ? colorScheme.primaryContainer.withValues(alpha: 0.14)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: SizedBox(
                    height: _treeRowHeight,
                    child: Row(
                      children: [
                        const SizedBox(width: _rowStartPadding),
                        SizedBox(
                          width: _expandGlyphWidth,
                          child: hasSessions
                              ? _ProjectExpandButton(
                                  projectId: widget.project.id,
                                  expanded: _expanded,
                                  color: mutedColor,
                                  onPressed: _toggleExpanded,
                                )
                              : null,
                        ),
                        const SizedBox(width: 4),
                        Icon(
                          Icons.folder_rounded,
                          size: 16,
                          color: tokens.folderIcon,
                        ),
                        const SizedBox(width: _iconTextGap),
                        Expanded(
                          child: _ProjectTitleLine(
                            name: widget.project.name,
                            path: projectPath,
                            showPath: _hovered,
                          ),
                        ),
                        if (_hovered || widget.selected)
                          _ProjectSettingsButton(
                            projectId: widget.project.id,
                            onPressed: widget.onProjectSettingsPressed,
                          )
                        else
                          const SizedBox(width: _settingsButtonSize),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (_expanded)
          for (final session in widget.sessions)
            _TerminalSessionTile(
              session: session,
              selected: widget.isSessionSelected(session),
              onSelected: () => widget.onTerminalSessionSelected(session.id),
            ),
      ],
    );
  }

  void _toggleExpanded() {
    setState(() => _expanded = !_expanded);
  }
}

class _ProjectExpandButton extends StatelessWidget {
  const _ProjectExpandButton({
    required this.projectId,
    required this.expanded,
    required this.color,
    required this.onPressed,
  });

  final String projectId;
  final bool expanded;
  final Color color;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      key: Key('project-toggle-$projectId'),
      behavior: HitTestBehavior.opaque,
      onTap: onPressed,
      child: AnimatedRotation(
        turns: expanded ? 0.25 : 0,
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOutCubic,
        child: Icon(Icons.chevron_right_rounded, size: 12, color: color),
      ),
    );
  }
}

class _ProjectTitleLine extends StatelessWidget {
  const _ProjectTitleLine({
    required this.name,
    required this.path,
    required this.showPath,
  });

  final String name;
  final String path;
  final bool showPath;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final mutedColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.72);

    // Keep the project row single-line; path appears beside the name only on hover.
    if (!showPath) {
      return Text(
        name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 13,
          height: 1.1,
          color: colorScheme.onSurface,
        ),
      );
    }

    return Row(
      children: [
        Flexible(
          child: Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              height: 1.1,
              color: colorScheme.onSurface,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            path,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, height: 1.1, color: mutedColor),
          ),
        ),
      ],
    );
  }
}

class _ProjectSettingsButton extends StatelessWidget {
  const _ProjectSettingsButton({
    required this.projectId,
    required this.onPressed,
  });

  final String projectId;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: _settingsButtonSize,
      child: IconButton(
        key: Key('project-settings-$projectId'),
        tooltip: AppStrings.of(context).projectSettings,
        constraints: const BoxConstraints.tightFor(
          width: _settingsButtonSize,
          height: _settingsButtonSize,
        ),
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        onPressed: onPressed,
        icon: const Icon(Icons.settings_outlined, size: _settingsIconSize),
      ),
    );
  }
}

class _TerminalSessionTile extends StatelessWidget {
  const _TerminalSessionTile({
    required this.session,
    required this.selected,
    required this.onSelected,
  });

  final EmbeddedTerminalSession session;
  final bool selected;
  final VoidCallback? onSelected;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final strings = AppStrings.of(context);
    final selectedColor = colorScheme.primaryContainer.withValues(alpha: 0.18);
    final mutedColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.72);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        key: Key('project-terminal-session-${session.id}'),
        borderRadius: BorderRadius.circular(6),
        onTap: onSelected,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: selected ? selectedColor : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
          ),
          child: SizedBox(
            height: _treeRowHeight,
            child: Row(
              children: [
                const SizedBox(width: _rowStartPadding + _treeIndent),
                const SizedBox(width: _expandGlyphWidth),
                const SizedBox(width: 4),
                Icon(
                  Icons.terminal_rounded,
                  size: 16,
                  color: selected ? colorScheme.primary : mutedColor,
                ),
                const SizedBox(width: _iconTextGap),
                Expanded(
                  child: Text(
                    session.title ?? strings.newSession,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.1,
                      color: selected ? colorScheme.onSurface : mutedColor,
                    ),
                  ),
                ),
                const SizedBox(width: _settingsButtonSize),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String _compactPath(String path) {
  final homePath = Platform.environment['HOME'];
  if (homePath != null && path.startsWith(homePath)) {
    return '~${path.substring(homePath.length)}';
  }

  return path;
}
