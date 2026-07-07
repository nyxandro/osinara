import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/main.dart';
import 'package:osinara/src/projects/project_workspace.dart';

import 'test_doubles.dart';

void main() {
  testWidgets('adds a local project from the project picker dialog', (
    tester,
  ) async {
    late Directory root;
    late Directory newProject;
    await tester.runAsync(() async {
      root = await Directory.systemTemp.createTemp('osinara-add-project-');
      newProject = await Directory('${root.path}/new-project').create();
    });
    addTearDown(() async => root.delete(recursive: true));

    await tester.pumpWidget(_testApp());

    await tester.tap(find.byKey(const Key('add-project-button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('project-add-search')), findsOneWidget);
    expect(find.byKey(const Key('connect-ssh-server-row')), findsOneWidget);
    expect(find.byKey(const Key('add-wsl-distro-row')), findsOneWidget);

    await tester.tap(find.byKey(const Key('open-folder-row')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('local-path-field')),
      newProject.path,
    );
    await tester.tap(find.byKey(const Key('local-submit-button')));
    await tester.pumpAndSettle();

    expect(find.text('new-project'), findsOneWidget);
  });

  testWidgets('adds SSH and WSL project entries from the picker dialog', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());

    await tester.tap(find.byKey(const Key('add-project-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('connect-ssh-server-row')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('ssh-endpoint-field')),
      'deploy@example.test',
    );
    await tester.enterText(
      find.byKey(const Key('ssh-path-field')),
      '/srv/remote-app',
    );
    await tester.tap(find.byKey(const Key('ssh-submit-button')));
    await tester.pumpAndSettle();

    expect(find.text('remote-app'), findsOneWidget);

    await tester.tap(find.byKey(const Key('add-project-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('add-wsl-distro-row')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('wsl-endpoint-field')),
      'Ubuntu-24.04',
    );
    await tester.enterText(
      find.byKey(const Key('wsl-path-field')),
      '/home/user/wsl-app',
    );
    await tester.tap(find.byKey(const Key('wsl-submit-button')));
    await tester.pumpAndSettle();

    expect(find.text('wsl-app'), findsOneWidget);
  });

  testWidgets('edits and removes a project from project settings', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testApp(
        projects: [
          ProjectWorkspace.local(
            id: 'first',
            name: 'first',
            path: '/tmp/first',
          ),
          ProjectWorkspace.local(
            id: 'second',
            name: 'second',
            path: '/tmp/second',
          ),
        ],
      ),
    );

    await tester.tap(find.byKey(const Key('project-settings-first')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('project-settings-dialog')), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('project-settings-name-field')),
      'renamed',
    );
    await tester.enterText(
      find.byKey(const Key('project-settings-icon-field')),
      'code',
    );
    await tester.tap(find.byKey(const Key('project-settings-save-button')));
    await tester.pumpAndSettle();

    expect(find.text('renamed'), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-settings-first')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('project-settings-delete-button')));
    await tester.pumpAndSettle();

    expect(find.text('renamed'), findsNothing);
    expect(find.text('second'), findsOneWidget);
  });
}

OsinaraApp _testApp({List<ProjectWorkspace>? projects}) {
  return OsinaraApp(
    terminalProcessFactory: FakeProcessFactory(),
    fileTreeReader: const FakeFileTreeReader({}),
    fileTreeWatchService: const NoopFileTreeWatchService(),
    initialProjects: projects,
  );
}
