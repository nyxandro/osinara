/// Bounded project source discovery for the add-project dialog.
///
/// Key constructs:
/// - [defaultProjectCandidateLimit]: hard cap for one-level folder discovery.
/// - [ProjectCandidateDiscovery]: discovers local/current-WSL project candidates without recursion.
library;

import 'dart:io';

import 'project_candidate.dart';
import 'project_location.dart';

const defaultProjectCandidateLimit = 80;

final class ProjectCandidateDiscovery {
  const ProjectCandidateDiscovery({this.limit = defaultProjectCandidateLimit});

  final int limit;

  List<ProjectCandidateSection> discover({required String currentProjectPath}) {
    final root = _projectRoot(currentProjectPath);
    final candidates = _listChildDirectories(root);
    final wslDistro = Platform.environment['WSL_DISTRO_NAME'];
    final sectionTitle = wslDistro == null || wslDistro.trim().isEmpty
        ? 'Local'
        : 'WSL: $wslDistro';

    return [
      ProjectCandidateSection(
        id: wslDistro == null ? 'local' : 'wsl-$wslDistro',
        title: sectionTitle,
        candidates: candidates
            .map((directory) {
              final name = _basename(directory.path);
              final location = wslDistro == null || wslDistro.trim().isEmpty
                  ? ProjectLocation.local(path: directory.path)
                  : ProjectLocation.wsl(
                      distro: wslDistro,
                      path: directory.path,
                    );
              return ProjectCandidate(
                id: _candidateId(location, name),
                name: name,
                location: location,
                subtitle: directory.path,
              );
            })
            .toList(growable: false),
      ),
    ];
  }

  Directory _projectRoot(String currentProjectPath) {
    final home = Platform.environment['HOME'];
    if (home != null && home.trim().isNotEmpty) {
      final projects = Directory('$home/projects');
      if (projects.existsSync()) {
        return projects;
      }
    }

    return Directory(currentProjectPath).parent;
  }

  List<Directory> _listChildDirectories(Directory root) {
    if (!root.existsSync()) {
      return const <Directory>[];
    }

    final directories = <Directory>[];
    for (final entity in root.listSync(followLinks: false)) {
      if (entity is Directory) {
        directories.add(entity);
      }
      if (directories.length >= limit) {
        break;
      }
    }
    directories.sort(
      (left, right) => _basename(
        left.path,
      ).toLowerCase().compareTo(_basename(right.path).toLowerCase()),
    );
    return List.unmodifiable(directories);
  }
}

String _candidateId(ProjectLocation location, String name) {
  return '${location.kind.name}-$name-${location.path.hashCode.abs()}';
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
