import 'dart:async';

import 'package:osinara/src/app/widgets/file_viewer.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_process.dart';
import 'package:osinara/src/file_tree/file_tree_node.dart';
import 'package:osinara/src/file_tree/file_tree_reader.dart';
import 'package:osinara/src/file_tree/file_tree_watch_service.dart';
import 'package:osinara/src/git/git_status_reader.dart';
import 'package:osinara/src/settings/workspace_state.dart';
import 'package:osinara/src/settings/workspace_state_store.dart';

final class MemoryWorkspaceStateRepository implements WorkspaceStateRepository {
  MemoryWorkspaceStateRepository(this.snapshot);

  WorkspaceStateSnapshot? snapshot;

  @override
  Future<WorkspaceStateSnapshot?> read() async => snapshot;

  @override
  Future<void> write(WorkspaceStateSnapshot snapshot) async {
    this.snapshot = snapshot;
  }
}

final class FakeFileContentReader implements FileContentReader {
  const FakeFileContentReader(this.contentByPath);

  final Map<String, String> contentByPath;

  @override
  Future<String> read(String path) async {
    final content = contentByPath[path];
    if (content == null) {
      throw StateError(
        'OSI_TEST_FILE_CONTENT_MISSING: Test file content is missing for $path.',
      );
    }

    return content;
  }
}

final class FakeFileTreeReader extends FileTreeReader {
  const FakeFileTreeReader(this.childrenByPath);

  final Map<String, List<FileTreeNode>> childrenByPath;

  @override
  Future<List<FileTreeNode>> listDirectory(String path) async {
    return List.unmodifiable(childrenByPath[path] ?? const <FileTreeNode>[]);
  }
}

final class NoopFileTreeWatchService implements FileTreeWatchService {
  const NoopFileTreeWatchService();

  @override
  Stream<void> watchDirectory(String path) => const Stream<void>.empty();
}

final class FakeGitCommandRunner implements GitCommandRunner {
  const FakeGitCommandRunner(this.result);

  final GitCommandResult result;

  @override
  Future<GitCommandResult> run({
    required String projectPath,
    required List<String> arguments,
  }) async {
    return result;
  }
}

final class FakeProcessFactory implements EmbeddedTerminalProcessFactory {
  final started = <EmbeddedTerminalProcessRequest>[];
  final processes = <FakeProcess>[];

  @override
  Future<EmbeddedTerminalProcess> start(
    EmbeddedTerminalProcessRequest request,
  ) async {
    started.add(request);
    final process = FakeProcess(2000 + processes.length);
    processes.add(process);
    return process;
  }
}

final class FakeProcess implements EmbeddedTerminalProcess {
  FakeProcess(this.pid);

  final _output = StreamController<List<int>>();
  final _exitCode = Completer<int>();

  @override
  final int pid;

  @override
  Stream<List<int>> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(List<int> data) {}

  @override
  void resize({required int rows, required int columns}) {}

  @override
  bool kill() {
    unawaited(_output.close());
    if (!_exitCode.isCompleted) {
      _exitCode.complete(0);
    }
    return true;
  }
}
