/// Process abstraction for embedded PTY-backed terminal sessions.
///
/// Key constructs:
/// - [EmbeddedTerminalProcessRequest]: validated process start request.
/// - [EmbeddedTerminalProcess]: common interface used by store and tests.
/// - [EmbeddedTerminalProcessFactory]: injectable process launcher contract.
/// - [FlutterPtyProcessFactory]: production launcher using `flutter_pty`.
library;

import 'package:flutter_pty/flutter_pty.dart';
import 'dart:typed_data';

final class EmbeddedTerminalProcessRequest {
  const EmbeddedTerminalProcessRequest({
    required this.executable,
    required this.arguments,
    required this.workingDirectory,
    required this.environment,
    required this.rows,
    required this.columns,
  });

  final String executable;
  final List<String> arguments;
  final String workingDirectory;
  final Map<String, String> environment;
  final int rows;
  final int columns;
}

abstract interface class EmbeddedTerminalProcess {
  int get pid;

  Stream<List<int>> get output;

  Future<int> get exitCode;

  void write(List<int> data);

  void resize({required int rows, required int columns});

  bool kill();
}

abstract interface class EmbeddedTerminalProcessFactory {
  Future<EmbeddedTerminalProcess> start(EmbeddedTerminalProcessRequest request);
}

final class FlutterPtyProcessFactory implements EmbeddedTerminalProcessFactory {
  const FlutterPtyProcessFactory();

  @override
  Future<EmbeddedTerminalProcess> start(
    EmbeddedTerminalProcessRequest request,
  ) async {
    final pty = Pty.start(
      request.executable,
      arguments: request.arguments,
      workingDirectory: request.workingDirectory,
      environment: request.environment,
      rows: request.rows,
      columns: request.columns,
    );

    return _FlutterPtyProcess(pty);
  }
}

final class _FlutterPtyProcess implements EmbeddedTerminalProcess {
  const _FlutterPtyProcess(this._pty);

  final Pty _pty;

  @override
  int get pid => _pty.pid;

  @override
  Stream<List<int>> get output => _pty.output.cast<List<int>>();

  @override
  Future<int> get exitCode => _pty.exitCode;

  @override
  void write(List<int> data) {
    _pty.write(Uint8List.fromList(data));
  }

  @override
  void resize({required int rows, required int columns}) {
    _pty.resize(rows, columns);
  }

  @override
  bool kill() {
    return _pty.kill();
  }
}
