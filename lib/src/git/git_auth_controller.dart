/// Background controller for provider CLI browser/device authentication.
///
/// Key constructs:
/// - [GitAuthStatus]: lifecycle states shown by the auth dialog.
/// - [GitAuthState]: immutable UI snapshot with code, URL, errors, and log output.
/// - [GitAuthController]: starts provider CLI, parses device prompts, opens browser, and tracks completion.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'browser_launcher.dart';
import 'git_auth_flow.dart';
import 'git_auth_process.dart';

const _gitAuthContinueInput = '\n';
const _successExitCode = 0;

enum GitAuthStatus {
  idle,
  starting,
  waitingForCode,
  waitingForConfirmation,
  succeeded,
  failed,
  cancelled,
}

final class GitAuthState {
  const GitAuthState({
    required this.status,
    this.deviceCode,
    this.verificationUrl,
    this.browserOpened = false,
    this.browserOpenFailed = false,
    this.failureMessage,
    this.output = '',
  });

  const GitAuthState.idle() : this(status: GitAuthStatus.idle);

  final GitAuthStatus status;
  final String? deviceCode;
  final String? verificationUrl;
  final bool browserOpened;
  final bool browserOpenFailed;
  final String? failureMessage;
  final String output;

  GitAuthState copyWith({
    GitAuthStatus? status,
    String? deviceCode,
    String? verificationUrl,
    bool? browserOpened,
    bool? browserOpenFailed,
    String? failureMessage,
    String? output,
  }) {
    return GitAuthState(
      status: status ?? this.status,
      deviceCode: deviceCode ?? this.deviceCode,
      verificationUrl: verificationUrl ?? this.verificationUrl,
      browserOpened: browserOpened ?? this.browserOpened,
      browserOpenFailed: browserOpenFailed ?? this.browserOpenFailed,
      failureMessage: failureMessage ?? this.failureMessage,
      output: output ?? this.output,
    );
  }
}

final class GitAuthController extends ChangeNotifier {
  GitAuthController({
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

  GitAuthState _state = const GitAuthState.idle();
  GitAuthProcess? _process;
  StreamSubscription<String>? _outputSubscription;
  var _promptHandled = false;
  var _cancelled = false;
  var _disposed = false;

  GitAuthState get state => _state;

  Future<void> start() async {
    if (_state.status != GitAuthStatus.idle) {
      return;
    }

    _setState(const GitAuthState(status: GitAuthStatus.starting));
    final command = gitAuthCommand(provider);
    try {
      final process = await processLauncher.start(
        GitAuthProcessRequest(
          provider: provider,
          command: command,
          environment: environment,
          workingDirectory: workingDirectory,
        ),
      );
      _process = process;
      _setState(_state.copyWith(status: GitAuthStatus.waitingForCode));
      _outputSubscription = process.output.listen(_handleOutput);
      unawaited(_watchExit(process.exitCode));
    } on Object catch (error) {
      _fail(
        'OSI_GIT_AUTH_START_FAILED: Не удалось начать авторизацию Git. Установите CLI провайдера и проверьте PATH. Подробности: $error',
      );
    }
  }

  Future<void> openBrowserAgain() async {
    final url = _state.verificationUrl;
    if (url == null) {
      throw StateError(
        'OSI_GIT_AUTH_URL_MISSING: Не удалось открыть браузер: ссылка авторизации ещё не получена.',
      );
    }

    await _openBrowser(url);
  }

  void cancel() {
    _cancelled = true;
    _process?.kill();
    _setState(_state.copyWith(status: GitAuthStatus.cancelled));
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_outputSubscription?.cancel());
    if (!_isTerminalStatus(_state.status)) {
      _process?.kill();
    }
    super.dispose();
  }

  void _handleOutput(String chunk) {
    final output = '${_state.output}$chunk';
    _setState(_state.copyWith(output: output));
    if (_promptHandled) {
      return;
    }

    final prompt = parseGitAuthDevicePrompt(provider: provider, output: output);
    if (prompt == null) {
      return;
    }

    _promptHandled = true;
    _process?.write(_gitAuthContinueInput);
    _setState(
      _state.copyWith(
        status: GitAuthStatus.waitingForConfirmation,
        deviceCode: prompt.code,
        verificationUrl: prompt.verificationUrl,
      ),
    );
    unawaited(_openBrowser(prompt.verificationUrl));
  }

  Future<void> _openBrowser(String url) async {
    try {
      await browserLauncher.open(url);
      if (!_isTerminalStatus(_state.status)) {
        _setState(
          _state.copyWith(browserOpened: true, browserOpenFailed: false),
        );
      }
    } on Object catch (_) {
      if (!_isTerminalStatus(_state.status)) {
        _setState(
          _state.copyWith(browserOpened: false, browserOpenFailed: true),
        );
      }
    }
  }

  Future<void> _watchExit(Future<int> exitCodeFuture) async {
    final exitCode = await exitCodeFuture;
    if (_cancelled || _disposed) {
      return;
    }
    if (exitCode == _successExitCode) {
      _setState(
        _state.copyWith(
          status: GitAuthStatus.succeeded,
          browserOpenFailed: false,
        ),
      );
      return;
    }

    _fail(
      'OSI_GIT_AUTH_FAILED: Авторизация Git не завершилась. CLI провайдера завершился с кодом $exitCode. Попробуйте ещё раз или выполните вход вручную в терминале.',
    );
  }

  void _fail(String message) {
    _setState(
      _state.copyWith(status: GitAuthStatus.failed, failureMessage: message),
    );
  }

  void _setState(GitAuthState state) {
    if (_disposed) {
      return;
    }

    _state = state;
    notifyListeners();
  }
}

bool _isTerminalStatus(GitAuthStatus status) {
  return status == GitAuthStatus.succeeded ||
      status == GitAuthStatus.failed ||
      status == GitAuthStatus.cancelled;
}
