/// Polling tailer that applies newly appended event-log entries to the store.
library;

import 'agent_session_event_log.dart';
import 'agent_session_store.dart';

final class AgentSessionEventTailer {
  AgentSessionEventTailer({required this.log, required this.store});

  final AgentSessionEventLog log;
  final AgentSessionStore store;

  var _processedEvents = 0;

  Future<void> poll() async {
    final events = await log.readAll();
    if (_processedEvents > events.length) {
      _processedEvents = 0;
    }

    // Apply only new events so repeated polling does not replay old lifecycle transitions.
    for (final event in events.skip(_processedEvents)) {
      store.apply(event);
    }

    _processedEvents = events.length;
  }
}
