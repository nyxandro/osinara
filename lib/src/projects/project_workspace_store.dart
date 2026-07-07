/// Project-level workspace state with selected project and central tabs.
///
/// Key constructs:
/// - [ProjectWorkspaceStore]: coordinates selected project, launcher tabs, terminal tabs, and PTY sessions.
library;

import 'package:flutter/foundation.dart';

import '../embedded_terminal/embedded_terminal_session.dart';
import '../embedded_terminal/embedded_terminal_session_store.dart';
import '../launch_profiles/launch_profile.dart';
import '../settings/workspace_state.dart';
import 'project_workspace.dart';
import 'project_workspace_tab.dart';
import 'project_workspace_tab_ids.dart';
import 'project_workspace_tab_state_mapper.dart';

final class ProjectWorkspaceStore extends ChangeNotifier {
  ProjectWorkspaceStore({
    required List<ProjectWorkspace> projects,
    required this.terminalSessions,
    String? selectedProjectId,
    Map<String, List<ProjectWorkspaceTab>>? initialTabsByProjectId,
    Map<String, String>? initialSelectedTabByProjectId,
  }) : _projects = List.of(projects) {
    if (_projects.isEmpty) {
      throw StateError(
        'OSI_PROJECTS_MISSING: Не удалось открыть рабочую область: список проектов пуст.',
      );
    }

    final initialProjectId = selectedProjectId ?? _projects.first.id;
    if (!_projects.any((project) => project.id == initialProjectId)) {
      throw StateError(
        'OSI_SELECTED_PROJECT_NOT_FOUND: Не удалось открыть проект: выбранный проект отсутствует в списке проектов.',
      );
    }

    // Each project always has a launcher tab, so switching projects never leaves an empty center pane.
    _selectedProjectId = initialProjectId;
    if (initialTabsByProjectId != null) {
      for (final entry in initialTabsByProjectId.entries) {
        _projectById(entry.key);
        _tabsByProjectId[entry.key] = List.of(entry.value);
      }
    }
    if (initialSelectedTabByProjectId != null) {
      _selectedTabByProjectId.addAll(initialSelectedTabByProjectId);
    }
    for (final project in _projects) {
      _ensureLauncherTab(project.id);
      _ensureSelectedTabExists(project.id);
    }
    _nextTabOrdinal = highestWorkspaceTabOrdinal(_tabsByProjectId.values);
    terminalSessions.addListener(_handleTerminalSessionsChanged);
  }

  final EmbeddedTerminalSessionStore terminalSessions;
  final List<ProjectWorkspace> _projects;
  final Map<String, List<ProjectWorkspaceTab>> _tabsByProjectId = {};
  final Map<String, String> _selectedTabByProjectId = {};
  var _nextTabOrdinal = 0;
  var _disposed = false;
  late String _selectedProjectId;

  List<ProjectWorkspace> get projects => List.unmodifiable(_projects);

  String get selectedProjectId => _selectedProjectId;

  Map<String, String> get selectedTabByProjectId {
    return Map.unmodifiable(_selectedTabByProjectId);
  }

  Map<String, List<ProjectWorkspaceTab>> get tabsByProjectId {
    return Map.unmodifiable(
      _tabsByProjectId.map(
        (projectId, tabs) => MapEntry(projectId, List.unmodifiable(tabs)),
      ),
    );
  }

  ProjectWorkspace get selectedProject => _projectById(_selectedProjectId);

  List<ProjectWorkspaceTab> get selectedProjectTabs {
    return List.unmodifiable(_tabsForProjectId(_selectedProjectId));
  }

  ProjectWorkspaceTab get selectedTab {
    final tabs = _tabsForProjectId(_selectedProjectId);
    final selectedTabId = _selectedTabByProjectId[_selectedProjectId];
    for (final tab in tabs) {
      if (tab.id == selectedTabId) {
        return tab;
      }
    }

    throw StateError(
      'OSI_SELECTED_TAB_NOT_FOUND: Не удалось открыть вкладку: выбранная вкладка отсутствует в проекте.',
    );
  }

  bool get selectedProjectHasContentTabs {
    return _tabsForProjectId(_selectedProjectId).any((tab) => !tab.isLauncher);
  }

  List<EmbeddedTerminalSession> sessionsForProject(ProjectWorkspace project) {
    return terminalSessions.sessions
        .where((session) => session.projectPath == project.path)
        .toList(growable: false);
  }

  EmbeddedTerminalSession? terminalSessionForTab(ProjectWorkspaceTab tab) {
    final sessionId = tab.terminalSessionId;
    if (sessionId == null) {
      return null;
    }

    return terminalSessions.sessionById(sessionId);
  }

  Map<String, List<WorkspaceTabState>> serializableTabsByProjectId() {
    return serializableWorkspaceTabsByProjectId(
      tabsByProjectId: _tabsByProjectId,
      terminalSessionForTab: terminalSessionForTab,
    );
  }

  bool isProjectSelected(ProjectWorkspace project) {
    return project.id == _selectedProjectId;
  }

  bool isTerminalSessionSelected(EmbeddedTerminalSession session) {
    final tab = selectedTab;
    return tab.isTerminal && tab.terminalSessionId == session.id;
  }

  void selectProject(String projectId) {
    _projectById(projectId);
    _selectedProjectId = projectId;
    _syncTerminalSelectionToSelectedTab();
    notifyListeners();
  }

  void selectTab(String tabId) {
    final tabs = _tabsForProjectId(_selectedProjectId);
    final tabExists = tabs.any((tab) => tab.id == tabId);
    if (!tabExists) {
      return;
    }

    _selectedTabByProjectId[_selectedProjectId] = tabId;
    _syncTerminalSelectionToSelectedTab();
    notifyListeners();
  }

  void openLauncherTab() {
    final tab = ProjectWorkspaceTab.launcher(id: _newTabId());
    _tabsForProjectId(_selectedProjectId).add(tab);
    _selectedTabByProjectId[_selectedProjectId] = tab.id;
    notifyListeners();
  }

  void openFile(String filePath) {
    if (filePath.trim().isEmpty) {
      throw ArgumentError.value(
        filePath,
        'filePath',
        'OSI_FILE_TAB_PATH_MISSING: Не удалось открыть файл: путь к файлу не указан.',
      );
    }

    final tabs = _tabsForProjectId(_selectedProjectId);
    for (final tab in tabs) {
      if (tab.isFile && tab.filePath == filePath) {
        _selectedTabByProjectId[_selectedProjectId] = tab.id;
        notifyListeners();
        return;
      }
    }

    final tab = ProjectWorkspaceTab.file(id: _newTabId(), filePath: filePath);
    tabs.add(tab);
    _selectedTabByProjectId[_selectedProjectId] = tab.id;
    notifyListeners();
  }

  ProjectWorkspace addProject(ProjectWorkspace project) {
    if (_projects.any((candidate) => candidate.id == project.id)) {
      throw StateError(
        'OSI_PROJECT_ALREADY_EXISTS: Не удалось добавить проект: проект с таким идентификатором уже есть в списке.',
      );
    }

    _projects.insert(0, project);
    _ensureLauncherTab(project.id);
    _selectedProjectId = project.id;
    notifyListeners();
    return project;
  }

  void updateProject(
    String projectId, {
    required String name,
    required String path,
    required String iconName,
  }) {
    final index = _projects.indexWhere((project) => project.id == projectId);
    if (index < 0) {
      throw StateError(
        'OSI_PROJECT_NOT_FOUND: Не удалось обновить проект: проект отсутствует в рабочей области.',
      );
    }

    final currentProject = _projects[index];
    if (currentProject.path != path) {
      for (final session in sessionsForProject(currentProject)) {
        terminalSessions.closeSession(session.id);
      }
    }

    _projects[index] = currentProject.copyWith(
      name: name,
      path: path,
      iconName: iconName,
    );
    notifyListeners();
  }

  void removeProject(String projectId) {
    final index = _projects.indexWhere((project) => project.id == projectId);
    if (index < 0) {
      return;
    }
    if (_projects.length == 1) {
      throw StateError(
        'OSI_LAST_PROJECT_REMOVE_FORBIDDEN: Нельзя удалить последний проект из списка. Добавьте другой проект перед удалением.',
      );
    }

    final removed = _projects.removeAt(index);
    _tabsByProjectId.remove(removed.id);
    _selectedTabByProjectId.remove(removed.id);
    for (final session in sessionsForProject(removed)) {
      terminalSessions.closeSession(session.id);
    }

    if (_selectedProjectId == removed.id) {
      final nextIndex = index.clamp(0, _projects.length - 1);
      _selectedProjectId = _projects[nextIndex].id;
      _ensureLauncherTab(_selectedProjectId);
    }

    _syncTerminalSelectionToSelectedTab();
    notifyListeners();
  }

  Future<EmbeddedTerminalSession> launchProfileInSelectedTab({
    required LaunchProfile profile,
    required Map<String, String> environment,
  }) async {
    final project = selectedProject;
    final tab = selectedTab;
    if (!tab.isLauncher) {
      throw StateError(
        'OSI_WORKSPACE_TAB_NOT_LAUNCHER: Не удалось запустить агента: текущая вкладка уже занята терминалом.',
      );
    }

    // A launch consumes the current launcher tab and turns it into a terminal tab.
    final session = await _startTerminalSession(
      project: project,
      profile: profile,
      environment: environment,
    );
    final tabs = _tabsForProjectId(project.id);
    final tabIndex = tabs.indexWhere((candidate) => candidate.id == tab.id);
    if (tabIndex < 0) {
      throw StateError(
        'OSI_WORKSPACE_TAB_LOST: Не удалось открыть терминал: вкладка запуска была закрыта во время старта.',
      );
    }

    tabs[tabIndex] = ProjectWorkspaceTab.terminal(
      id: tab.id,
      terminalSessionId: session.id,
    );
    _selectedTabByProjectId[project.id] = tab.id;
    terminalSessions.selectSession(session.id);
    notifyListeners();
    return session;
  }

  void selectTerminalSession(String sessionId) {
    final session = terminalSessions.sessionById(sessionId);
    if (session == null) {
      return;
    }

    final project = _projectByPath(session.projectPath);
    if (project == null) {
      return;
    }

    final tabs = _tabsForProjectId(project.id);
    for (final tab in tabs) {
      if (tab.terminalSessionId == session.id) {
        _selectedProjectId = project.id;
        _selectedTabByProjectId[project.id] = tab.id;
        terminalSessions.selectSession(session.id);
        notifyListeners();
        return;
      }
    }
  }

  void closeSelectedProjectTab(String tabId) {
    final tabs = _tabsForProjectId(_selectedProjectId);
    final index = tabs.indexWhere((tab) => tab.id == tabId);
    if (index < 0) {
      return;
    }

    final removedTab = tabs.removeAt(index);
    if (tabs.isEmpty) {
      _ensureLauncherTab(_selectedProjectId);
    } else if (_selectedTabByProjectId[_selectedProjectId] == removedTab.id) {
      final nextIndex = index.clamp(0, tabs.length - 1);
      _selectedTabByProjectId[_selectedProjectId] = tabs[nextIndex].id;
    }

    // The UI tab is removed before killing the process so listeners never render a stale session reference.
    final removedSessionId = removedTab.terminalSessionId;
    if (removedSessionId != null) {
      terminalSessions.closeSession(removedSessionId);
    }

    _syncTerminalSelectionToSelectedTab();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    terminalSessions.removeListener(_handleTerminalSessionsChanged);
    super.dispose();
  }

  List<ProjectWorkspaceTab> _tabsForProjectId(String projectId) {
    return _tabsByProjectId.putIfAbsent(
      projectId,
      () => <ProjectWorkspaceTab>[],
    );
  }

  void _ensureLauncherTab(String projectId) {
    final tabs = _tabsForProjectId(projectId);
    if (tabs.isNotEmpty) {
      _selectedTabByProjectId.putIfAbsent(projectId, () => tabs.first.id);
      return;
    }

    final tab = ProjectWorkspaceTab.launcher(id: _newTabId());
    tabs.add(tab);
    _selectedTabByProjectId[projectId] = tab.id;
  }

  void _ensureSelectedTabExists(String projectId) {
    final tabs = _tabsForProjectId(projectId);
    final selectedTabId = _selectedTabByProjectId[projectId];
    if (selectedTabId == null) {
      _selectedTabByProjectId[projectId] = tabs.first.id;
      return;
    }

    if (tabs.any((tab) => tab.id == selectedTabId)) {
      return;
    }

    throw StateError(
      'OSI_SELECTED_TAB_INVALID: Не удалось восстановить workspace: выбранная вкладка отсутствует в проекте.',
    );
  }

  void _syncTerminalSelectionToSelectedTab() {
    final tab = selectedTab;
    final sessionId = tab.terminalSessionId;
    if (sessionId != null) {
      terminalSessions.selectSession(sessionId);
    }
  }

  Future<EmbeddedTerminalSession> _startTerminalSession({
    required ProjectWorkspace project,
    required LaunchProfile profile,
    required Map<String, String> environment,
  }) {
    return terminalSessions.launch(
      profile: profile,
      projectName: project.name,
      projectPath: project.path,
      environment: environment,
    );
  }

  ProjectWorkspace _projectById(String projectId) {
    for (final project in _projects) {
      if (project.id == projectId) {
        return project;
      }
    }

    throw StateError(
      'OSI_PROJECT_NOT_FOUND: Не удалось выбрать проект: проект отсутствует в рабочей области.',
    );
  }

  ProjectWorkspace? _projectByPath(String projectPath) {
    for (final project in _projects) {
      if (project.path == projectPath) {
        return project;
      }
    }

    return null;
  }

  void _handleTerminalSessionsChanged() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  String _newTabId() {
    _nextTabOrdinal += 1;
    return workspaceTabId(_nextTabOrdinal);
  }
}
