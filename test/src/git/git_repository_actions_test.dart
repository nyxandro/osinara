/// Tests for production Git repository actions.
///
/// Key constructs:
/// - [GitRepositoryActions]: validates init and publish command orchestration.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/git/git_repository_actions.dart';

void main() {
  test('initializes a repository in the selected project path', () async {
    final runner = _FakeGitActionRunner([
      const GitActionResult(exitCode: 0, stdout: '', stderr: ''),
    ]);
    final actions = GitRepositoryActions(runner: runner);

    await actions.initialize('/workspace/plain');

    expect(runner.requests.single.executable, 'git');
    expect(runner.requests.single.arguments, ['init']);
    expect(runner.requests.single.workingDirectory, '/workspace/plain');
  });

  test(
    'publishes a GitHub repository and pushes the selected branch',
    () async {
      final runner = _FakeGitActionRunner([
        const GitActionResult(exitCode: 0, stdout: 'main\n', stderr: ''),
        const GitActionResult(exitCode: 0, stdout: '', stderr: ''),
        const GitActionResult(exitCode: 0, stdout: '', stderr: ''),
      ]);
      final actions = GitRepositoryActions(runner: runner);

      await actions.publish(
        const GitPublishRequest(
          provider: GitRemoteProvider.github,
          owner: 'nyxandro',
          repositoryName: 'osinara',
          visibility: GitRepositoryVisibility.private,
          remoteName: 'origin',
          projectPath: '/workspace/osinara',
        ),
      );

      expect(runner.requests[0].executable, 'git');
      expect(runner.requests[0].arguments, ['branch', '--show-current']);
      expect(runner.requests[1].executable, 'gh');
      expect(runner.requests[1].arguments, [
        'repo',
        'create',
        'nyxandro/osinara',
        '--private',
        '--source',
        '/workspace/osinara',
        '--remote',
        'origin',
      ]);
      expect(runner.requests[2].executable, 'git');
      expect(runner.requests[2].arguments, ['push', '-u', 'origin', 'main']);
    },
  );

  test(
    'publishes a GitLab repository with explicit namespace and visibility',
    () async {
      final runner = _FakeGitActionRunner([
        const GitActionResult(exitCode: 0, stdout: 'main\n', stderr: ''),
        const GitActionResult(exitCode: 0, stdout: '', stderr: ''),
        const GitActionResult(exitCode: 0, stdout: '', stderr: ''),
      ]);
      final actions = GitRepositoryActions(runner: runner);

      await actions.publish(
        const GitPublishRequest(
          provider: GitRemoteProvider.gitlab,
          owner: 'team',
          repositoryName: 'osinara',
          visibility: GitRepositoryVisibility.internal,
          remoteName: 'origin',
          projectPath: '/workspace/osinara',
        ),
      );

      expect(runner.requests[1].executable, 'glab');
      expect(runner.requests[1].arguments, [
        'repo',
        'create',
        'team/osinara',
        '--visibility',
        'internal',
        '--remoteName',
        'origin',
      ]);
      expect(runner.requests[2].arguments, ['push', '-u', 'origin', 'main']);
    },
  );

  test('rejects publish requests without required explicit fields', () async {
    final actions = GitRepositoryActions(runner: _FakeGitActionRunner([]));

    await expectLater(
      () => actions.publish(
        const GitPublishRequest(
          provider: GitRemoteProvider.github,
          owner: '',
          repositoryName: 'osinara',
          visibility: GitRepositoryVisibility.private,
          remoteName: 'origin',
          projectPath: '/workspace/osinara',
        ),
      ),
      throwsA(isA<ArgumentError>()),
    );
  });
}

final class _FakeGitActionRunner implements GitActionRunner {
  _FakeGitActionRunner(this.results);

  final List<GitActionResult> results;
  final requests = <_GitActionRequest>[];

  @override
  Future<GitActionResult> run({
    required String executable,
    required List<String> arguments,
    required String workingDirectory,
  }) async {
    requests.add(_GitActionRequest(executable, arguments, workingDirectory));
    return results.removeAt(0);
  }
}

final class _GitActionRequest {
  const _GitActionRequest(
    this.executable,
    this.arguments,
    this.workingDirectory,
  );

  final String executable;
  final List<String> arguments;
  final String workingDirectory;
}
