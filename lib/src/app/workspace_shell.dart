/// Main desktop layout with file tree, embedded terminal workspace, projects, and status bar.
///
/// Key constructs:
/// - [WorkspaceShell]: owns project workspace state, embedded terminal sessions, and panel layout state.
/// - [PanelResizeHandle], [PanelWidths]: imported resizable side-panel primitives.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../embedded_terminal/embedded_terminal_process.dart';
import '../embedded_terminal/embedded_terminal_session_store.dart';
import '../file_tree/file_tree_reader.dart';
import '../file_tree/file_tree_watch_service.dart';
import '../git/browser_launcher.dart';
import '../git/git_auth_flow.dart';
import '../git/git_auth_process.dart';
import '../git/git_status_reader.dart';
import '../launch_profiles/launch_profile.dart';
import '../localization/app_locale.dart';
import '../localization/app_strings.dart';
import '../projects/project_candidate_discovery.dart';
import '../projects/project_workspace.dart';
import '../projects/project_workspace_store.dart';
import '../settings/workspace_state.dart';
import '../settings/workspace_state_store.dart';
import '../theme/osinara_theme.dart';
import 'app_paths.dart';
import 'default_projects.dart';
import 'git_auth_dialog_launcher.dart';
import 'widgets/bottom_status_bar.dart';
import 'widgets/file_viewer.dart';
import 'widgets/project_add_dialog.dart';
import 'widgets/project_settings_dialog.dart';
import 'widgets/resizable_panels.dart';
import 'widgets/workspace_panels_layout.dart';
import 'workspace_persistence_controller.dart';
import 'workspace_section.dart';

class WorkspaceShell extends StatefulWidget {
  const WorkspaceShell({
    super.key,
    required this.locale,
    required this.themeId,
    this.initialProjects,
    this.terminalProcessFactory,
    this.fileTreeReader,
    this.fileTreeWatchService,
    this.fileContentReader,
    this.gitStatusReader,
    this.gitAuthProcessLauncher,
    this.browserLauncher,
    this.workspaceStateRepository,
    required this.onLocaleChanged,
    required this.onThemeChanged,
  });

  final AppLocale locale;
  final OsinaraThemeId themeId;
  final List<ProjectWorkspace>? initialProjects;
  final EmbeddedTerminalProcessFactory? terminalProcessFactory;
  final FileTreeReader? fileTreeReader;
  final FileTreeWatchService? fileTreeWatchService;
  final FileContentReader? fileContentReader;
  final GitStatusReader? gitStatusReader;
  final GitAuthProcessLauncher? gitAuthProcessLauncher;
  final BrowserLauncher? browserLauncher;
  final WorkspaceStateRepository? workspaceStateRepository;
  final ValueChanged<AppLocale> onLocaleChanged;
  final ValueChanged<OsinaraThemeId> onThemeChanged;

  @override
  State<WorkspaceShell> createState() => _WorkspaceShellState();
}

class _WorkspaceShellState extends State<WorkspaceShell> {
  late final EmbeddedTerminalSessionStore _terminalSessions;
  late final WorkspacePersistenceController _persistence;
  late ProjectWorkspaceStore _workspace;
  String? _launchErrorMessage;
  String? _launchErrorTabId;
  var _isLaunching = false;
  var _section = WorkspaceSection.workspace;
  var _filesVisible = true;
  var _gitVisible = false;
  var _centerVisible = true;
  var _projectsVisible = true;
  var _filePanelWidth = defaultFilePanelWidth;
  var _projectPanelWidth = defaultProjectPanelWidth;
  final _gitAuthStatuses = <GitAuthProvider, GitAuthConnectionStatus>{};

  @override
  void initState() {
    super.initState();
    _terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher:
          widget.terminalProcessFactory ?? const FlutterPtyProcessFactory(),
    );
    _persistence = WorkspacePersistenceController(
      repository:
          widget.workspaceStateRepository ??
          WorkspaceStateStore(AppPaths.workspaceStateFile()),
    );
    _workspace = ProjectWorkspaceStore(
      projects:
          widget.initialProjects ?? defaultProjects(Directory.current.path),
      terminalSessions: _terminalSessions,
    );
    _workspace.addListener(_handleWorkspaceChanged);
    unawaited(_restoreWorkspaceState());
  }

  @override
  void dispose() {
    unawaited(
      _persistence.saveNow(workspace: _workspace, panelState: _panelState),
    );
    _persistence.dispose();
    _workspace.removeListener(_handleWorkspaceChanged);
    _workspace.dispose();
    _terminalSessions.dispose();
    super.dispose();
  }

  Future<void> _launchProfile(LaunchProfile profile) async {
    final strings = AppStrings.of(context);
    final launchingTabId = _workspace.selectedTab.id;
    setState(() {
      _isLaunching = true;
      _launchErrorMessage = null;
      _launchErrorTabId = null;
      _section = WorkspaceSection.workspace;
      _centerVisible = true;
    });

    try {
      await _workspace.launchProfileInSelectedTab(
        profile: profile,
        environment: Platform.environment,
      );
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          _launchErrorMessage = strings.embeddedLaunchFailedMessage();
          _launchErrorTabId = launchingTabId;
        });
      }
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          library: 'osinara embedded terminal launcher',
          context: ErrorDescription('launching embedded terminal session'),
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _isLaunching = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: WorkspacePanelsLayout(
                filesVisible: _filesVisible,
                gitVisible: _gitVisible,
                centerVisible: _centerVisible,
                projectsVisible: _projectsVisible,
                filePanelWidth: _filePanelWidth,
                projectPanelWidth: _projectPanelWidth,
                section: _section,
                workspace: _workspace,
                locale: widget.locale,
                themeId: widget.themeId,
                launchErrorMessage:
                    _workspace.selectedTab.id == _launchErrorTabId
                    ? _launchErrorMessage
                    : null,
                isLaunching: _isLaunching,
                fileTreeReader: widget.fileTreeReader ?? const FileTreeReader(),
                fileTreeWatchService:
                    widget.fileTreeWatchService ??
                    const DirectoryFileTreeWatchService(),
                fileContentReader:
                    widget.fileContentReader ?? const LocalFileContentReader(),
                gitStatusReader:
                    widget.gitStatusReader ?? const GitStatusReader(),
                gitAuthStatuses: _gitAuthStatuses,
                onLaunch: _launchProfile,
                onStartGitAuth: _openGitAuthDialog,
                onLocaleChanged: widget.onLocaleChanged,
                onThemeChanged: widget.onThemeChanged,
                onCloseSettings: () => setState(() {
                  _section = WorkspaceSection.workspace;
                }),
                onAddProjectPressed: _openAddProjectDialog,
                onProjectSettingsPressed: _openProjectSettingsDialog,
                onResizeFiles: _resizeFilesPanel,
                onResizeProjects: _resizeProjectsPanel,
              ),
            ),
            BottomStatusBar(
              filesVisible: _filesVisible,
              gitVisible: _gitVisible,
              centerVisible: _centerVisible,
              projectsVisible: _projectsVisible,
              onToggleFiles: () {
                setState(() {
                  if (_filesVisible) {
                    _filesVisible = false;
                    return;
                  }

                  _filesVisible = true;
                  _gitVisible = false;
                });
                _schedulePersistWorkspaceState();
              },
              onToggleGit: () {
                setState(() {
                  if (_gitVisible) {
                    _gitVisible = false;
                    return;
                  }

                  _gitVisible = true;
                  _filesVisible = false;
                });
                _schedulePersistWorkspaceState();
              },
              onToggleCenter: () {
                setState(() => _centerVisible = !_centerVisible);
                _schedulePersistWorkspaceState();
              },
              onToggleProjects: () {
                setState(() => _projectsVisible = !_projectsVisible);
                _schedulePersistWorkspaceState();
              },
              onOpenSettings: () {
                setState(() {
                  _section = WorkspaceSection.settings;
                  _centerVisible = true;
                });
                _schedulePersistWorkspaceState();
              },
            ),
          ],
        ),
      ),
    );
  }

  void _handleWorkspaceChanged() {
    if (mounted) {
      setState(() {});
    }
    _schedulePersistWorkspaceState();
  }

  Future<void> _restoreWorkspaceState() async {
    final restored = await _persistence.restore(
      terminalSessions: _terminalSessions,
      environment: Platform.environment,
    );
    if (!mounted || restored == null) {
      return;
    }

    _workspace.removeListener(_handleWorkspaceChanged);
    _workspace.dispose();
    _workspace = restored.workspace;
    _workspace.addListener(_handleWorkspaceChanged);
    _applyPanelState(restored.panelState);
  }

  void _schedulePersistWorkspaceState() {
    _persistence.scheduleSave(workspace: _workspace, panelState: _panelState);
  }

  void _applyPanelState(WorkspacePanelState panelState) {
    setState(() {
      _filesVisible = panelState.filesVisible;
      _gitVisible = panelState.gitVisible;
      _centerVisible = panelState.centerVisible;
      _projectsVisible = panelState.projectsVisible;
      _filePanelWidth = panelState.filePanelWidth;
      _projectPanelWidth = panelState.projectPanelWidth;
    });
  }

  WorkspacePanelState get _panelState {
    return WorkspacePanelState(
      filesVisible: _filesVisible,
      gitVisible: _gitVisible,
      centerVisible: _centerVisible,
      projectsVisible: _projectsVisible,
      filePanelWidth: _filePanelWidth,
      projectPanelWidth: _projectPanelWidth,
    );
  }

  Future<void> _openAddProjectDialog() async {
    final sections = const ProjectCandidateDiscovery().discover(
      currentProjectPath: Directory.current.path,
    );
    final project = await showDialog<ProjectWorkspace>(
      context: context,
      builder: (context) => ProjectAddDialog(sections: sections),
    );
    if (project == null) {
      return;
    }

    try {
      _workspace.addProject(project);
    } on Object catch (error) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          library: 'osinara project workspace',
          context: ErrorDescription('adding project to workspace'),
        ),
      );
    }
  }

  Future<void> _openProjectSettingsDialog(ProjectWorkspace project) async {
    final result = await showDialog<ProjectSettingsResult>(
      context: context,
      builder: (context) => ProjectSettingsDialog(project: project),
    );
    if (result == null) {
      return;
    }

    try {
      switch (result.action) {
        case ProjectSettingsAction.save:
          _workspace.updateProject(
            project.id,
            name: result.name!,
            path: result.path!,
            iconName: result.iconName!,
          );
        case ProjectSettingsAction.delete:
          _workspace.removeProject(project.id);
      }
    } on Object catch (error) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          library: 'osinara project workspace',
          context: ErrorDescription('updating project settings'),
        ),
      );
    }
  }

  Future<void> _openGitAuthDialog(GitAuthProvider provider) async {
    final result = await showGitAuthDialog(
      context: context,
      provider: provider,
      processLauncher:
          widget.gitAuthProcessLauncher ?? const ProcessGitAuthLauncher(),
      browserLauncher:
          widget.browserLauncher ??
          ProcessBrowserLauncher(environment: Platform.environment),
      environment: Platform.environment,
    );
    if (!mounted || result == null) {
      return;
    }

    setState(() {
      switch (result) {
        case GitAuthDialogResult.succeeded:
          _gitAuthStatuses[provider] = GitAuthConnectionStatus.connected;
        case GitAuthDialogResult.failed:
          _gitAuthStatuses[provider] = GitAuthConnectionStatus.failed;
        case GitAuthDialogResult.cancelled:
          break;
      }
    });
  }

  void _resizeFilesPanel({required double delta, required double totalWidth}) {
    setState(() {
      _filePanelWidth = clampPanelWidth(
        value: _filePanelWidth + delta,
        maximum: maximumWorkspaceFilePanelWidth(
          totalWidth: totalWidth,
          projectsVisible: _projectsVisible,
          projectPanelWidth: _projectPanelWidth,
        ),
      );
    });
    _schedulePersistWorkspaceState();
  }

  void _resizeProjectsPanel({
    required double delta,
    required double totalWidth,
  }) {
    setState(() {
      _projectPanelWidth = clampPanelWidth(
        value: _projectPanelWidth - delta,
        maximum: maximumWorkspaceProjectPanelWidth(
          totalWidth: totalWidth,
          filesVisible: _filesVisible,
          filePanelWidth: _filePanelWidth,
        ),
      );
    });
    _schedulePersistWorkspaceState();
  }
}
