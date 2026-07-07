import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_process.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session_store.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/projects/project_workspace.dart';
import 'package:osinara/src/projects/project_workspace_store.dart';
import 'package:osinara/src/projects/project_workspace_tab.dart';

void main() {
  test(
    'ProjectWorkspaceStore replaces the launcher tab with a terminal tab',
    () async {
      final processFactory = _FakeProcessFactory();
      final terminalSessions = EmbeddedTerminalSessionStore(
        processLauncher: processFactory,
      );
      final store = _store(terminalSessions);
      addTearDown(store.dispose);
      addTearDown(terminalSessions.dispose);

      expect(store.selectedTab.isLauncher, isTrue);

      final session = await store.launchProfileInSelectedTab(
        profile: defaultLaunchProfiles.first,
        environment: const {'SHELL': '/bin/bash'},
      );

      expect(
        processFactory.started.single.workingDirectory,
        '/workspace/first',
      );
      expect(store.selectedProjectTabs, hasLength(1));
      expect(store.selectedTab.isTerminal, isTrue);
      expect(store.selectedTab.terminalSessionId, session.id);
    },
  );

  test(
    'ProjectWorkspaceStore opens a new launcher tab after a terminal exists',
    () async {
      final terminalSessions = EmbeddedTerminalSessionStore(
        processLauncher: _FakeProcessFactory(),
      );
      final store = _store(terminalSessions);
      addTearDown(store.dispose);
      addTearDown(terminalSessions.dispose);

      await store.launchProfileInSelectedTab(
        profile: defaultLaunchProfiles.first,
        environment: const {'SHELL': '/bin/bash'},
      );
      store.openLauncherTab();

      expect(store.selectedProjectTabs, hasLength(2));
      expect(store.selectedTab.isLauncher, isTrue);
    },
  );

  test(
    'ProjectWorkspaceStore selects the owning project for a terminal session',
    () async {
      final terminalSessions = EmbeddedTerminalSessionStore(
        processLauncher: _FakeProcessFactory(),
      );
      final store = _store(terminalSessions);
      addTearDown(store.dispose);
      addTearDown(terminalSessions.dispose);

      final session = await store.launchProfileInSelectedTab(
        profile: defaultLaunchProfiles.first,
        environment: const {'SHELL': '/bin/bash'},
      );
      store.selectProject('second');

      expect(store.selectedProject.id, 'second');
      expect(store.selectedTab.isLauncher, isTrue);

      store.selectTerminalSession(session.id);

      expect(store.selectedProject.id, 'first');
      expect(store.selectedTab.terminalSessionId, session.id);
    },
  );

  test('ProjectWorkspaceStore adds and selects a new local project', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = _store(terminalSessions);
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    final added = store.addProject(
      ProjectWorkspace.local(
        id: 'third',
        name: 'third',
        path: '/workspace/third',
        iconName: 'spark',
      ),
    );

    expect(added.id, 'third');
    expect(store.projects.map((project) => project.id), contains('third'));
    expect(store.selectedProject.id, 'third');
    expect(store.selectedTab.isLauncher, isTrue);
  });

  test('ProjectWorkspaceStore updates project name path and icon', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = _store(terminalSessions);
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    store.updateProject(
      'first',
      name: 'renamed',
      path: '/workspace/renamed',
      iconName: 'code',
    );

    final updated = store.projects.firstWhere(
      (project) => project.id == 'first',
    );
    expect(updated.name, 'renamed');
    expect(updated.path, '/workspace/renamed');
    expect(updated.iconName, 'code');
  });

  test(
    'ProjectWorkspaceStore removes a project only from the workspace list',
    () {
      final terminalSessions = EmbeddedTerminalSessionStore(
        processLauncher: _FakeProcessFactory(),
      );
      final store = _store(terminalSessions);
      addTearDown(store.dispose);
      addTearDown(terminalSessions.dispose);

      store.removeProject('second');

      expect(
        store.projects.map((project) => project.id),
        isNot(contains('second')),
      );
      expect(store.selectedProject.id, 'first');
    },
  );

  test('ProjectWorkspaceStore keeps at least one project', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = ProjectWorkspaceStore(
      terminalSessions: terminalSessions,
      projects: [
        ProjectWorkspace.local(
          id: 'only',
          name: 'only',
          path: '/workspace/only',
        ),
      ],
    );
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    expect(() => store.removeProject('only'), throwsA(isA<StateError>()));
  });

  test('ProjectWorkspaceStore opens a file tab in the selected project', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = _store(terminalSessions);
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    store.openFile('/workspace/first/lib/main.dart');

    expect(store.selectedTab.isFile, isTrue);
    expect(store.selectedTab.filePath, '/workspace/first/lib/main.dart');
    expect(store.selectedProjectTabs.where((tab) => tab.isFile), hasLength(1));
  });

  test('ProjectWorkspaceStore reuses an existing file tab', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = _store(terminalSessions);
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    store.openFile('/workspace/first/lib/main.dart');
    store.openFile('/workspace/first/lib/main.dart');

    expect(store.selectedProjectTabs.where((tab) => tab.isFile), hasLength(1));
  });

  test('ProjectWorkspaceStore creates unique tab ids after restore', () {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: _FakeProcessFactory(),
    );
    final store = ProjectWorkspaceStore(
      terminalSessions: terminalSessions,
      projects: [
        ProjectWorkspace.local(
          id: 'first',
          name: 'first',
          path: '/workspace/first',
        ),
      ],
      initialTabsByProjectId: const {
        'first': [
          ProjectWorkspaceTab.launcher(id: 'workspace-tab-7'),
          ProjectWorkspaceTab.file(
            id: 'workspace-tab-8',
            filePath: '/workspace/first/lib/main.dart',
          ),
        ],
      },
      initialSelectedTabByProjectId: const {'first': 'workspace-tab-8'},
    );
    addTearDown(store.dispose);
    addTearDown(terminalSessions.dispose);

    store.openLauncherTab();

    final tabIds = store.selectedProjectTabs.map((tab) => tab.id).toList();
    expect(tabIds, contains('workspace-tab-9'));
    expect(tabIds.toSet(), hasLength(tabIds.length));
  });
}

ProjectWorkspaceStore _store(EmbeddedTerminalSessionStore terminalSessions) {
  return ProjectWorkspaceStore(
    terminalSessions: terminalSessions,
    projects: [
      ProjectWorkspace.local(
        id: 'first',
        name: 'first',
        path: '/workspace/first',
      ),
      ProjectWorkspace.local(
        id: 'second',
        name: 'second',
        path: '/workspace/second',
      ),
    ],
  );
}

final class _FakeProcessFactory implements EmbeddedTerminalProcessFactory {
  final started = <EmbeddedTerminalProcessRequest>[];

  @override
  Future<EmbeddedTerminalProcess> start(
    EmbeddedTerminalProcessRequest request,
  ) async {
    started.add(request);
    return _FakeProcess(3000 + started.length);
  }
}

final class _FakeProcess implements EmbeddedTerminalProcess {
  _FakeProcess(this.pid);

  final _output = StreamController<List<int>>();
  final _exitCode = Completer<int>();

  @override
  final int pid;

  @override
  Stream<List<int>> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(List<int> data) {}

  @override
  void resize({required int rows, required int columns}) {}

  @override
  bool kill() {
    unawaited(_output.close());
    if (!_exitCode.isCompleted) {
      _exitCode.complete(0);
    }
    return true;
  }
}
