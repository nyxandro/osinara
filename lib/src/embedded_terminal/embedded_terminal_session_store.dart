/// Store for embedded terminal tabs and their PTY processes.
///
/// Key constructs:
/// - [EmbeddedTerminalSessionStore]: launches, selects, closes, looks up, and observes terminal sessions.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import '../launch_profiles/launch_profile.dart';
import '../session_titles/cli_session_title_adapter.dart';
import 'embedded_terminal_command.dart';
import 'embedded_terminal_process.dart';
import 'embedded_terminal_session.dart';

const _initialTerminalRows = 24;
const _initialTerminalColumns = 100;
const _terminalMaxLines = 20000;
const _defaultTitlePollInterval = Duration(seconds: 2);

final class EmbeddedTerminalSessionStore extends ChangeNotifier {
  EmbeddedTerminalSessionStore({
    EmbeddedTerminalProcessFactory processLauncher =
        const FlutterPtyProcessFactory(),
    EmbeddedTerminalCommandBuilder commandFactory =
        const EmbeddedTerminalCommandBuilder(),
    this.titleResolver = const CliSessionTitleResolver(),
    this.titlePollInterval = _defaultTitlePollInterval,
  }) : _processFactory = processLauncher,
       _commandBuilder = commandFactory {
    if (titlePollInterval <= Duration.zero) {
      throw ArgumentError.value(
        titlePollInterval,
        'titlePollInterval',
        'OSI_SESSION_TITLE_POLL_INTERVAL_INVALID: Не удалось настроить обновление названий сессий: интервал должен быть больше нуля.',
      );
    }
  }

  final EmbeddedTerminalProcessFactory _processFactory;
  final EmbeddedTerminalCommandBuilder _commandBuilder;
  final CliSessionTitleResolver titleResolver;
  final Duration titlePollInterval;
  final _sessions = <EmbeddedTerminalSession>[];
  final _processesBySessionId = <String, EmbeddedTerminalProcess>{};
  final _titlePollTimersBySessionId = <String, Timer>{};
  final _titleEnvironmentsBySessionId = <String, Map<String, String>>{};
  final _titleRefreshesInFlight = <String>{};
  String? _selectedSessionId;
  var _disposed = false;

  List<EmbeddedTerminalSession> get sessions => List.unmodifiable(_sessions);

  String? get selectedSessionId => _selectedSessionId;

  EmbeddedTerminalSession? get selectedSession {
    final selectedId = _selectedSessionId;
    if (selectedId == null) {
      return null;
    }

    for (final session in _sessions) {
      if (session.id == selectedId) {
        return session;
      }
    }

    return null;
  }

  EmbeddedTerminalSession? sessionById(String sessionId) {
    for (final session in _sessions) {
      if (session.id == sessionId) {
        return session;
      }
    }

    return null;
  }

  Future<EmbeddedTerminalSession> launch({
    required LaunchProfile profile,
    required String projectName,
    required String projectPath,
    required Map<String, String> environment,
  }) async {
    return _startLiveSession(
      id: _newTerminalSessionId(),
      profile: profile,
      projectName: projectName,
      projectPath: projectPath,
      environment: environment,
      selectSession: true,
    );
  }

  Future<EmbeddedTerminalSession> restoreRestarted({
    required String id,
    required LaunchProfile profile,
    required String projectName,
    required String projectPath,
    required Map<String, String> environment,
    String? title,
  }) async {
    try {
      return await _startLiveSession(
        id: id,
        profile: profile,
        projectName: projectName,
        projectPath: projectPath,
        environment: environment,
        title: title,
        selectSession: false,
      );
    } on Object catch (error, stackTrace) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stackTrace,
          library: 'osinara restored terminal launcher',
          context: ErrorDescription('restarting restored terminal session'),
        ),
      );

      return _restoreFailed(
        id: id,
        projectName: projectName,
        projectPath: projectPath,
        profile: profile,
        title: title,
      );
    }
  }

  Future<EmbeddedTerminalSession> _startLiveSession({
    required String id,
    required LaunchProfile profile,
    required String projectName,
    required String projectPath,
    required Map<String, String> environment,
    required bool selectSession,
    String? title,
  }) async {
    final terminal = Terminal(maxLines: _terminalMaxLines);
    final command = _commandBuilder.build(
      command: profile.command,
      arguments: profile.arguments,
      environment: environment,
    );
    final process = await _processFactory.start(
      EmbeddedTerminalProcessRequest(
        executable: command.executable,
        arguments: command.arguments,
        workingDirectory: projectPath,
        environment: environment,
        rows: _initialTerminalRows,
        columns: _initialTerminalColumns,
      ),
    );
    final session = EmbeddedTerminalSession(
      id: id,
      projectName: projectName,
      projectPath: projectPath,
      profile: profile,
      terminal: terminal,
      processId: process.pid,
      title: title,
    );

    _bindTerminalToProcess(session: session, process: process);
    _sessions.add(session);
    _processesBySessionId[session.id] = process;
    if (selectSession) {
      _selectedSessionId = session.id;
    } else {
      _selectedSessionId ??= session.id;
    }
    notifyListeners();
    _startSessionTitlePolling(session: session, environment: environment);

    return session;
  }

  EmbeddedTerminalSession _restoreFailed({
    required String id,
    required String projectName,
    required String projectPath,
    required LaunchProfile profile,
    String? title,
  }) {
    final terminal = Terminal(maxLines: _terminalMaxLines);
    terminal.write(
      'OSI_RESTORED_TERMINAL_RESTART_FAILED: Не удалось заново запустить CLI-инструмент ${profile.agentName}. Проверьте, что команда доступна в PATH, или откройте новую вкладку запуска.\r\n',
    );
    final session = EmbeddedTerminalSession(
      id: id,
      projectName: projectName,
      projectPath: projectPath,
      profile: profile,
      terminal: terminal,
      status: EmbeddedTerminalStatus.failed,
      title: title,
    );

    _sessions.add(session);
    _selectedSessionId ??= session.id;
    notifyListeners();
    return session;
  }

  void updateSessionTitle(String sessionId, String title) {
    final session = sessionById(sessionId);
    if (session == null) {
      return;
    }

    // The store owns outward notifications so workspace persistence and panels stay in sync.
    final previousTitle = session.title;
    session.updateTitle(title);
    if (session.title != previousTitle) {
      _stopSessionTitlePolling(sessionId);
      notifyListeners();
    }
  }

  void selectSession(String sessionId) {
    if (_sessions.every((session) => session.id != sessionId)) {
      return;
    }

    _selectedSessionId = sessionId;
    notifyListeners();
  }

  void closeSession(String sessionId) {
    final index = _sessions.indexWhere((session) => session.id == sessionId);
    if (index < 0) {
      return;
    }

    final session = _sessions.removeAt(index);
    _stopSessionTitlePolling(session.id);
    _processesBySessionId.remove(session.id)?.kill();
    session.dispose();

    if (_selectedSessionId == sessionId) {
      _selectedSessionId = _sessions.isEmpty
          ? null
          : _sessions[index.clamp(0, _sessions.length - 1)].id;
    }

    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final timer in _titlePollTimersBySessionId.values) {
      timer.cancel();
    }
    _titlePollTimersBySessionId.clear();
    _titleEnvironmentsBySessionId.clear();
    _titleRefreshesInFlight.clear();
    for (final process in _processesBySessionId.values) {
      process.kill();
    }
    for (final session in _sessions) {
      session.dispose();
    }
    super.dispose();
  }

  void _bindTerminalToProcess({
    required EmbeddedTerminalSession session,
    required EmbeddedTerminalProcess process,
  }) {
    session.terminal.onOutput = (output) {
      process.write(utf8.encode(output));
    };
    session.terminal.onResize = (columns, rows, _, _) {
      process.resize(rows: rows, columns: columns);
    };
    process.output
        .transform(const Utf8Decoder(allowMalformed: true))
        .listen(session.terminal.write, onError: (_) => session.markFailed());
    unawaited(
      process.exitCode.then((code) {
        if (_disposed || !_sessions.contains(session)) {
          return;
        }

        session.markExited(code);
        session.terminal.write('\r\n[process exited with code $code]\r\n');
        _stopSessionTitlePolling(session.id);
        notifyListeners();
      }),
    );
  }

  void _startSessionTitlePolling({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) {
    if (session.title != null) {
      return;
    }

    // Keep an immutable copy because Platform.environment is external mutable process state.
    _titleEnvironmentsBySessionId[session.id] = Map.unmodifiable(environment);
    unawaited(_refreshSessionTitleOnce(session.id));
    _titlePollTimersBySessionId[session.id] = Timer.periodic(
      titlePollInterval,
      (_) => unawaited(_refreshSessionTitleOnce(session.id)),
    );
  }

  Future<void> _refreshSessionTitleOnce(String sessionId) async {
    if (_disposed || _titleRefreshesInFlight.contains(sessionId)) {
      return;
    }

    final session = sessionById(sessionId);
    final environment = _titleEnvironmentsBySessionId[sessionId];
    if (session == null || environment == null || session.title != null) {
      _stopSessionTitlePolling(sessionId);
      return;
    }

    _titleRefreshesInFlight.add(sessionId);
    try {
      final title = await titleResolver.resolve(
        session: session,
        environment: environment,
      );
      if (_disposed || title == null || sessionById(sessionId) == null) {
        return;
      }

      updateSessionTitle(sessionId, title);
    } on Object catch (error, stackTrace) {
      _stopSessionTitlePolling(sessionId);
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stackTrace,
          library: 'osinara session title resolver',
          context: ErrorDescription(
            'resolving embedded terminal session title',
          ),
        ),
      );
    } finally {
      _titleRefreshesInFlight.remove(sessionId);
    }
  }

  void _stopSessionTitlePolling(String sessionId) {
    _titlePollTimersBySessionId.remove(sessionId)?.cancel();
    _titleEnvironmentsBySessionId.remove(sessionId);
  }
}

String _newTerminalSessionId() {
  return 'terminal-${DateTime.now().toUtc().microsecondsSinceEpoch}';
}
