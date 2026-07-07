/// Main three-column workspace panel layout.
///
/// Key constructs:
/// - [WorkspacePanelsLayout]: lays out Files/Git, center workspace/settings, and Projects panels.
/// - [PanelResizeRequested]: callback shape for side-panel resize updates.
library;

import 'package:flutter/material.dart';

import '../../file_tree/file_tree_reader.dart';
import '../../file_tree/file_tree_watch_service.dart';
import '../../git/git_auth_flow.dart';
import '../../git/git_status_reader.dart';
import '../../launch_profiles/launch_profile.dart';
import '../../localization/app_locale.dart';
import '../../projects/project_workspace.dart';
import '../../projects/project_workspace_store.dart';
import '../../theme/osinara_theme.dart';
import '../workspace_section.dart';
import 'file_tree_panel.dart';
import 'file_viewer.dart';
import 'git_panel.dart';
import 'projects_panel.dart';
import 'resizable_panels.dart';
import 'workspace_center_panel.dart';

typedef PanelResizeRequested =
    void Function({required double delta, required double totalWidth});

final class WorkspacePanelsLayout extends StatelessWidget {
  const WorkspacePanelsLayout({
    super.key,
    required this.filesVisible,
    required this.gitVisible,
    required this.centerVisible,
    required this.projectsVisible,
    required this.filePanelWidth,
    required this.projectPanelWidth,
    required this.section,
    required this.workspace,
    required this.locale,
    required this.themeId,
    required this.launchErrorMessage,
    required this.isLaunching,
    required this.fileTreeReader,
    required this.fileTreeWatchService,
    required this.fileContentReader,
    required this.gitStatusReader,
    required this.gitAuthStatuses,
    required this.onLaunch,
    required this.onStartGitAuth,
    required this.onLocaleChanged,
    required this.onThemeChanged,
    required this.onCloseSettings,
    required this.onAddProjectPressed,
    required this.onProjectSettingsPressed,
    required this.onResizeFiles,
    required this.onResizeProjects,
  });

  final bool filesVisible;
  final bool gitVisible;
  final bool centerVisible;
  final bool projectsVisible;
  final double filePanelWidth;
  final double projectPanelWidth;
  final WorkspaceSection section;
  final ProjectWorkspaceStore workspace;
  final AppLocale locale;
  final OsinaraThemeId themeId;
  final String? launchErrorMessage;
  final bool isLaunching;
  final FileTreeReader fileTreeReader;
  final FileTreeWatchService fileTreeWatchService;
  final FileContentReader fileContentReader;
  final GitStatusReader gitStatusReader;
  final Map<GitAuthProvider, GitAuthConnectionStatus> gitAuthStatuses;
  final ValueChanged<LaunchProfile> onLaunch;
  final ValueChanged<GitAuthProvider> onStartGitAuth;
  final ValueChanged<AppLocale> onLocaleChanged;
  final ValueChanged<OsinaraThemeId> onThemeChanged;
  final VoidCallback onCloseSettings;
  final VoidCallback onAddProjectPressed;
  final ValueChanged<ProjectWorkspace> onProjectSettingsPressed;
  final PanelResizeRequested onResizeFiles;
  final PanelResizeRequested onResizeProjects;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final widths = PanelWidths.resolve(
          totalWidth: constraints.maxWidth,
          filesVisible: filesVisible || gitVisible,
          projectsVisible: projectsVisible,
          preferredFilesWidth: filePanelWidth,
          preferredProjectsWidth: projectPanelWidth,
        );

        return Stack(
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AnimatedSidePanel(
                  panelKey: const Key('left-panel'),
                  visible: filesVisible || gitVisible,
                  width: widths.files,
                  child: gitVisible
                      ? GitPanel(
                          projectPath: workspace.selectedProject.path,
                          reader: gitStatusReader,
                        )
                      : FileTreePanel(
                          key: const Key('files-panel'),
                          projectPath: workspace.selectedProject.path,
                          onFileSelected: (node) =>
                              workspace.openFile(node.path),
                          reader: fileTreeReader,
                          watchService: fileTreeWatchService,
                        ),
                ),
                Expanded(
                  child: SizedBox.expand(
                    key: const Key('center-panel'),
                    child: WorkspaceCenterPanel(
                      visible: centerVisible,
                      section: section,
                      workspace: workspace,
                      locale: locale,
                      themeId: themeId,
                      launchErrorMessage: launchErrorMessage,
                      isLaunching: isLaunching,
                      fileContentReader: fileContentReader,
                      gitAuthStatuses: gitAuthStatuses,
                      onLaunch: onLaunch,
                      onStartGitAuth: onStartGitAuth,
                      onLocaleChanged: onLocaleChanged,
                      onThemeChanged: onThemeChanged,
                      onCloseSettings: onCloseSettings,
                    ),
                  ),
                ),
                AnimatedSidePanel(
                  panelKey: const Key('projects-panel'),
                  visible: projectsVisible,
                  width: widths.projects,
                  child: ProjectsPanel(
                    workspace: workspace,
                    onAddProjectPressed: onAddProjectPressed,
                    onProjectSettingsPressed: onProjectSettingsPressed,
                  ),
                ),
              ],
            ),
            if (filesVisible || gitVisible)
              Positioned(
                left: widths.files - resizeHandleWidth / 2,
                top: 0,
                bottom: 0,
                child: PanelResizeHandle(
                  key: const Key('files-resize-handle'),
                  onDragDelta: (delta) => onResizeFiles(
                    delta: delta,
                    totalWidth: constraints.maxWidth,
                  ),
                ),
              ),
            if (projectsVisible)
              Positioned(
                left:
                    constraints.maxWidth -
                    widths.projects -
                    resizeHandleWidth / 2,
                top: 0,
                bottom: 0,
                child: PanelResizeHandle(
                  key: const Key('projects-resize-handle'),
                  onDragDelta: (delta) => onResizeProjects(
                    delta: delta,
                    totalWidth: constraints.maxWidth,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
