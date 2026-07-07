/// Git provider authentication command and device-code parsing primitives.
///
/// Key constructs:
/// - [GitAuthProvider]: supported Git hosting providers for browser/device login.
/// - [GitAuthCommand]: provider CLI command started by the auth controller.
/// - [GitAuthDevicePrompt]: parsed one-time code and verification URL.
/// - [gitAuthCommand]: maps a provider to a non-token-storing CLI auth command.
/// - [parseGitAuthDevicePrompt]: extracts device-code prompts from provider CLI output.
library;

enum GitAuthProvider { github, gitlab }

enum GitAuthConnectionStatus { unknown, connected, failed }

const githubDeviceVerificationUrl = 'https://github.com/login/device';

final class GitAuthCommand {
  const GitAuthCommand({required this.executable, required this.arguments});

  final String executable;
  final List<String> arguments;
}

final class GitAuthDevicePrompt {
  const GitAuthDevicePrompt({
    required this.code,
    required this.verificationUrl,
  });

  final String code;
  final String verificationUrl;
}

GitAuthCommand gitAuthCommand(GitAuthProvider provider) {
  // Provider CLIs own credential storage; Osinara only starts their browser/device flow.
  return switch (provider) {
    GitAuthProvider.github => const GitAuthCommand(
      executable: 'gh',
      arguments: ['auth', 'login', '--web', '--git-protocol', 'https'],
    ),
    GitAuthProvider.gitlab => const GitAuthCommand(
      executable: 'glab',
      arguments: [
        'auth',
        'login',
        '--hostname',
        'gitlab.com',
        '--device',
        '--git-protocol',
        'https',
      ],
    ),
  };
}

GitAuthDevicePrompt? parseGitAuthDevicePrompt({
  required GitAuthProvider provider,
  required String output,
}) {
  final code = _parseDeviceCode(output);
  if (code == null) {
    return null;
  }

  final verificationUrl = switch (provider) {
    GitAuthProvider.github => githubDeviceVerificationUrl,
    GitAuthProvider.gitlab => _parseFirstUrl(output),
  };
  if (verificationUrl == null) {
    return null;
  }

  return GitAuthDevicePrompt(code: code, verificationUrl: verificationUrl);
}

String? _parseDeviceCode(String output) {
  final codeLinePattern = RegExp(r'code[^\n]*', caseSensitive: false);
  final codePattern = RegExp(r'\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b');

  for (final lineMatch in codeLinePattern.allMatches(output)) {
    final codeMatch = codePattern.firstMatch(lineMatch.group(0)!);
    if (codeMatch != null) {
      return codeMatch.group(0);
    }
  }

  return codePattern.firstMatch(output)?.group(0);
}

String? _parseFirstUrl(String output) {
  final match = RegExp(r'https?://[^\s]+').firstMatch(output);
  return match?.group(0)?.replaceFirst(RegExp(r'[,.);]+$'), '');
}
