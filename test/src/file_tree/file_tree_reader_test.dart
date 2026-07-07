import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/file_tree/file_tree_reader.dart';

void main() {
  group('FileTreeReader', () {
    test('lists immediate children with directories before files', () async {
      final tempDir = await Directory.systemTemp.createTemp('osinara-tree-');
      addTearDown(() async => tempDir.delete(recursive: true));
      await Directory('${tempDir.path}/lib').create();
      await Directory('${tempDir.path}/docs').create();
      await File('${tempDir.path}/pubspec.yaml').writeAsString('name: test');
      await File('${tempDir.path}/README.md').writeAsString('docs');

      final reader = FileTreeReader();
      final children = await reader.listDirectory(tempDir.path);

      expect(children.map((node) => node.name), [
        'docs',
        'lib',
        'pubspec.yaml',
        'README.md',
      ]);
      expect(children.take(2).every((node) => node.isDirectory), isTrue);
      expect(children.skip(2).every((node) => !node.isDirectory), isTrue);
    });

    test('limits children without inventing hidden fallback data', () async {
      final tempDir = await Directory.systemTemp.createTemp('osinara-tree-');
      addTearDown(() async => tempDir.delete(recursive: true));
      await File('${tempDir.path}/a.txt').writeAsString('a');
      await File('${tempDir.path}/b.txt').writeAsString('b');
      await File('${tempDir.path}/c.txt').writeAsString('c');

      final reader = FileTreeReader(childLimit: 2);
      final children = await reader.listDirectory(tempDir.path);

      expect(children.map((node) => node.name), ['a.txt', 'b.txt']);
    });

    test('rejects missing project paths with a diagnosable error', () async {
      final reader = FileTreeReader();

      expect(
        () => reader.listDirectory('/path/that/does/not/exist'),
        throwsA(isA<StateError>()),
      );
    });
  });
}
