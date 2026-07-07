import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/main.dart';
import 'package:osinara/src/app/widgets/file_viewer.dart';
import 'package:osinara/src/file_tree/file_tree_node.dart';
import 'package:osinara/src/file_tree/file_tree_reader.dart';
import 'package:osinara/src/git/git_status_reader.dart';
import 'package:osinara/src/projects/project_workspace.dart';

import 'test_doubles.dart';

void main() {
  testWidgets('renders the Osinara workspace shell in English', (tester) async {
    await tester.pumpWidget(_testApp());

    expect(
      find.descendant(
        of: find.byKey(const Key('app-title-bar')),
        matching: find.text('Osinara'),
      ),
      findsOneWidget,
    );
    expect(find.text('Projects'), findsNothing);
    expect(find.text('Files'), findsNothing);
    expect(find.text('Center'), findsNothing);
    expect(find.text('Settings'), findsNothing);
    expect(find.byKey(const Key('status-files-toggle')), findsOneWidget);
    expect(find.byKey(const Key('status-git-toggle')), findsOneWidget);
    expect(find.byKey(const Key('status-center-toggle')), findsOneWidget);
    expect(find.byKey(const Key('status-projects-toggle')), findsOneWidget);
    expect(find.byKey(const Key('status-settings-button')), findsOneWidget);
    expect(find.byKey(const Key('workspace-tab-strip')), findsOneWidget);
    expect(find.byKey(const Key('workspace-launcher-panel')), findsOneWidget);
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.text('OpenCode'), findsOneWidget);
  });

  testWidgets('renders file tree without a header strip', (tester) async {
    await tester.pumpWidget(_testApp());

    final filePanel = find.byKey(const Key('files-panel'));

    expect(filePanel, findsOneWidget);
    expect(
      find.descendant(of: filePanel, matching: find.text('File tree')),
      findsNothing,
    );
    expect(
      find.descendant(of: filePanel, matching: find.text('Дерево файлов')),
      findsNothing,
    );
  });

  testWidgets('renders bottom status controls as bare icons', (tester) async {
    await tester.pumpWidget(_testApp());

    for (final key in [
      const Key('status-files-toggle'),
      const Key('status-git-toggle'),
      const Key('status-center-toggle'),
      const Key('status-projects-toggle'),
      const Key('status-settings-button'),
    ]) {
      final container = tester.widget<AnimatedContainer>(
        find.descendant(
          of: find.byKey(key),
          matching: find.byType(AnimatedContainer),
        ),
      );

      expect(container.decoration, isNull);
    }
  });

  testWidgets('shows project contents without the root folder row', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());

    final filePanel = find.byKey(const Key('files-panel'));

    expect(filePanel, findsOneWidget);
    expect(
      find.descendant(of: filePanel, matching: find.text('osinara')),
      findsNothing,
    );
  });

  testWidgets('resizes side panels by dragging their borders', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_testApp());

    final filesPanel = find.byKey(const Key('files-panel'));
    final projectsPanel = find.byKey(const Key('projects-panel'));
    final initialFilesWidth = tester.getSize(filesPanel).width;
    final initialProjectsWidth = tester.getSize(projectsPanel).width;

    _expectSeamlessPanelJoints(tester);

    await tester.drag(
      find.byKey(const Key('files-resize-handle')),
      const Offset(80, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.drag(
      find.byKey(const Key('projects-resize-handle')),
      const Offset(-60, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(tester.getSize(filesPanel).width, greaterThan(initialFilesWidth));
    expect(
      tester.getSize(projectsPanel).width,
      greaterThan(initialProjectsWidth),
    );
    _expectSeamlessPanelJoints(tester);
  });

  testWidgets('toggles project and center panels from the status bar', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());

    expect(find.text('Launch profiles'), findsOneWidget);
    await tester.tap(find.byKey(const Key('status-center-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Launch profiles'), findsNothing);

    await tester.tap(find.byKey(const Key('status-center-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Launch profiles'), findsOneWidget);

    expect(find.text('r7lines-agent'), findsOneWidget);
    await tester.tap(find.byKey(const Key('status-projects-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('r7lines-agent'), findsNothing);
  });

  testWidgets('switches the left side panel between files and git', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testApp(
        gitStatusReader: GitStatusReader(
          runner: FakeGitCommandRunner(
            const GitCommandResult(
              exitCode: 0,
              stdout: '## main\n M lib/main.dart\n',
              stderr: '',
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('files-panel')), findsOneWidget);
    expect(find.byKey(const Key('git-panel')), findsNothing);

    await tester.tap(find.byKey(const Key('status-git-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byKey(const Key('git-panel')), findsOneWidget);
    expect(find.byKey(const Key('files-panel')), findsNothing);
    expect(find.text('lib/main.dart'), findsOneWidget);

    await tester.tap(find.byKey(const Key('status-files-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byKey(const Key('files-panel')), findsOneWidget);
    expect(find.byKey(const Key('git-panel')), findsNothing);
  });

  testWidgets('switches the interface language from settings', (tester) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_testApp());

    await tester.tap(find.byKey(const Key('status-settings-button')));
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('Language'), findsOneWidget);
    expect(find.text('Git authentication'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    expect(find.text('Русский'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilterChip, 'Русский'));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Параметры интерфейса'), findsOneWidget);
    expect(find.text('Язык интерфейса'), findsOneWidget);

    expect(find.text('Файлы'), findsNothing);
    expect(find.text('Центр'), findsNothing);
    expect(find.text('Проекты'), findsNothing);
  });

  testWidgets('closes settings and returns to the workspace content', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());

    await tester.tap(find.byKey(const Key('status-settings-button')));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Language'), findsOneWidget);

    await tester.tap(find.byKey(const Key('settings-close-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('Language'), findsNothing);
    expect(find.text('Launch profiles'), findsOneWidget);
  });

  testWidgets('switches between dark and light themes from settings', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_testApp());

    var app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme?.brightness, Brightness.dark);

    await tester.tap(find.byKey(const Key('status-settings-button')));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Theme'), findsOneWidget);
    expect(find.text('Dark'), findsOneWidget);
    expect(find.text('Light'), findsOneWidget);

    await tester.tap(find.text('Light'));
    await tester.pump();

    app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme?.brightness, Brightness.light);

    await tester.tap(find.text('Dark'));
    await tester.pump();

    app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme?.brightness, Brightness.dark);
  });

  testWidgets(
    'launches a CLI in the current tab and opens a new launcher tab',
    (tester) async {
      final processFactory = FakeProcessFactory();

      await tester.pumpWidget(_testApp(processFactory: processFactory));

      expect(find.byKey(const Key('workspace-tab-strip')), findsOneWidget);
      expect(find.byKey(const Key('workspace-new-tab-button')), findsNothing);

      await tester.tap(find.text('Launch').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(processFactory.started.single.executable, '/bin/bash');
      expect(find.byKey(const Key('embedded-terminal-view')), findsOneWidget);
      expect(find.byKey(const Key('workspace-new-tab-button')), findsOneWidget);
      expect(find.text('Launch profiles'), findsNothing);
      expect(find.text('Launch'), findsNothing);
      expect(find.text('New session'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 220));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();

      final terminalPane = tester.widget<ColoredBox>(
        find.byKey(const Key('embedded-terminal-pane')),
      );
      final terminalTabShell = tester.widget<Material>(
        find.byWidgetPredicate((widget) {
          final key = widget.key;
          return widget is Material &&
              key is ValueKey<String> &&
              key.value.startsWith('workspace-tab-shell-');
        }),
      );
      expect(terminalTabShell.color, terminalPane.color);
      expect(
        tester.getTopLeft(find.byKey(const Key('embedded-terminal-pane'))).dy,
        tester.getBottomLeft(find.byKey(const Key('workspace-tab-strip'))).dy,
      );
      _expectSeamlessPanelJoints(tester);

      await tester.tap(find.byKey(const Key('workspace-new-tab-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byKey(const Key('workspace-launcher-panel')), findsOneWidget);
      expect(find.byKey(const Key('embedded-terminal-view')), findsNothing);
      expect(find.text('Launch profiles'), findsOneWidget);
    },
  );

  testWidgets('switches projects and restores each project workspace state', (
    tester,
  ) async {
    final processFactory = FakeProcessFactory();
    late Directory root;
    late Directory firstProject;
    late Directory secondProject;

    await tester.runAsync(() async {
      root = await Directory.systemTemp.createTemp('osinara-projects-');
      firstProject = await Directory('${root.path}/first').create();
      secondProject = await Directory('${root.path}/second').create();
      await File('${firstProject.path}/first.txt').writeAsString('first');
      await File('${secondProject.path}/second.txt').writeAsString('second');
    });
    addTearDown(() async => root.delete(recursive: true));

    await tester.pumpWidget(
      _testApp(
        processFactory: processFactory,
        fileTreeReader: FakeFileTreeReader({
          firstProject.path: [
            FileTreeNode(
              name: 'first.txt',
              path: '${firstProject.path}/first.txt',
              isDirectory: false,
            ),
          ],
          secondProject.path: [
            FileTreeNode(
              name: 'second.txt',
              path: '${secondProject.path}/second.txt',
              isDirectory: false,
            ),
          ],
        }),
        projects: [
          ProjectWorkspace.local(
            id: 'first',
            name: 'first',
            path: firstProject.path,
          ),
          ProjectWorkspace.local(
            id: 'second',
            name: 'second',
            path: secondProject.path,
          ),
        ],
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('first.txt'), findsOneWidget);
    expect(find.text('second.txt'), findsNothing);

    await tester.tap(find.text('Launch').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byKey(const Key('embedded-terminal-view')), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-tile-second')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('first.txt'), findsNothing);
    expect(find.text('second.txt'), findsOneWidget);
    expect(find.byKey(const Key('workspace-launcher-panel')), findsOneWidget);
    expect(find.byKey(const Key('embedded-terminal-view')), findsNothing);

    final projectSessionTile = find.byWidgetPredicate((widget) {
      final key = widget.key;
      return key is ValueKey<String> &&
          key.value.startsWith('project-terminal-session-');
    });

    await tester.tap(projectSessionTile.first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('first.txt'), findsOneWidget);
    expect(find.text('second.txt'), findsNothing);
    expect(find.byKey(const Key('embedded-terminal-view')), findsOneWidget);
    expect(find.byKey(const Key('workspace-launcher-panel')), findsNothing);
  });

  testWidgets('opens a file from the file tree in a workspace tab', (
    tester,
  ) async {
    late Directory root;
    late String filePath;
    await tester.runAsync(() async {
      root = await Directory.systemTemp.createTemp('osinara-file-view-');
      filePath = '${root.path}/notes.md';
    });
    addTearDown(() async => root.delete(recursive: true));

    await tester.pumpWidget(
      _testApp(
        projects: [
          ProjectWorkspace.local(id: 'notes', name: 'notes', path: root.path),
        ],
        fileTreeReader: FakeFileTreeReader({
          root.path: [
            FileTreeNode(name: 'notes.md', path: filePath, isDirectory: false),
          ],
        }),
        fileContentReader: FakeFileContentReader({
          filePath: '# Notes\nHello Osinara',
        }),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('notes.md'), findsOneWidget);

    await tester.tap(find.text('notes.md'));
    await tester.pump();
    expect(
      find.byWidgetPredicate((widget) {
        final key = widget.key;
        return key is ValueKey<String> &&
            key.value.startsWith('workspace-file-tab-');
      }),
      findsOneWidget,
    );
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();

    expect(find.byKey(const Key('file-viewer-content')), findsOneWidget);
    expect(find.textContaining('Hello Osinara'), findsOneWidget);
  });
}

void _expectSeamlessPanelJoints(WidgetTester tester) {
  final filesPanel = find.byKey(const Key('files-panel'));
  final centerPanel = find.byKey(const Key('center-panel'));
  final projectsPanel = find.byKey(const Key('projects-panel'));

  expect(
    tester.getTopRight(filesPanel).dx,
    moreOrLessEquals(tester.getTopLeft(centerPanel).dx, epsilon: 0.01),
  );
  expect(
    tester.getTopRight(centerPanel).dx,
    moreOrLessEquals(tester.getTopLeft(projectsPanel).dx, epsilon: 0.01),
  );
}

OsinaraApp _testApp({
  FakeProcessFactory? processFactory,
  FileTreeReader? fileTreeReader,
  FileContentReader? fileContentReader,
  GitStatusReader? gitStatusReader,
  List<ProjectWorkspace>? projects,
}) {
  return OsinaraApp(
    terminalProcessFactory: processFactory ?? FakeProcessFactory(),
    fileTreeReader: fileTreeReader ?? const FakeFileTreeReader({}),
    fileTreeWatchService: const NoopFileTreeWatchService(),
    fileContentReader: fileContentReader ?? const FakeFileContentReader({}),
    gitStatusReader: gitStatusReader,
    initialProjects: projects,
  );
}
