/// JSON persistence for full workspace state between app launches.
///
/// Key constructs:
/// - [WorkspaceStateRepository]: storage contract for workspace snapshots.
/// - [WorkspaceStateStore]: file-backed JSON repository.
library;

import 'dart:convert';
import 'dart:io';

import 'workspace_state.dart';

const _jsonIndent = '  ';

abstract interface class WorkspaceStateRepository {
  Future<WorkspaceStateSnapshot?> read();

  Future<void> write(WorkspaceStateSnapshot snapshot);
}

final class WorkspaceStateStore implements WorkspaceStateRepository {
  const WorkspaceStateStore(this.file);

  final File file;

  @override
  Future<WorkspaceStateSnapshot?> read() async {
    if (!await file.exists()) {
      return null;
    }

    final raw = await file.readAsString();
    final decoded = jsonDecode(raw);
    return WorkspaceStateSnapshot.fromJson(decoded);
  }

  @override
  Future<void> write(WorkspaceStateSnapshot snapshot) async {
    final parent = file.parent;
    if (!await parent.exists()) {
      await parent.create(recursive: true);
    }

    const encoder = JsonEncoder.withIndent(_jsonIndent);
    await file.writeAsString('${encoder.convert(snapshot.toJson())}\n');
  }
}
