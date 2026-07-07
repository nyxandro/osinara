/// High-level Git repository actions used by the Git side panel.
///
/// Key constructs:
/// - [GitActionRunner]: process boundary for `git`, `gh`, and `glab` commands.
/// - [GitActionResult]: command exit-code/stdout/stderr DTO.
/// - [GitRemoteProvider], [GitRepositoryVisibility]: explicit publish choices.
/// - [GitPublishRequest]: required publish fields with no hidden defaults.
/// - [GitRepositoryActions]: production operations for init and publish.
library;

import 'dart:io';

enum GitRemoteProvider { github, gitlab }

enum GitRepositoryVisibility { private, internal, public }

abstract interface class GitActionRunner {
  Future<GitActionResult> run({
    required String executable,
    required List<String> arguments,
    required String workingDirectory,
  });
}

final class ProcessGitActionRunner implements GitActionRunner {
  const ProcessGitActionRunner();

  @override
  Future<GitActionResult> run({
    required String executable,
    required List<String> arguments,
    required String workingDirectory,
  }) async {
    final result = await Process.run(
      executable,
      arguments,
      workingDirectory: workingDirectory,
      runInShell: false,
    );

    return GitActionResult(
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    );
  }
}

final class GitActionResult {
  const GitActionResult({
    required this.exitCode,
    required this.stdout,
    required this.stderr,
  });

  final int exitCode;
  final String stdout;
  final String stderr;
}

final class GitPublishRequest {
  const GitPublishRequest({
    required this.provider,
    required this.owner,
    required this.repositoryName,
    required this.visibility,
    required this.remoteName,
    required this.projectPath,
  });

  final GitRemoteProvider provider;
  final String owner;
  final String repositoryName;
  final GitRepositoryVisibility visibility;
  final String remoteName;
  final String projectPath;
}

class GitRepositoryActions {
  const GitRepositoryActions({this.runner = const ProcessGitActionRunner()});

  final GitActionRunner runner;

  Future<void> initialize(String projectPath) async {
    _validateRequired(projectPath, 'projectPath', 'OSI_GIT_INIT_PATH_MISSING');
    await _runChecked(
      executable: 'git',
      arguments: const ['init'],
      workingDirectory: projectPath,
      errorCode: 'OSI_GIT_INIT_FAILED',
      humanAction: 'инициализировать Git-репозиторий',
    );
  }

  Future<void> publish(GitPublishRequest request) async {
    _validatePublishRequest(request);
    final branchName = await _currentBranch(request.projectPath);

    await _runChecked(
      executable: _providerExecutable(request.provider),
      arguments: _repoCreateArguments(request),
      workingDirectory: request.projectPath,
      errorCode: 'OSI_GIT_PUBLISH_CREATE_FAILED',
      humanAction: 'создать удалённый репозиторий',
    );
    await _runChecked(
      executable: 'git',
      arguments: ['push', '-u', request.remoteName, branchName],
      workingDirectory: request.projectPath,
      errorCode: 'OSI_GIT_PUBLISH_PUSH_FAILED',
      humanAction: 'отправить текущую ветку в удалённый репозиторий',
    );
  }

  Future<String> _currentBranch(String projectPath) async {
    final result = await _runChecked(
      executable: 'git',
      arguments: const ['branch', '--show-current'],
      workingDirectory: projectPath,
      errorCode: 'OSI_GIT_BRANCH_READ_FAILED',
      humanAction: 'прочитать текущую ветку Git',
    );
    final branchName = result.stdout.trim();
    _validateRequired(branchName, 'branchName', 'OSI_GIT_BRANCH_MISSING');
    return branchName;
  }

  Future<GitActionResult> _runChecked({
    required String executable,
    required List<String> arguments,
    required String workingDirectory,
    required String errorCode,
    required String humanAction,
  }) async {
    try {
      final result = await runner.run(
        executable: executable,
        arguments: arguments,
        workingDirectory: workingDirectory,
      );
      if (result.exitCode == 0) {
        return result;
      }

      throw StateError(
        '$errorCode: Не удалось $humanAction. Команда `$executable ${arguments.join(' ')}` завершилась с кодом ${result.exitCode}: ${result.stderr.trim()}',
      );
    } on StateError {
      rethrow;
    } on Object catch (error) {
      throw StateError(
        '$errorCode: Не удалось $humanAction. Проверьте, что `$executable` установлен и доступен в PATH. Подробности: $error',
      );
    }
  }
}

void _validatePublishRequest(GitPublishRequest request) {
  _validateRequired(
    request.projectPath,
    'projectPath',
    'OSI_GIT_PUBLISH_PATH_MISSING',
  );
  _validateRequired(request.owner, 'owner', 'OSI_GIT_PUBLISH_OWNER_MISSING');
  _validateRequired(
    request.repositoryName,
    'repositoryName',
    'OSI_GIT_PUBLISH_REPOSITORY_MISSING',
  );
  _validateRequired(
    request.remoteName,
    'remoteName',
    'OSI_GIT_PUBLISH_REMOTE_MISSING',
  );
}

void _validateRequired(String value, String fieldName, String errorCode) {
  if (value.trim().isEmpty) {
    throw ArgumentError.value(
      value,
      fieldName,
      '$errorCode: Не удалось выполнить Git-операцию: обязательное поле не заполнено.',
    );
  }
}

String _providerExecutable(GitRemoteProvider provider) {
  return switch (provider) {
    GitRemoteProvider.github => 'gh',
    GitRemoteProvider.gitlab => 'glab',
  };
}

List<String> _repoCreateArguments(GitPublishRequest request) {
  return switch (request.provider) {
    GitRemoteProvider.github => [
      'repo',
      'create',
      '${request.owner}/${request.repositoryName}',
      _githubVisibilityFlag(request.visibility),
      '--source',
      request.projectPath,
      '--remote',
      request.remoteName,
    ],
    GitRemoteProvider.gitlab => [
      'repo',
      'create',
      '${request.owner}/${request.repositoryName}',
      '--visibility',
      request.visibility.name,
      '--remoteName',
      request.remoteName,
    ],
  };
}

String _githubVisibilityFlag(GitRepositoryVisibility visibility) {
  return switch (visibility) {
    GitRepositoryVisibility.private => '--private',
    GitRepositoryVisibility.internal => '--internal',
    GitRepositoryVisibility.public => '--public',
  };
}
