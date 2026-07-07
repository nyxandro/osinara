/// Wiring helper for opening Git authentication dialogs from the workspace shell.
///
/// Key constructs:
/// - [showGitAuthDialog]: composes provider, process launcher, browser launcher, and environment.
library;

import 'package:flutter/material.dart';

import '../git/browser_launcher.dart';
import '../git/git_auth_flow.dart';
import '../git/git_auth_process.dart';
import 'widgets/git_auth_dialog.dart';

export 'widgets/git_auth_dialog.dart' show GitAuthDialogResult;

Future<GitAuthDialogResult?> showGitAuthDialog({
  required BuildContext context,
  required GitAuthProvider provider,
  required GitAuthProcessLauncher processLauncher,
  required BrowserLauncher browserLauncher,
  required Map<String, String> environment,
}) {
  // Provider CLIs remain the credential owner; the dialog only makes their device flow visible.
  return showDialog<GitAuthDialogResult>(
    context: context,
    builder: (context) => GitAuthDialog(
      provider: provider,
      processLauncher: processLauncher,
      browserLauncher: browserLauncher,
      environment: environment,
    ),
  );
}
