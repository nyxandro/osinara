import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_process.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session_store.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/session_titles/cli_session_title_adapter.dart';

void main() {
  group('EmbeddedTerminalSessionStore', () {
    test('launches a terminal session and selects it', () async {
      final factory = _FakeProcessFactory();
      final store = EmbeddedTerminalSessionStore(processLauncher: factory);

      final session = await store.launch(
        profile: const LaunchProfile(
          agentName: 'OpenCode',
          command: 'opencode',
        ),
        projectName: 'osinara',
        projectPath: '/workspace/osinara',
        environment: const {'SHELL': '/bin/bash'},
      );

      expect(store.sessions, [session]);
      expect(store.selectedSession, session);
      expect(session.status, EmbeddedTerminalStatus.running);
      expect(factory.started.single.executable, '/bin/bash');
      expect(factory.started.single.workingDirectory, '/workspace/osinara');
    });

    test('forwards terminal output to the process input', () async {
      final factory = _FakeProcessFactory();
      final store = EmbeddedTerminalSessionStore(processLauncher: factory);
      final session = await store.launch(
        profile: const LaunchProfile(agentName: 'Codex', command: 'codex'),
        projectName: 'osinara',
        projectPath: '/workspace/osinara',
        environment: const {'SHELL': '/bin/bash'},
      );

      session.terminal.textInput('hello');

      expect(utf8.decode(factory.processes.single.writes.single), 'hello');
    });

    test('marks a session as exited when the process finishes', () async {
      final factory = _FakeProcessFactory();
      final store = EmbeddedTerminalSessionStore(processLauncher: factory);
      final session = await store.launch(
        profile: const LaunchProfile(
          agentName: 'Claude Code',
          command: 'claude',
        ),
        projectName: 'osinara',
        projectPath: '/workspace/osinara',
        environment: const {'SHELL': '/bin/bash'},
      );

      factory.processes.single.complete(0);
      await Future<void>.delayed(Duration.zero);

      expect(session.status, EmbeddedTerminalStatus.exited);
      expect(session.exitCode, 0);
    });

    test(
      'removes a closed session and selects the next available session',
      () async {
        final factory = _FakeProcessFactory();
        final store = EmbeddedTerminalSessionStore(processLauncher: factory);
        final first = await store.launch(
          profile: const LaunchProfile(
            agentName: 'Claude Code',
            command: 'claude',
          ),
          projectName: 'osinara',
          projectPath: '/workspace/osinara',
          environment: const {'SHELL': '/bin/bash'},
        );
        final second = await store.launch(
          profile: const LaunchProfile(
            agentName: 'OpenCode',
            command: 'opencode',
          ),
          projectName: 'osinara',
          projectPath: '/workspace/osinara',
          environment: const {'SHELL': '/bin/bash'},
        );

        store.closeSession(second.id);

        expect(store.sessions, [first]);
        expect(store.selectedSession, first);
        expect(factory.processes.last.killed, isTrue);
      },
    );

    test(
      'updates a launched session title through the title resolver',
      () async {
        final factory = _FakeProcessFactory();
        final titleAdapter = _FakeTitleAdapter('Refine terminal tabs');
        final store = EmbeddedTerminalSessionStore(
          processLauncher: factory,
          titleResolver: CliSessionTitleResolver(adapters: [titleAdapter]),
          titlePollInterval: const Duration(milliseconds: 10),
        );
        addTearDown(store.dispose);

        final session = await store.launch(
          profile: const LaunchProfile(
            agentName: 'Claude Code',
            command: 'claude',
          ),
          projectName: 'osinara',
          projectPath: '/workspace/osinara',
          environment: const {'SHELL': '/bin/bash'},
        );

        await Future<void>.delayed(const Duration(milliseconds: 30));

        expect(session.title, 'Refine terminal tabs');
        expect(titleAdapter.seenEnvironment, {'SHELL': '/bin/bash'});
      },
    );

    test(
      'restarts a restored terminal session with its persisted id',
      () async {
        final factory = _FakeProcessFactory();
        final store = EmbeddedTerminalSessionStore(processLauncher: factory);
        addTearDown(store.dispose);

        final session = await store.restoreRestarted(
          id: 'terminal-restored',
          profile: const LaunchProfile(
            agentName: 'OpenCode',
            command: 'opencode',
          ),
          projectName: 'osinara',
          projectPath: '/workspace/osinara',
          environment: const {'SHELL': '/bin/bash'},
          title: 'Existing title',
        );

        expect(session.id, 'terminal-restored');
        expect(session.title, 'Existing title');
        expect(session.status, EmbeddedTerminalStatus.running);
        expect(store.sessions, [session]);
        expect(factory.started.single.workingDirectory, '/workspace/osinara');
        expect(
          factory.started.single.arguments.join(' '),
          contains('opencode'),
        );
      },
    );
  });
}

final class _FakeTitleAdapter implements CliSessionTitleAdapter {
  _FakeTitleAdapter(this.title);

  final String title;
  Map<String, String>? seenEnvironment;

  @override
  bool supports(LaunchProfile profile) => true;

  @override
  Future<String?> readTitle({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) async {
    seenEnvironment = environment;
    return title;
  }
}

final class _FakeProcessFactory implements EmbeddedTerminalProcessFactory {
  final started = <EmbeddedTerminalProcessRequest>[];
  final processes = <_FakeProcess>[];

  @override
  Future<EmbeddedTerminalProcess> start(
    EmbeddedTerminalProcessRequest request,
  ) async {
    started.add(request);
    final process = _FakeProcess(1000 + processes.length);
    processes.add(process);
    return process;
  }
}

final class _FakeProcess implements EmbeddedTerminalProcess {
  _FakeProcess(this.pid);

  final _output = StreamController<List<int>>();
  final _exitCode = Completer<int>();
  final writes = <List<int>>[];
  var killed = false;

  @override
  final int pid;

  @override
  Stream<List<int>> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(List<int> data) {
    writes.add(data);
  }

  @override
  void resize({required int rows, required int columns}) {}

  @override
  bool kill() {
    killed = true;
    return true;
  }

  void complete(int exitCode) {
    _exitCode.complete(exitCode);
    unawaited(_output.close());
  }
}
