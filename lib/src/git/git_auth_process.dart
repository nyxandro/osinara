/// Process boundary for provider CLI authentication commands.
///
/// Key constructs:
/// - [GitAuthProcessRequest]: command, environment, and optional working directory.
/// - [GitAuthProcessLauncher]: starts provider CLIs without exposing tokens to Osinara.
/// - [GitAuthProcess]: output/stdin/exit-code interface used by the controller.
/// - [ProcessGitAuthLauncher]: production implementation backed by [Process.start].
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'git_auth_flow.dart';

abstract interface class GitAuthProcessLauncher {
  Future<GitAuthProcess> start(GitAuthProcessRequest request);
}

abstract interface class GitAuthProcess {
  Stream<String> get output;
  Future<int> get exitCode;
  void write(String data);
  bool kill();
}

final class GitAuthProcessRequest {
  const GitAuthProcessRequest({
    required this.provider,
    required this.command,
    required this.environment,
    this.workingDirectory,
  });

  final GitAuthProvider provider;
  final GitAuthCommand command;
  final Map<String, String> environment;
  final String? workingDirectory;
}

final class ProcessGitAuthLauncher implements GitAuthProcessLauncher {
  const ProcessGitAuthLauncher();

  @override
  Future<GitAuthProcess> start(GitAuthProcessRequest request) async {
    try {
      final process = await Process.start(
        request.command.executable,
        request.command.arguments,
        workingDirectory: request.workingDirectory,
        environment: request.environment,
        runInShell: false,
      );
      return _ProcessGitAuthProcess(process);
    } on Object catch (error) {
      throw StateError(
        'OSI_GIT_AUTH_START_FAILED: Не удалось запустить ${request.command.executable}. Установите CLI провайдера и проверьте PATH. Подробности: $error',
      );
    }
  }
}

final class _ProcessGitAuthProcess implements GitAuthProcess {
  _ProcessGitAuthProcess(this._process) : _output = StreamController<String>() {
    // stdout and stderr both carry interactive prompts, so the controller consumes one merged stream.
    _pipe(_process.stdout);
    _pipe(_process.stderr);
  }

  final Process _process;
  final StreamController<String> _output;
  var _openPipes = 2;

  @override
  Stream<String> get output => _output.stream;

  @override
  Future<int> get exitCode => _process.exitCode;

  @override
  void write(String data) {
    _process.stdin.write(data);
  }

  @override
  bool kill() => _process.kill();

  void _pipe(Stream<List<int>> stream) {
    stream
        .transform(utf8.decoder)
        .listen(
          _output.add,
          onError: _output.addError,
          onDone: () {
            _openPipes -= 1;
            if (_openPipes == 0) {
              unawaited(_output.close());
            }
          },
        );
  }
}
