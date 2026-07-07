/// Candidate project entries shown by the add-project dialog.
///
/// Key constructs:
/// - [ProjectCandidate]: selectable local/WSL/SSH folder entry.
/// - [ProjectCandidateSection]: grouped source section similar to Zed's project picker.
library;

import 'project_location.dart';
import 'project_workspace.dart';

final class ProjectCandidate {
  const ProjectCandidate({
    required this.id,
    required this.name,
    required this.location,
    this.subtitle,
  });

  final String id;
  final String name;
  final ProjectLocation location;
  final String? subtitle;

  ProjectWorkspace toWorkspace({String iconName = defaultProjectIconName}) {
    return switch (location.kind) {
      ProjectLocationKind.local => ProjectWorkspace.local(
        id: id,
        name: name,
        path: location.path,
        iconName: iconName,
      ),
      ProjectLocationKind.wsl => ProjectWorkspace.wsl(
        id: id,
        name: name,
        distro: location.wslDistro!,
        path: location.path,
        iconName: iconName,
      ),
      ProjectLocationKind.ssh => ProjectWorkspace.ssh(
        id: id,
        name: name,
        host: location.sshHost!,
        path: location.path,
        iconName: iconName,
      ),
    };
  }
}

final class ProjectCandidateSection {
  const ProjectCandidateSection({
    required this.id,
    required this.title,
    required this.candidates,
  });

  final String id;
  final String title;
  final List<ProjectCandidate> candidates;
}
