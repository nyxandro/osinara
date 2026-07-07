/// File-backed JSONL event log used by osinara-run and the Flutter UI.
library;

import 'dart:convert';
import 'dart:io';

import 'agent_session_event.dart';
import 'agent_session_event_codec.dart';

final class AgentSessionEventLog {
  const AgentSessionEventLog(this.file);

  final File file;

  Future<void> append(AgentSessionEvent event) async {
    final parent = file.parent;
    if (!await parent.exists()) {
      await parent.create(recursive: true);
    }

    final line = jsonEncode(AgentSessionEventCodec.toJson(event));
    await file.writeAsString('$line\n', mode: FileMode.append, flush: true);
  }

  Future<List<AgentSessionEvent>> readAll() async {
    if (!await file.exists()) {
      return const [];
    }

    final lines = await file.readAsLines();
    final events = <AgentSessionEvent>[];

    // Empty lines are ignored so partially edited logs remain readable.
    for (final (index, line) in lines.indexed) {
      if (line.trim().isEmpty) {
        continue;
      }

      final decoded = jsonDecode(line);
      if (decoded is! Map<String, Object?>) {
        throw FormatException(
          'OSI_EVENT_LOG_LINE_INVALID: Не удалось прочитать журнал событий: строка ${index + 1} не является JSON-объектом.',
        );
      }

      events.add(AgentSessionEventCodec.fromJson(decoded));
    }

    return events;
  }
}
