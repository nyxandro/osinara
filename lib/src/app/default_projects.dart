/// Default project discovery used when no persisted workspace state exists.
///
/// Key constructs:
/// - [defaultProjects]: derives initial local projects from the current working directory.
library;

import 'dart:io';

import '../projects/project_workspace.dart';

List<ProjectWorkspace> defaultProjects(String currentProjectPath) {
  final currentProjectName = _basename(currentProjectPath);
  final projects = <ProjectWorkspace>[
    ProjectWorkspace.local(
      id: currentProjectName,
      name: currentProjectName,
      path: currentProjectPath,
    ),
  ];

  // During local dogfooding Osinara can show a nearby active project without hardcoding UI state.
  final companionPath =
      '${Directory(currentProjectPath).parent.path}/r7lines-agent';
  if (companionPath != currentProjectPath &&
      Directory(companionPath).existsSync()) {
    projects.add(
      ProjectWorkspace.local(
        id: 'r7lines-agent',
        name: 'r7lines-agent',
        path: companionPath,
      ),
    );
  }

  return List.unmodifiable(projects);
}

String _basename(String path) {
  final normalized = path.endsWith(Platform.pathSeparator)
      ? path.substring(0, path.length - 1)
      : path;
  final separatorIndex = normalized.lastIndexOf(Platform.pathSeparator);
  if (separatorIndex < 0) {
    return normalized;
  }

  return normalized.substring(separatorIndex + 1);
}
