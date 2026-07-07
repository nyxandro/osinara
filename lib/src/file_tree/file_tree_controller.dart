/// Stateful controller for lazy and dynamically refreshed project file trees.
///
/// Key constructs:
/// - [fileTreeRefreshDebounceDuration]: debounce window for filesystem bursts.
/// - [FileTreeController]: owns loaded children, expanded paths, loading state, and directory watchers.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'file_tree_node.dart';
import 'file_tree_reader.dart';
import 'file_tree_watch_service.dart';

const fileTreeRefreshDebounceDuration = Duration(milliseconds: 100);

final class FileTreeController extends ChangeNotifier {
  FileTreeController({
    required this.projectPath,
    required this.reader,
    required this.watchService,
  });

  final String projectPath;
  final FileTreeReader reader;
  final FileTreeWatchService watchService;
  final Map<String, List<FileTreeNode>> _childrenByPath = {};
  final Set<String> _expandedPaths = {};
  final Set<String> _loadingPaths = {};
  final Map<String, StreamSubscription<void>> _watchersByPath = {};
  final Map<String, Timer> _refreshTimersByPath = {};
  String? _errorMessage;
  var _disposed = false;

  String? get errorMessage => _errorMessage;

  bool isExpanded(String path) => _expandedPaths.contains(path);

  bool isLoading(String path) => _loadingPaths.contains(path);

  List<FileTreeNode> childrenFor(String path) {
    return _childrenByPath[path] ?? const <FileTreeNode>[];
  }

  Future<void> start() {
    return _loadChildren(projectPath);
  }

  Future<void> toggleDirectory(FileTreeNode node) async {
    if (!node.isDirectory) {
      return;
    }

    // Expansion state is independent from loading, so the UI can rotate the glyph immediately.
    if (_expandedPaths.contains(node.path)) {
      _expandedPaths.remove(node.path);
      notifyListeners();
      return;
    }

    _expandedPaths.add(node.path);
    notifyListeners();
    await _loadChildren(node.path);
  }

  @override
  void dispose() {
    _disposed = true;
    for (final timer in _refreshTimersByPath.values) {
      timer.cancel();
    }
    for (final watcher in _watchersByPath.values) {
      unawaited(watcher.cancel());
    }
    super.dispose();
  }

  Future<void> _loadChildren(String path, {bool force = false}) async {
    if (_disposed || _loadingPaths.contains(path)) {
      return;
    }
    if (!force && _childrenByPath.containsKey(path)) {
      return;
    }

    _loadingPaths.add(path);
    notifyListeners();

    try {
      final children = await reader.listDirectory(path);
      if (_disposed) {
        return;
      }

      _childrenByPath[path] = children;
      _errorMessage = null;
      _watchLoadedDirectory(path);
    } on Object {
      if (!_disposed) {
        _errorMessage =
            'OSI_FILE_TREE_READ_FAILED: Не удалось прочитать дерево файлов проекта. Проверьте доступ к папке проекта.';
      }
    } finally {
      if (!_disposed) {
        _loadingPaths.remove(path);
        notifyListeners();
      }
    }
  }

  void _watchLoadedDirectory(String path) {
    if (_watchersByPath.containsKey(path)) {
      return;
    }

    try {
      _watchersByPath[path] = watchService
          .watchDirectory(path)
          .listen(
            (_) => _scheduleRefresh(path),
            onError: (_) => _markWatchFailed(),
          );
    } on Object {
      _markWatchFailed();
    }
  }

  void _scheduleRefresh(String path) {
    _refreshTimersByPath[path]?.cancel();
    _refreshTimersByPath[path] = Timer(fileTreeRefreshDebounceDuration, () {
      _refreshTimersByPath.remove(path);
      unawaited(_loadChildren(path, force: true));
    });
  }

  void _markWatchFailed() {
    if (_disposed) {
      return;
    }

    _errorMessage =
        'OSI_FILE_TREE_WATCH_FAILED: Не удалось следить за изменениями файлов проекта. Обновите проект вручную или перезапустите приложение.';
    notifyListeners();
  }
}
