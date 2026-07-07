/// Local Git status integration backed by the system `git` executable.
///
/// Key constructs:
/// - [GitCommandRunner]: testable abstraction over `git -C <project> ...`.
/// - [ProcessGitCommandRunner]: production runner using [Process.run].
/// - [GitCommandResult]: stdout/stderr/exit-code DTO for git commands.
/// - [GitStatusEntry]: one changed file reported by porcelain status.
/// - [GitStatusSnapshot]: parsed repository status shown in the Git side panel.
/// - [GitStatusReader]: reads and parses `git status --porcelain=v1 --branch`.
library;

import 'dart:io';

const _statusArguments = ['status', '--porcelain=v1', '--branch'];
const _notRepositoryExitCode = 128;
const _notRepositoryMarker = 'not a git repository';

abstract interface class GitCommandRunner {
  Future<GitCommandResult> run({
    required String projectPath,
    required List<String> arguments,
  });
}

final class ProcessGitCommandRunner implements GitCommandRunner {
  const ProcessGitCommandRunner();

  @override
  Future<GitCommandResult> run({
    required String projectPath,
    required List<String> arguments,
  }) async {
    final result = await Process.run('git', [
      '-C',
      projectPath,
      ...arguments,
    ], runInShell: false);

    return GitCommandResult(
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    );
  }
}

final class GitCommandResult {
  const GitCommandResult({
    required this.exitCode,
    required this.stdout,
    required this.stderr,
  });

  final int exitCode;
  final String stdout;
  final String stderr;
}

final class GitStatusEntry {
  const GitStatusEntry({
    required this.indexStatus,
    required this.workTreeStatus,
    required this.path,
  });

  final String indexStatus;
  final String workTreeStatus;
  final String path;

  String get statusLabel {
    if (indexStatus == '?' && workTreeStatus == '?') {
      return 'Untracked';
    }
    if (indexStatus == 'A' || workTreeStatus == 'A') {
      return 'Added';
    }
    if (indexStatus == 'D' || workTreeStatus == 'D') {
      return 'Deleted';
    }
    if (indexStatus == 'R' || workTreeStatus == 'R') {
      return 'Renamed';
    }
    if (indexStatus == 'M' || workTreeStatus == 'M') {
      return 'Modified';
    }
    if (indexStatus == 'U' || workTreeStatus == 'U') {
      return 'Conflict';
    }

    return 'Changed';
  }
}

final class GitStatusSnapshot {
  const GitStatusSnapshot({
    required this.isRepository,
    required this.branchLabel,
    required this.entries,
  });

  const GitStatusSnapshot.notRepository()
    : isRepository = false,
      branchLabel = null,
      entries = const [];

  final bool isRepository;
  final String? branchLabel;
  final List<GitStatusEntry> entries;

  bool get isClean => isRepository && entries.isEmpty;
}

final class GitStatusReader {
  const GitStatusReader({this.runner = const ProcessGitCommandRunner()});

  final GitCommandRunner runner;

  Future<GitStatusSnapshot> read(String projectPath) async {
    if (projectPath.trim().isEmpty) {
      throw ArgumentError.value(
        projectPath,
        'projectPath',
        'OSI_GIT_PROJECT_PATH_MISSING: Не удалось прочитать состояние Git: путь проекта не указан.',
      );
    }

    final result = await runner.run(
      projectPath: projectPath,
      arguments: _statusArguments,
    );

    if (_isNotRepository(result)) {
      return const GitStatusSnapshot.notRepository();
    }
    if (result.exitCode != 0) {
      throw StateError(
        'OSI_GIT_STATUS_COMMAND_FAILED: Не удалось прочитать состояние Git. Команда `git status` завершилась с кодом ${result.exitCode}: ${result.stderr.trim()}',
      );
    }

    return _parseStatus(result.stdout);
  }

  bool _isNotRepository(GitCommandResult result) {
    return result.exitCode == _notRepositoryExitCode &&
        result.stderr.toLowerCase().contains(_notRepositoryMarker);
  }

  GitStatusSnapshot _parseStatus(String stdout) {
    String? branchLabel;
    final entries = <GitStatusEntry>[];

    for (final line in stdout.split('\n')) {
      if (line.trim().isEmpty) {
        continue;
      }
      if (line.startsWith('## ')) {
        branchLabel = line.substring(3).trim();
        continue;
      }
      if (line.length < 4) {
        throw StateError(
          'OSI_GIT_STATUS_LINE_INVALID: Не удалось прочитать состояние Git: строка porcelain status имеет неверный формат.',
        );
      }

      entries.add(
        GitStatusEntry(
          indexStatus: line[0],
          workTreeStatus: line[1],
          path: _parsePath(line.substring(3)),
        ),
      );
    }

    return GitStatusSnapshot(
      isRepository: true,
      branchLabel: branchLabel,
      entries: List.unmodifiable(entries),
    );
  }

  String _parsePath(String rawPath) {
    final renamedPathSeparator = rawPath.lastIndexOf(' -> ');
    if (renamedPathSeparator >= 0) {
      return rawPath.substring(renamedPathSeparator + 4).trim();
    }

    return rawPath.trim();
  }
}
