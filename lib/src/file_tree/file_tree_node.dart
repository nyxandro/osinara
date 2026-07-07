/// Immutable file-system node shown by the project file tree panel.
library;

final class FileTreeNode {
  const FileTreeNode({
    required this.name,
    required this.path,
    required this.isDirectory,
  });

  final String name;
  final String path;
  final bool isDirectory;
}
