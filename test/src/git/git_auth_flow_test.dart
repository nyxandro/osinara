/// Tests for Git provider browser/device authentication flow primitives.
///
/// Key constructs:
/// - `gitAuthCommand`: validates provider CLI commands.
/// - `parseGitAuthDevicePrompt`: extracts device code and verification URL.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/git/git_auth_flow.dart';

void main() {
  test('builds a GitHub web authentication command without clipboard flag', () {
    final command = gitAuthCommand(GitAuthProvider.github);

    expect(command.executable, 'gh');
    expect(command.arguments, [
      'auth',
      'login',
      '--web',
      '--git-protocol',
      'https',
    ]);
    expect(command.arguments, isNot(contains('--clipboard')));
  });

  test('builds a GitLab device authentication command', () {
    final command = gitAuthCommand(GitAuthProvider.gitlab);

    expect(command.executable, 'glab');
    expect(command.arguments, [
      'auth',
      'login',
      '--hostname',
      'gitlab.com',
      '--device',
      '--git-protocol',
      'https',
    ]);
  });

  test('parses GitHub one-time code and default verification URL', () {
    final prompt = parseGitAuthDevicePrompt(
      provider: GitAuthProvider.github,
      output: '''
! First copy your one-time code: 1136-7478
Press Enter to open github.com in your browser...
''',
    );

    expect(prompt?.code, '1136-7478');
    expect(prompt?.verificationUrl, 'https://github.com/login/device');
  });

  test('parses GitLab device code and verification URL', () {
    final prompt = parseGitAuthDevicePrompt(
      provider: GitAuthProvider.gitlab,
      output: '''
Open https://gitlab.com/-/user_settings/personal_access_tokens/device and enter code ABCD-EFGH.
''',
    );

    expect(prompt?.code, 'ABCD-EFGH');
    expect(
      prompt?.verificationUrl,
      'https://gitlab.com/-/user_settings/personal_access_tokens/device',
    );
  });
}
