/// Tests for the background Git auth controller.
///
/// Key constructs:
/// - [GitAuthController]: verifies code parsing, browser opening, stdin continuation, and completion state.
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/git/browser_launcher.dart';
import 'package:osinara/src/git/git_auth_controller.dart';
import 'package:osinara/src/git/git_auth_flow.dart';
import 'package:osinara/src/git/git_auth_process.dart';

void main() {
  test(
    'opens browser and continues GitHub CLI after device code appears',
    () async {
      final process = _FakeGitAuthProcess();
      final controller = GitAuthController(
        provider: GitAuthProvider.github,
        processLauncher: _FakeGitAuthProcessLauncher(process),
        browserLauncher: _FakeBrowserLauncher(),
        environment: const {},
      );
      addTearDown(controller.dispose);

      await controller.start();
      process.addOutput('! First copy your one-time code: 1136-7478\n');
      await _flushMicrotasks();

      expect(controller.state.status, GitAuthStatus.waitingForConfirmation);
      expect(controller.state.deviceCode, '1136-7478');
      expect(
        controller.state.verificationUrl,
        'https://github.com/login/device',
      );
      expect(process.writes, contains('\n'));

      process.complete(0);
      await _flushMicrotasks();

      expect(controller.state.status, GitAuthStatus.succeeded);
    },
  );

  test('keeps manual URL visible when automatic browser open fails', () async {
    final process = _FakeGitAuthProcess();
    final controller = GitAuthController(
      provider: GitAuthProvider.github,
      processLauncher: _FakeGitAuthProcessLauncher(process),
      browserLauncher: _FakeBrowserLauncher(shouldFail: true),
      environment: const {},
    );
    addTearDown(controller.dispose);

    await controller.start();
    process.addOutput('! First copy your one-time code: 1136-7478\n');
    await _flushMicrotasks();

    expect(controller.state.status, GitAuthStatus.waitingForConfirmation);
    expect(controller.state.browserOpenFailed, isTrue);
    expect(controller.state.verificationUrl, 'https://github.com/login/device');

    process.complete(0);
    await _flushMicrotasks();

    expect(controller.state.status, GitAuthStatus.succeeded);
    expect(controller.state.browserOpenFailed, isFalse);
  });
}

Future<void> _flushMicrotasks() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
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
  final writes = <String>[];

  @override
  Stream<String> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(String data) => writes.add(data);

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
  const _FakeBrowserLauncher({this.shouldFail = false});

  final bool shouldFail;

  @override
  Future<void> open(String url) async {
    if (shouldFail) {
      throw StateError('OSI_TEST_BROWSER_FAILED: Browser failed in test.');
    }
  }
}
