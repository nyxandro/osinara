/// Dialog for browser/device Git authentication through provider CLIs.
///
/// Key constructs:
/// - [GitAuthDialog]: starts the provider CLI in the background and shows device-code progress.
/// - [_GitAuthDialogBody]: renders code, verification URL, status, and diagnostic output.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../git/browser_launcher.dart';
import '../../git/git_auth_controller.dart';
import '../../git/git_auth_flow.dart';
import '../../git/git_auth_process.dart';
import '../../localization/app_git_auth_strings.dart';
import '../../localization/app_strings.dart';

const _gitAuthDialogWidth = 560.0;
const _gitAuthLogMaxHeight = 160.0;
const _gitAuthAutoCloseDelay = Duration(milliseconds: 450);

enum GitAuthDialogResult { succeeded, failed, cancelled }

class GitAuthDialog extends StatefulWidget {
  const GitAuthDialog({
    super.key,
    required this.provider,
    required this.processLauncher,
    required this.browserLauncher,
    required this.environment,
    this.workingDirectory,
  });

  final GitAuthProvider provider;
  final GitAuthProcessLauncher processLauncher;
  final BrowserLauncher browserLauncher;
  final Map<String, String> environment;
  final String? workingDirectory;

  @override
  State<GitAuthDialog> createState() => _GitAuthDialogState();
}

class _GitAuthDialogState extends State<GitAuthDialog> {
  late final GitAuthController _controller;
  Timer? _autoCloseTimer;
  var _codeCopied = false;
  var _autoCloseScheduled = false;

  @override
  void initState() {
    super.initState();
    _controller = GitAuthController(
      provider: widget.provider,
      processLauncher: widget.processLauncher,
      browserLauncher: widget.browserLauncher,
      environment: widget.environment,
      workingDirectory: widget.workingDirectory,
    );
    _controller.addListener(_handleControllerChanged);
    unawaited(_controller.start());
  }

  @override
  void dispose() {
    _autoCloseTimer?.cancel();
    _controller.removeListener(_handleControllerChanged);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final providerName = strings.gitAuthProviderName(widget.provider);

    return AlertDialog(
      title: Text(strings.gitAuthDialogTitle(providerName)),
      content: SizedBox(
        width: _gitAuthDialogWidth,
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) => _GitAuthDialogBody(
            providerName: providerName,
            state: _controller.state,
            codeCopied: _codeCopied,
            onCopyCode: _copyCode,
            onOpenBrowser: _openBrowserAgain,
          ),
        ),
      ),
      actions: [
        AnimatedBuilder(
          animation: _controller,
          builder: (context, _) {
            final terminal = _isTerminalStatus(_controller.state.status);
            return TextButton(
              onPressed: () {
                if (!terminal) {
                  _controller.cancel();
                  Navigator.of(context).pop(GitAuthDialogResult.cancelled);
                  return;
                }
                Navigator.of(context).pop(_dialogResultFor(_controller.state));
              },
              child: Text(terminal ? strings.close : strings.cancel),
            );
          },
        ),
      ],
    );
  }

  Future<void> _copyCode() async {
    final code = _controller.state.deviceCode;
    if (code == null) {
      return;
    }

    await Clipboard.setData(ClipboardData(text: code));
    if (mounted) {
      setState(() => _codeCopied = true);
    }
  }

  Future<void> _openBrowserAgain() async {
    await _controller.openBrowserAgain();
  }

  void _handleControllerChanged() {
    if (_autoCloseScheduled ||
        _controller.state.status != GitAuthStatus.succeeded) {
      return;
    }

    _autoCloseScheduled = true;
    _autoCloseTimer = Timer(_gitAuthAutoCloseDelay, () {
      if (mounted) {
        Navigator.of(context).pop(GitAuthDialogResult.succeeded);
      }
    });
  }
}

class _GitAuthDialogBody extends StatelessWidget {
  const _GitAuthDialogBody({
    required this.providerName,
    required this.state,
    required this.codeCopied,
    required this.onCopyCode,
    required this.onOpenBrowser,
  });

  final String providerName;
  final GitAuthState state;
  final bool codeCopied;
  final VoidCallback onCopyCode;
  final VoidCallback onOpenBrowser;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          _StatusRow(state: state, providerName: providerName),
          if (state.browserOpenFailed) ...[
            const SizedBox(height: 14),
            Text(
              strings.gitAuthBrowserOpenFailed,
              style: TextStyle(color: colorScheme.error),
            ),
          ],
          if (state.deviceCode != null) ...[
            const SizedBox(height: 18),
            Text(strings.gitAuthCodeLabel),
            const SizedBox(height: 8),
            _DeviceCodeBox(code: state.deviceCode!),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                OutlinedButton.icon(
                  key: const Key('git-auth-copy-code-button'),
                  onPressed: onCopyCode,
                  icon: Icon(codeCopied ? Icons.check_rounded : Icons.copy),
                  label: Text(
                    codeCopied ? strings.gitAuthCodeCopied : strings.copy,
                  ),
                ),
                if (state.verificationUrl != null)
                  OutlinedButton.icon(
                    key: const Key('git-auth-open-browser-button'),
                    onPressed: onOpenBrowser,
                    icon: const Icon(Icons.open_in_browser_rounded),
                    label: Text(strings.gitAuthOpenBrowser),
                  ),
              ],
            ),
          ],
          if (state.verificationUrl != null) ...[
            const SizedBox(height: 18),
            Text(strings.gitAuthUrlLabel),
            const SizedBox(height: 6),
            SelectableText(
              state.verificationUrl!,
              style: TextStyle(color: colorScheme.primary),
            ),
          ],
          if (state.failureMessage != null) ...[
            const SizedBox(height: 18),
            Text(
              state.failureMessage!,
              style: TextStyle(color: colorScheme.error),
            ),
          ],
          if (state.output.trim().isNotEmpty) ...[
            const SizedBox(height: 18),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(strings.gitAuthTechnicalLog),
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: _gitAuthLogMaxHeight,
                  ),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      state.output.trim(),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.state, required this.providerName});

  final GitAuthState state;
  final String providerName;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final terminal = _isTerminalStatus(state.status);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (terminal)
          Icon(
            state.status == GitAuthStatus.succeeded
                ? Icons.check_circle_rounded
                : Icons.error_rounded,
            color: state.status == GitAuthStatus.succeeded
                ? colorScheme.primary
                : colorScheme.error,
          )
        else
          const SizedBox.square(
            dimension: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        const SizedBox(width: 12),
        Expanded(child: Text(_statusText(strings, providerName, state))),
      ],
    );
  }
}

class _DeviceCodeBox extends StatelessWidget {
  const _DeviceCodeBox({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colorScheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        child: SelectableText(
          code,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            letterSpacing: 2,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ),
    );
  }
}

String _statusText(
  AppStrings strings,
  String providerName,
  GitAuthState state,
) {
  return switch (state.status) {
    GitAuthStatus.idle ||
    GitAuthStatus.starting => strings.gitAuthStarting(providerName),
    GitAuthStatus.waitingForCode => strings.gitAuthWaitingForCode(providerName),
    GitAuthStatus.waitingForConfirmation =>
      strings.gitAuthWaitingForConfirmation(providerName),
    GitAuthStatus.succeeded => strings.gitAuthSucceeded(providerName),
    GitAuthStatus.failed => strings.gitAuthFailed(providerName),
    GitAuthStatus.cancelled => strings.gitAuthCancelled(providerName),
  };
}

bool _isTerminalStatus(GitAuthStatus status) {
  return status == GitAuthStatus.succeeded ||
      status == GitAuthStatus.failed ||
      status == GitAuthStatus.cancelled;
}

GitAuthDialogResult _dialogResultFor(GitAuthState state) {
  return switch (state.status) {
    GitAuthStatus.succeeded => GitAuthDialogResult.succeeded,
    GitAuthStatus.failed => GitAuthDialogResult.failed,
    GitAuthStatus.cancelled => GitAuthDialogResult.cancelled,
    _ => GitAuthDialogResult.cancelled,
  };
}
