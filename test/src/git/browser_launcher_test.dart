/// Tests for opening auth verification URLs in the host browser.
///
/// Key constructs:
/// - [ProcessBrowserLauncher]: verifies WSL and Linux opener command selection.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/git/browser_launcher.dart';

void main() {
  test('treats the WSL Windows opener as successful after launch', () async {
    final runner = _FakeBrowserProcessRunner([
      const BrowserProcessResult(exitCode: 1, stderr: 'detached start'),
    ]);
    final launcher = ProcessBrowserLauncher(
      runner: runner,
      environment: const {'WSL_DISTRO_NAME': 'Ubuntu'},
    );

    await launcher.open('https://github.com/login/device');

    expect(runner.requests.single.executable, 'explorer.exe');
    expect(runner.requests.single.arguments, [
      'https://github.com/login/device',
    ]);
  });

  test(
    'falls through WSL launchers when Windows openers are unavailable',
    () async {
      final runner = _FakeBrowserProcessRunner([
        StateError('explorer missing'),
        StateError('cmd missing'),
        StateError('powershell missing'),
        const BrowserProcessResult(exitCode: 1, stderr: 'wslview failed'),
        const BrowserProcessResult(exitCode: 1, stderr: 'xdg failed'),
      ]);
      final launcher = ProcessBrowserLauncher(
        runner: runner,
        environment: const {'WSL_INTEROP': '/run/WSL/interop'},
      );

      await expectLater(
        () => launcher.open('https://github.com/login/device'),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('OSI_BROWSER_OPEN_FAILED'),
          ),
        ),
      );
      expect(runner.requests.map((request) => request.executable), [
        'explorer.exe',
        'cmd.exe',
        'powershell.exe',
        'wslview',
        'xdg-open',
      ]);
    },
  );
}

final class _FakeBrowserProcessRunner implements BrowserProcessRunner {
  _FakeBrowserProcessRunner(this.results);

  final List<Object> results;
  final requests = <_BrowserRequest>[];

  @override
  Future<BrowserProcessResult> run(
    String executable,
    List<String> arguments,
  ) async {
    requests.add(_BrowserRequest(executable, arguments));
    final result = results.removeAt(0);
    if (result is BrowserProcessResult) {
      return result;
    }

    throw result;
  }
}

final class _BrowserRequest {
  const _BrowserRequest(this.executable, this.arguments);

  final String executable;
  final List<String> arguments;
}
