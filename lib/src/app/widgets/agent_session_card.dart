/// Visual card for one CLI-agent session and its current activity state.
library;

import 'package:flutter/material.dart';

import '../../agent_sessions/agent_session_snapshot.dart';
import '../../localization/app_strings.dart';

const _cardMinHeight = 180.0;

class AgentSessionCard extends StatelessWidget {
  const AgentSessionCard({super.key, required this.session});

  final AgentSessionSnapshot session;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colors = _StatusColors.forState(context, session.state);
    final statusLabel = strings.sessionStateLabel(session.state);

    // Color is paired with text and icons so status remains readable without color alone.
    return Semantics(
      label: '${session.agentName} status $statusLabel',
      child: Card(
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: _cardMinHeight),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    _StatusDot(colors: colors),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        session.agentName,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _StatusPill(label: statusLabel, colors: colors),
                const SizedBox(height: 28),
                Text('${strings.projectPathLabel}: ${session.projectName}'),
                const SizedBox(height: 6),
                Text(
                  '${strings.processIdLabel}: ${session.processId ?? strings.notAvailable}',
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.colors});

  final String label;
  final _StatusColors colors;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.background,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: colors.foreground.withValues(alpha: 0.42)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Text(
          label,
          style: TextStyle(
            color: colors.foreground,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.colors});

  final _StatusColors colors;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.foreground,
        shape: BoxShape.circle,
        boxShadow: [
          BoxShadow(
            color: colors.foreground.withValues(alpha: 0.5),
            blurRadius: 18,
            spreadRadius: 1,
          ),
        ],
      ),
      child: const SizedBox.square(dimension: 14),
    );
  }
}

final class _StatusColors {
  const _StatusColors({required this.foreground, required this.background});

  final Color foreground;
  final Color background;

  static _StatusColors forState(BuildContext context, AgentSessionState state) {
    final scheme = Theme.of(context).colorScheme;

    return switch (state) {
      AgentSessionState.running => _StatusColors(
        foreground: scheme.primary,
        background: scheme.primaryContainer.withValues(alpha: 0.34),
      ),
      AgentSessionState.working => const _StatusColors(
        foreground: Color(0xFF7DD3FC),
        background: Color(0x1F7DD3FC),
      ),
      AgentSessionState.waitingForUser ||
      AgentSessionState.permissionRequired => const _StatusColors(
        foreground: Color(0xFFFBBF24),
        background: Color(0x22FBBF24),
      ),
      AgentSessionState.finished => const _StatusColors(
        foreground: Color(0xFF34D399),
        background: Color(0x2234D399),
      ),
      AgentSessionState.failed || AgentSessionState.lost => const _StatusColors(
        foreground: Color(0xFFF87171),
        background: Color(0x22F87171),
      ),
    };
  }
}
