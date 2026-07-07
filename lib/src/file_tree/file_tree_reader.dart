/// Safe one-level directory reader for the project file tree panel.
///
/// Key constructs:
/// - [FileTreeReader]: overridable one-level reader used by the file-tree controller.
library;

import 'dart:io';

import 'file_tree_node.dart';

const defaultFileTreeChildLimit = 400;

class FileTreeReader {
  const FileTreeReader({this.childLimit = defaultFileTreeChildLimit});

  final int childLimit;

  Future<List<FileTreeNode>> listDirectory(String path) async {
    if (path.trim().isEmpty) {
      throw ArgumentError.value(
        path,
        'path',
        'OSI_FILE_TREE_PATH_MISSING: Не удалось прочитать дерево файлов: путь проекта не указан.',
      );
    }

    final directory = Directory(path);
    if (!await directory.exists()) {
      throw StateError(
        'OSI_FILE_TREE_PATH_NOT_FOUND: Не удалось прочитать дерево файлов: папка проекта не найдена.',
      );
    }

    final nodes = <FileTreeNode>[];

    // list() does not recurse, so the UI can lazy-load directories without scanning huge trees.
    await for (final entity in directory.list(followLinks: false)) {
      final type = await FileSystemEntity.type(entity.path, followLinks: false);
      if (type == FileSystemEntityType.link ||
          type == FileSystemEntityType.notFound) {
        continue;
      }

      nodes.add(
        FileTreeNode(
          name: _entityName(entity.path),
          path: entity.path,
          isDirectory: type == FileSystemEntityType.directory,
        ),
      );
    }

    nodes.sort(_compareNodes);
    return List.unmodifiable(nodes.take(childLimit));
  }

  int _compareNodes(FileTreeNode left, FileTreeNode right) {
    if (left.isDirectory != right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return left.name.toLowerCase().compareTo(right.name.toLowerCase());
  }

  String _entityName(String path) {
    final normalized = path.endsWith(Platform.pathSeparator)
        ? path.substring(0, path.length - 1)
        : path;
    final index = normalized.lastIndexOf(Platform.pathSeparator);
    if (index < 0) {
      return normalized;
    }

    return normalized.substring(index + 1);
  }
}
