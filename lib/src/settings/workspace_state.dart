/// Persistent workspace state for projects, tabs, and panel layout.
///
/// Key constructs:
/// - [WorkspacePanelState]: side panel visibility, left panel mode, and widths.
/// - [WorkspaceTabState]: serializable launcher/terminal/file tab record with optional session title.
/// - [WorkspaceStateSnapshot]: full app workspace snapshot stored between launches.
library;

import '../launch_profiles/launch_profile.dart';
import '../projects/project_workspace.dart';
import '../projects/project_workspace_tab.dart';

const workspaceStateVersion = 1;

final class WorkspacePanelState {
  const WorkspacePanelState({
    required this.filesVisible,
    required this.gitVisible,
    required this.centerVisible,
    required this.projectsVisible,
    required this.filePanelWidth,
    required this.projectPanelWidth,
  });

  final bool filesVisible;
  final bool gitVisible;
  final bool centerVisible;
  final bool projectsVisible;
  final double filePanelWidth;
  final double projectPanelWidth;

  Map<String, Object?> toJson() {
    return {
      'filesVisible': filesVisible,
      'gitVisible': gitVisible,
      'centerVisible': centerVisible,
      'projectsVisible': projectsVisible,
      'filePanelWidth': filePanelWidth,
      'projectPanelWidth': projectPanelWidth,
    };
  }

  static WorkspacePanelState fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_WORKSPACE_PANEL_STATE_INVALID: Не удалось загрузить состояние панелей: формат неверный.',
      );
    }

    return WorkspacePanelState(
      filesVisible: _requiredBool(json, 'filesVisible'),
      gitVisible: _optionalBool(json, 'gitVisible') ?? false,
      centerVisible: _requiredBool(json, 'centerVisible'),
      projectsVisible: _requiredBool(json, 'projectsVisible'),
      filePanelWidth: _requiredDouble(json, 'filePanelWidth'),
      projectPanelWidth: _requiredDouble(json, 'projectPanelWidth'),
    );
  }
}

final class WorkspaceTabState {
  const WorkspaceTabState({
    required this.id,
    required this.kind,
    this.filePath,
    this.terminalSessionId,
    this.terminalProfile,
    this.terminalSessionTitle,
  });

  final String id;
  final ProjectWorkspaceTabKind kind;
  final String? filePath;
  final String? terminalSessionId;
  final LaunchProfile? terminalProfile;
  final String? terminalSessionTitle;

  Map<String, Object?> toJson() {
    return {
      'id': id,
      'kind': kind.name,
      'filePath': filePath,
      'terminalSessionId': terminalSessionId,
      'terminalProfile': terminalProfile?.toJson(),
      'terminalSessionTitle': terminalSessionTitle,
    };
  }

  static WorkspaceTabState fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_WORKSPACE_TAB_STATE_INVALID: Не удалось загрузить вкладку: формат неверный.',
      );
    }

    final kind = _requiredString(json, 'kind');
    final tabKind = switch (kind) {
      'launcher' => ProjectWorkspaceTabKind.launcher,
      'terminal' => ProjectWorkspaceTabKind.terminal,
      'file' => ProjectWorkspaceTabKind.file,
      _ => throw StateError(
        'OSI_WORKSPACE_TAB_KIND_INVALID: Не удалось загрузить вкладку: тип вкладки не поддерживается.',
      ),
    };

    final id = _requiredString(json, 'id');
    return switch (tabKind) {
      ProjectWorkspaceTabKind.launcher => WorkspaceTabState(
        id: id,
        kind: tabKind,
      ),
      ProjectWorkspaceTabKind.file => WorkspaceTabState(
        id: id,
        kind: tabKind,
        filePath: _requiredString(json, 'filePath'),
      ),
      ProjectWorkspaceTabKind.terminal => WorkspaceTabState(
        id: id,
        kind: tabKind,
        terminalSessionId: _requiredString(json, 'terminalSessionId'),
        terminalProfile: LaunchProfile.fromJson(json['terminalProfile']),
        terminalSessionTitle: _optionalString(json, 'terminalSessionTitle'),
      ),
    };
  }
}

final class WorkspaceStateSnapshot {
  const WorkspaceStateSnapshot({
    required this.projects,
    required this.selectedProjectId,
    required this.tabsByProjectId,
    required this.selectedTabByProjectId,
    required this.panelState,
  });

  final List<ProjectWorkspace> projects;
  final String selectedProjectId;
  final Map<String, List<WorkspaceTabState>> tabsByProjectId;
  final Map<String, String> selectedTabByProjectId;
  final WorkspacePanelState panelState;

  Map<String, Object?> toJson() {
    return {
      'version': workspaceStateVersion,
      'projects': projects.map((project) => project.toJson()).toList(),
      'selectedProjectId': selectedProjectId,
      'tabsByProjectId': tabsByProjectId.map(
        (projectId, tabs) =>
            MapEntry(projectId, tabs.map((tab) => tab.toJson()).toList()),
      ),
      'selectedTabByProjectId': selectedTabByProjectId,
      'panelState': panelState.toJson(),
    };
  }

  static WorkspaceStateSnapshot fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_WORKSPACE_STATE_INVALID: Не удалось загрузить состояние workspace: формат неверный.',
      );
    }

    _validateVersion(json['version']);

    final projects = _requiredList(
      json,
      'projects',
    ).map(ProjectWorkspace.fromJson).toList(growable: false);
    if (projects.isEmpty) {
      throw StateError(
        'OSI_WORKSPACE_STATE_PROJECTS_EMPTY: Не удалось загрузить состояние workspace: список проектов пуст.',
      );
    }

    return WorkspaceStateSnapshot(
      projects: projects,
      selectedProjectId: _requiredString(json, 'selectedProjectId'),
      tabsByProjectId: _tabsByProjectId(json['tabsByProjectId']),
      selectedTabByProjectId: _stringMap(json['selectedTabByProjectId']),
      panelState: WorkspacePanelState.fromJson(json['panelState']),
    );
  }
}

void _validateVersion(Object? value) {
  if (value == workspaceStateVersion) {
    return;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_VERSION_INVALID: Не удалось загрузить состояние workspace: версия файла не поддерживается.',
  );
}

List<Object?> _requiredList(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is List<Object?>) {
    return value;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_LIST_INVALID: Не удалось загрузить workspace: поле $key имеет неверный формат.',
  );
}

Map<String, List<WorkspaceTabState>> _tabsByProjectId(Object? value) {
  if (value is! Map<String, Object?>) {
    throw StateError(
      'OSI_WORKSPACE_TABS_INVALID: Не удалось загрузить вкладки workspace: формат неверный.',
    );
  }

  return value.map((projectId, rawTabs) {
    if (rawTabs is! List<Object?>) {
      throw StateError(
        'OSI_WORKSPACE_PROJECT_TABS_INVALID: Не удалось загрузить вкладки проекта: формат неверный.',
      );
    }

    return MapEntry(
      projectId,
      rawTabs.map(WorkspaceTabState.fromJson).toList(growable: false),
    );
  });
}

Map<String, String> _stringMap(Object? value) {
  if (value is! Map<String, Object?>) {
    throw StateError(
      'OSI_WORKSPACE_STRING_MAP_INVALID: Не удалось загрузить workspace: map имеет неверный формат.',
    );
  }

  return value.map((key, rawValue) {
    if (rawValue is String && rawValue.trim().isNotEmpty) {
      return MapEntry(key, rawValue);
    }

    throw StateError(
      'OSI_WORKSPACE_STRING_MAP_VALUE_INVALID: Не удалось загрузить workspace: значение map имеет неверный формат.',
    );
  });
}

String _requiredString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_FIELD_INVALID: Не удалось загрузить workspace: поле $key отсутствует или имеет неверный формат.',
  );
}

String? _optionalString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value == null) {
    return null;
  }
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_OPTIONAL_STRING_INVALID: Не удалось загрузить workspace: поле $key имеет неверный формат.',
  );
}

bool _requiredBool(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is bool) {
    return value;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_BOOL_INVALID: Не удалось загрузить workspace: поле $key должно быть boolean.',
  );
}

bool? _optionalBool(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value == null) {
    return null;
  }
  if (value is bool) {
    return value;
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_OPTIONAL_BOOL_INVALID: Не удалось загрузить workspace: поле $key должно быть boolean.',
  );
}

double _requiredDouble(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is num) {
    return value.toDouble();
  }

  throw StateError(
    'OSI_WORKSPACE_STATE_NUMBER_INVALID: Не удалось загрузить workspace: поле $key должно быть числом.',
  );
}
