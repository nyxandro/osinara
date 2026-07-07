/// Debounced persistence controller for the desktop workspace snapshot.
///
/// Key constructs:
/// - [WorkspacePersistenceController]: restores and saves projects, tabs, and panel layout.
/// - [RestoredWorkspaceState]: restored store plus panel layout returned to the shell.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../embedded_terminal/embedded_terminal_session_store.dart';
import '../launch_profiles/launch_profile.dart';
import '../projects/project_workspace.dart';
import '../projects/project_workspace_store.dart';
import '../projects/project_workspace_tab.dart';
import '../settings/workspace_state.dart';
import '../settings/workspace_state_store.dart';

const workspacePersistenceDebounceDuration = Duration(milliseconds: 200);
const _obsoleteGitAuthAgentNames = {
  'GitHub authentication',
  'GitLab authentication',
};

final class RestoredWorkspaceState {
  const RestoredWorkspaceState({
    required this.workspace,
    required this.panelState,
  });

  final ProjectWorkspaceStore workspace;
  final WorkspacePanelState panelState;
}

final class WorkspacePersistenceController {
  WorkspacePersistenceController({required this.repository});

  final WorkspaceStateRepository repository;
  Timer? _saveTimer;
  var _readyForWrites = false;

  Future<RestoredWorkspaceState?> restore({
    required EmbeddedTerminalSessionStore terminalSessions,
    required Map<String, String> environment,
  }) async {
    try {
      final snapshot = await repository.read();
      if (snapshot == null) {
        return null;
      }

      return RestoredWorkspaceState(
        workspace: await _workspaceFromSnapshot(
          snapshot: snapshot,
          terminalSessions: terminalSessions,
          environment: environment,
        ),
        panelState: snapshot.panelState,
      );
    } on Object catch (error) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          library: 'osinara workspace persistence',
          context: ErrorDescription('loading persisted workspace state'),
        ),
      );
      return null;
    } finally {
      _readyForWrites = true;
    }
  }

  void scheduleSave({
    required ProjectWorkspaceStore workspace,
    required WorkspacePanelState panelState,
  }) {
    if (!_readyForWrites) {
      return;
    }

    // Coalesce high-frequency panel drags and tab changes into one disk write.
    _saveTimer?.cancel();
    _saveTimer = Timer(workspacePersistenceDebounceDuration, () {
      unawaited(saveNow(workspace: workspace, panelState: panelState));
    });
  }

  Future<void> saveNow({
    required ProjectWorkspaceStore workspace,
    required WorkspacePanelState panelState,
  }) async {
    if (!_readyForWrites) {
      return;
    }

    _saveTimer?.cancel();
    await _writeSnapshot(
      WorkspaceStateSnapshot(
        projects: workspace.projects,
        selectedProjectId: workspace.selectedProjectId,
        tabsByProjectId: workspace.serializableTabsByProjectId(),
        selectedTabByProjectId: workspace.selectedTabByProjectId,
        panelState: panelState,
      ),
    );
  }

  void dispose() {
    _saveTimer?.cancel();
  }

  Future<ProjectWorkspaceStore> _workspaceFromSnapshot({
    required WorkspaceStateSnapshot snapshot,
    required EmbeddedTerminalSessionStore terminalSessions,
    required Map<String, String> environment,
  }) async {
    final projectsById = {
      for (final project in snapshot.projects) project.id: project,
    };
    final restoredTabs = <String, List<ProjectWorkspaceTab>>{};
    final selectedTabByProjectId = Map<String, String>.of(
      snapshot.selectedTabByProjectId,
    );

    // Terminal tabs are restored as inactive terminal sessions because PTY processes cannot survive app restarts.
    for (final entry in snapshot.tabsByProjectId.entries) {
      final project = projectsById[entry.key];
      if (project == null) {
        throw StateError(
          'OSI_WORKSPACE_TAB_PROJECT_MISSING: Не удалось восстановить workspace: вкладки ссылаются на отсутствующий проект.',
        );
      }

      final tabs = <ProjectWorkspaceTab>[];
      for (final tabState in entry.value) {
        final tab = await _restoreTab(
          project: project,
          tabState: tabState,
          terminalSessions: terminalSessions,
          environment: environment,
        );
        if (tab != null) {
          tabs.add(tab);
        }
      }
      final selectedTabId = selectedTabByProjectId[entry.key];
      if (selectedTabId != null &&
          !tabs.any((tab) => tab.id == selectedTabId)) {
        selectedTabByProjectId.remove(entry.key);
      }
      restoredTabs[entry.key] = List.unmodifiable(tabs);
    }

    return ProjectWorkspaceStore(
      projects: snapshot.projects,
      selectedProjectId: snapshot.selectedProjectId,
      terminalSessions: terminalSessions,
      initialTabsByProjectId: restoredTabs,
      initialSelectedTabByProjectId: selectedTabByProjectId,
    );
  }

  Future<ProjectWorkspaceTab?> _restoreTab({
    required ProjectWorkspace project,
    required WorkspaceTabState tabState,
    required EmbeddedTerminalSessionStore terminalSessions,
    required Map<String, String> environment,
  }) async {
    return switch (tabState.kind) {
      ProjectWorkspaceTabKind.launcher => ProjectWorkspaceTab.launcher(
        id: tabState.id,
      ),
      ProjectWorkspaceTabKind.file => ProjectWorkspaceTab.file(
        id: tabState.id,
        filePath: _requiredFilePath(tabState),
      ),
      ProjectWorkspaceTabKind.terminal => await _restoreTerminalTab(
        project: project,
        tabState: tabState,
        terminalSessions: terminalSessions,
        environment: environment,
      ),
    };
  }

  Future<ProjectWorkspaceTab?> _restoreTerminalTab({
    required ProjectWorkspace project,
    required WorkspaceTabState tabState,
    required EmbeddedTerminalSessionStore terminalSessions,
    required Map<String, String> environment,
  }) async {
    if (_isObsoleteGitAuthTerminalTab(tabState)) {
      return null;
    }

    await terminalSessions.restoreRestarted(
      id: _requiredTerminalSessionId(tabState),
      projectName: project.name,
      projectPath: project.path,
      profile: _requiredTerminalProfile(tabState),
      environment: environment,
      title: tabState.terminalSessionTitle,
    );

    return ProjectWorkspaceTab.terminal(
      id: tabState.id,
      terminalSessionId: _requiredTerminalSessionId(tabState),
    );
  }

  bool _isObsoleteGitAuthTerminalTab(WorkspaceTabState tabState) {
    final profile = tabState.terminalProfile;

    // The old Settings auth flow created terminal tabs; new auth uses a dialog and must not restart them.
    return profile != null &&
        _obsoleteGitAuthAgentNames.contains(profile.agentName);
  }

  String _requiredFilePath(WorkspaceTabState tabState) {
    final filePath = tabState.filePath;
    if (filePath != null) {
      return filePath;
    }

    throw StateError(
      'OSI_WORKSPACE_FILE_TAB_INVALID: Не удалось восстановить workspace: вкладка файла не содержит путь.',
    );
  }

  String _requiredTerminalSessionId(WorkspaceTabState tabState) {
    final sessionId = tabState.terminalSessionId;
    if (sessionId != null) {
      return sessionId;
    }

    throw StateError(
      'OSI_WORKSPACE_TERMINAL_TAB_SESSION_INVALID: Не удалось восстановить workspace: вкладка терминала не содержит session id.',
    );
  }

  LaunchProfile _requiredTerminalProfile(WorkspaceTabState tabState) {
    final profile = tabState.terminalProfile;
    if (profile != null) {
      return profile;
    }

    throw StateError(
      'OSI_WORKSPACE_TERMINAL_TAB_PROFILE_INVALID: Не удалось восстановить workspace: вкладка терминала не содержит профиль запуска.',
    );
  }

  Future<void> _writeSnapshot(WorkspaceStateSnapshot snapshot) async {
    try {
      await repository.write(snapshot);
    } on Object catch (error) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          library: 'osinara workspace persistence',
          context: ErrorDescription('saving workspace state'),
        ),
      );
    }
  }
}
