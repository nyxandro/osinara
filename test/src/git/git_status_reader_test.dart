import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/git/git_status_reader.dart';

void main() {
  group('GitStatusReader', () {
    test('parses branch and changed files from porcelain status', () async {
      final runner = _FakeGitCommandRunner(
        result: const GitCommandResult(
          exitCode: 0,
          stdout:
              '## main...origin/main [ahead 1]\n M lib/main.dart\n?? notes.md\n',
          stderr: '',
        ),
      );
      final reader = GitStatusReader(runner: runner);

      final snapshot = await reader.read('/workspace/osinara');

      expect(runner.projectPath, '/workspace/osinara');
      expect(snapshot.isRepository, isTrue);
      expect(snapshot.branchLabel, 'main...origin/main [ahead 1]');
      expect(snapshot.entries, hasLength(2));
      expect(snapshot.entries.first.path, 'lib/main.dart');
      expect(snapshot.entries.first.statusLabel, 'Modified');
      expect(snapshot.entries.last.path, 'notes.md');
      expect(snapshot.entries.last.statusLabel, 'Untracked');
    });

    test(
      'returns a non-repository snapshot for projects without Git',
      () async {
        final runner = _FakeGitCommandRunner(
          result: const GitCommandResult(
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: not a git repository',
          ),
        );
        final reader = GitStatusReader(runner: runner);

        final snapshot = await reader.read('/workspace/plain');

        expect(snapshot.isRepository, isFalse);
        expect(snapshot.entries, isEmpty);
      },
    );

    test('throws a diagnosable error for other git command failures', () async {
      final runner = _FakeGitCommandRunner(
        result: const GitCommandResult(
          exitCode: 129,
          stdout: '',
          stderr: 'unknown option',
        ),
      );
      final reader = GitStatusReader(runner: runner);

      expect(
        () => reader.read('/workspace/broken'),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('OSI_GIT_STATUS_COMMAND_FAILED'),
          ),
        ),
      );
    });
  });
}

final class _FakeGitCommandRunner implements GitCommandRunner {
  _FakeGitCommandRunner({required this.result});

  final GitCommandResult result;
  static const _statusArguments = ['status', '--porcelain=v1', '--branch'];
  String? projectPath;

  @override
  Future<GitCommandResult> run({
    required String projectPath,
    required List<String> arguments,
  }) async {
    expect(arguments, _statusArguments);
    this.projectPath = projectPath;
    return result;
  }
}
