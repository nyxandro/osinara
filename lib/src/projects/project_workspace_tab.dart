/// UI tab model for one project's central workspace.
///
/// Key constructs:
/// - [ProjectWorkspaceTabKind]: distinguishes launcher, terminal, and file-viewer tabs.
/// - [ProjectWorkspaceTab]: immutable tab record selected inside a project.
library;

enum ProjectWorkspaceTabKind { launcher, terminal, file }

final class ProjectWorkspaceTab {
  const ProjectWorkspaceTab._({
    required this.id,
    required this.kind,
    this.terminalSessionId,
    this.filePath,
  });

  const ProjectWorkspaceTab.launcher({required String id})
    : this._(id: id, kind: ProjectWorkspaceTabKind.launcher);

  const ProjectWorkspaceTab.terminal({
    required String id,
    required String terminalSessionId,
  }) : this._(
         id: id,
         kind: ProjectWorkspaceTabKind.terminal,
         terminalSessionId: terminalSessionId,
       );

  const ProjectWorkspaceTab.file({required String id, required String filePath})
    : this._(id: id, kind: ProjectWorkspaceTabKind.file, filePath: filePath);

  final String id;
  final ProjectWorkspaceTabKind kind;
  final String? terminalSessionId;
  final String? filePath;

  bool get isLauncher => kind == ProjectWorkspaceTabKind.launcher;

  bool get isTerminal => kind == ProjectWorkspaceTabKind.terminal;

  bool get isFile => kind == ProjectWorkspaceTabKind.file;
}
