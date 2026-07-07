/// Immutable snapshot used by the UI to render one agent tab status.
library;

enum AgentSessionState {
  running,
  working,
  waitingForUser,
  permissionRequired,
  finished,
  failed,
  lost,
}

extension AgentSessionStateView on AgentSessionState {
  String get label {
    return switch (this) {
      AgentSessionState.running => 'Running',
      AgentSessionState.working => 'Working',
      AgentSessionState.waitingForUser => 'Needs input',
      AgentSessionState.permissionRequired => 'Permission',
      AgentSessionState.finished => 'Finished',
      AgentSessionState.failed => 'Failed',
      AgentSessionState.lost => 'Lost',
    };
  }
}

final class AgentSessionSnapshot {
  const AgentSessionSnapshot({
    required this.sessionId,
    required this.projectName,
    required this.agentName,
    required this.state,
    required this.startedAt,
    required this.updatedAt,
    this.processId,
    this.lastHeartbeatAt,
    this.finishedAt,
    this.exitCode,
    this.failureCode,
    this.failureMessage,
  });

  final String sessionId;
  final String projectName;
  final String agentName;
  final AgentSessionState state;
  final DateTime startedAt;
  final DateTime updatedAt;
  final int? processId;
  final DateTime? lastHeartbeatAt;
  final DateTime? finishedAt;
  final int? exitCode;
  final String? failureCode;
  final String? failureMessage;

  bool get isActive {
    return switch (state) {
      AgentSessionState.running ||
      AgentSessionState.working ||
      AgentSessionState.waitingForUser ||
      AgentSessionState.permissionRequired => true,
      AgentSessionState.finished ||
      AgentSessionState.failed ||
      AgentSessionState.lost => false,
    };
  }

  bool get needsAttention {
    return switch (state) {
      AgentSessionState.waitingForUser ||
      AgentSessionState.permissionRequired => true,
      _ => false,
    };
  }

  bool get isTerminal {
    return switch (state) {
      AgentSessionState.finished ||
      AgentSessionState.failed ||
      AgentSessionState.lost => true,
      _ => false,
    };
  }

  DateTime get livenessAt {
    return lastHeartbeatAt ?? updatedAt;
  }

  AgentSessionSnapshot copyWith({
    AgentSessionState? state,
    DateTime? updatedAt,
    DateTime? lastHeartbeatAt,
    DateTime? finishedAt,
    int? exitCode,
    String? failureCode,
    String? failureMessage,
  }) {
    return AgentSessionSnapshot(
      sessionId: sessionId,
      projectName: projectName,
      agentName: agentName,
      state: state ?? this.state,
      startedAt: startedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      processId: processId,
      lastHeartbeatAt: lastHeartbeatAt ?? this.lastHeartbeatAt,
      finishedAt: finishedAt ?? this.finishedAt,
      exitCode: exitCode ?? this.exitCode,
      failureCode: failureCode ?? this.failureCode,
      failureMessage: failureMessage ?? this.failureMessage,
    );
  }
}
