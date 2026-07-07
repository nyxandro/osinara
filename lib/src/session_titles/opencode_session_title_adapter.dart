/// OpenCode session title adapter placeholder.
///
/// Key constructs:
/// - [OpenCodeSessionTitleAdapter]: reserves the provider-specific integration point for OpenCode logs.
library;

import '../embedded_terminal/embedded_terminal_session.dart';
import '../launch_profiles/launch_profile.dart';
import 'cli_session_title_adapter.dart';

final class OpenCodeSessionTitleAdapter implements CliSessionTitleAdapter {
  const OpenCodeSessionTitleAdapter();

  @override
  bool supports(LaunchProfile profile) {
    return _commandName(profile.command) == 'opencode' ||
        profile.agentName.toLowerCase().contains('opencode');
  }

  @override
  Future<String?> readTitle({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) async {
    return null;
  }
}

String _commandName(String command) {
  final normalized = command.replaceAll('\\', '/');
  final slashIndex = normalized.lastIndexOf('/');
  return slashIndex < 0 ? normalized : normalized.substring(slashIndex + 1);
}
