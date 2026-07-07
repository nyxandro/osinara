import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/file_tree/file_tree_controller.dart';
import 'package:osinara/src/file_tree/file_tree_reader.dart';
import 'package:osinara/src/file_tree/file_tree_watch_service.dart';

void main() {
  test(
    'FileTreeController refreshes a loaded directory after watch events',
    () async {
      final root = await Directory.systemTemp.createTemp('osinara-tree-');
      final watchService = _FakeFileTreeWatchService();
      final controller = FileTreeController(
        projectPath: root.path,
        reader: const FileTreeReader(),
        watchService: watchService,
      );
      addTearDown(controller.dispose);
      addTearDown(() async => root.delete(recursive: true));

      await File('${root.path}/before.txt').writeAsString('before');
      await controller.start();

      expect(
        controller.childrenFor(root.path).map((node) => node.name),
        contains('before.txt'),
      );

      await File('${root.path}/after.txt').writeAsString('after');
      watchService.emit(root.path);
      await Future<void>.delayed(const Duration(milliseconds: 140));

      expect(
        controller.childrenFor(root.path).map((node) => node.name),
        contains('after.txt'),
      );
    },
  );
}

final class _FakeFileTreeWatchService implements FileTreeWatchService {
  final _controllers = <String, StreamController<void>>{};

  @override
  Stream<void> watchDirectory(String path) {
    final controller = _controllers.putIfAbsent(
      path,
      () => StreamController<void>.broadcast(),
    );

    return controller.stream;
  }

  void emit(String path) {
    _controllers[path]?.add(null);
  }
}
