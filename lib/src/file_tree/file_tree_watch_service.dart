/// Directory change stream abstraction for dynamic file-tree refreshes.
///
/// Key constructs:
/// - [FileTreeWatchService]: injectable watcher contract used by the file-tree controller.
/// - [DirectoryFileTreeWatchService]: production watcher backed by `Directory.watch`.
library;

import 'dart:io';

abstract interface class FileTreeWatchService {
  Stream<void> watchDirectory(String path);
}

final class DirectoryFileTreeWatchService implements FileTreeWatchService {
  const DirectoryFileTreeWatchService();

  @override
  Stream<void> watchDirectory(String path) {
    if (path.trim().isEmpty) {
      throw ArgumentError.value(
        path,
        'path',
        'OSI_FILE_TREE_WATCH_PATH_MISSING: Не удалось следить за деревом файлов: путь папки не указан.',
      );
    }

    // Watching one loaded directory at a time keeps large repositories cheap and mirrors lazy expansion.
    return Directory(path).watch().map((_) {});
  }
}
