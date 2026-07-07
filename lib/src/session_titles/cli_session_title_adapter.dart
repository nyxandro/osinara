/// Provider-specific session title adapters for embedded CLI sessions.
///
/// Key constructs:
/// - [CliSessionTitleAdapter]: reads a human session title from one CLI tool's logs.
/// - [CliSessionTitleResolver]: selects the adapter for a launched profile.
library;

import '../embedded_terminal/embedded_terminal_session.dart';
import '../launch_profiles/launch_profile.dart';
import 'claude_code_session_title_adapter.dart';
import 'codex_session_title_adapter.dart';
import 'opencode_session_title_adapter.dart';

abstract interface class CliSessionTitleAdapter {
  bool supports(LaunchProfile profile);

  Future<String?> readTitle({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  });
}

const defaultCliSessionTitleAdapters = <CliSessionTitleAdapter>[
  ClaudeCodeSessionTitleAdapter(),
  OpenCodeSessionTitleAdapter(),
  CodexSessionTitleAdapter(),
];

final class CliSessionTitleResolver {
  const CliSessionTitleResolver({
    this.adapters = defaultCliSessionTitleAdapters,
  });

  final List<CliSessionTitleAdapter> adapters;

  Future<String?> resolve({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) async {
    for (final adapter in adapters) {
      if (!adapter.supports(session.profile)) {
        continue;
      }

      final title = await adapter.readTitle(
        session: session,
        environment: environment,
      );
      if (title != null) {
        return title;
      }
    }

    return null;
  }
}
