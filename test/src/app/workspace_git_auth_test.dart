/// Workspace-level tests for Git authentication status updates.
///
/// Key constructs:
/// - [OsinaraApp]: verifies auth dialog success updates Settings provider status.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/main.dart';
import 'package:osinara/src/git/browser_launcher.dart';
import 'package:osinara/src/git/git_auth_process.dart';

import '../../test_doubles.dart';

void main() {
  testWidgets('updates GitHub connection status after successful auth', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final authProcess = _FakeGitAuthProcess();

    await tester.pumpWidget(
      OsinaraApp(
        terminalProcessFactory: FakeProcessFactory(),
        fileTreeReader: const FakeFileTreeReader({}),
        fileTreeWatchService: const NoopFileTreeWatchService(),
        fileContentReader: const FakeFileContentReader({}),
        gitAuthProcessLauncher: _FakeGitAuthProcessLauncher(authProcess),
        browserLauncher: _FakeBrowserLauncher(),
      ),
    );

    await tester.tap(find.byKey(const Key('status-settings-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    final githubButton = find.byKey(const Key('git-auth-github-button'));
    await tester.ensureVisible(githubButton);
    await tester.tap(githubButton);
    await tester.pump();

    authProcess.addOutput('! First copy your one-time code: 208B-258B\n');
    await tester.pump();
    authProcess.complete(0);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('Connected'), findsOneWidget);
  });
}

final class _FakeGitAuthProcessLauncher implements GitAuthProcessLauncher {
  const _FakeGitAuthProcessLauncher(this.process);

  final _FakeGitAuthProcess process;

  @override
  Future<GitAuthProcess> start(GitAuthProcessRequest request) async => process;
}

final class _FakeGitAuthProcess implements GitAuthProcess {
  final _output = StreamController<String>();
  final _exitCode = Completer<int>();

  @override
  Stream<String> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(String data) {}

  @override
  bool kill() {
    complete(130);
    return true;
  }

  void addOutput(String chunk) => _output.add(chunk);

  void complete(int exitCode) {
    if (!_exitCode.isCompleted) {
      _exitCode.complete(exitCode);
    }
    unawaited(_output.close());
  }
}

final class _FakeBrowserLauncher implements BrowserLauncher {
  @override
  Future<void> open(String url) async {}
}
