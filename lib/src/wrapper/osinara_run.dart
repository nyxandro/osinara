/// Runtime implementation for osinara-run: launch child CLI and emit events.
library;

import 'dart:async';
import 'dart:io';

import '../agent_sessions/agent_session_event.dart';
import '../agent_sessions/agent_session_event_log.dart';
import 'osinara_run_arguments.dart';

const wrapperStartupFailureExitCode = 1;

final class OsiRun {
  const OsiRun({required this.now});

  final DateTime Function() now;

  Future<int> run(List<String> rawArgs) async {
    late final OsiRunArguments args;
    try {
      args = OsiRunArguments.parse(rawArgs);
    } on FormatException catch (error) {
      stderr.writeln(error.message);
      return wrapperStartupFailureExitCode;
    }

    final log = AgentSessionEventLog(File(args.eventLogPath));
    final process = await _startChildProcess(args, log);
    if (process == null) {
      return wrapperStartupFailureExitCode;
    }

    await log.append(
      AgentSessionEvent.launched(
        sessionId: args.sessionId,
        projectName: args.projectName,
        agentName: args.agentName,
        processId: process.pid,
        occurredAt: now().toUtc(),
      ),
    );

    // Heartbeat is the minimum reliable signal available for external terminals.
    final timer = Timer.periodic(args.heartbeatInterval, (_) {
      log.append(
        AgentSessionEvent.heartbeat(
          sessionId: args.sessionId,
          occurredAt: now().toUtc(),
        ),
      );
    });

    final exitCode = await process.exitCode;
    timer.cancel();

    if (exitCode == 0) {
      await log.append(
        AgentSessionEvent.finished(
          sessionId: args.sessionId,
          occurredAt: now().toUtc(),
          exitCode: exitCode,
        ),
      );
      return exitCode;
    }

    await log.append(
      AgentSessionEvent.failed(
        sessionId: args.sessionId,
        occurredAt: now().toUtc(),
        exitCode: exitCode,
        failureCode: 'OSI_AGENT_PROCESS_FAILED',
        failureMessage:
            'Процесс агента завершился с ошибкой. Проверьте сообщение в терминале и запустите агента заново.',
      ),
    );
    return exitCode;
  }

  Future<Process?> _startChildProcess(
    OsiRunArguments args,
    AgentSessionEventLog log,
  ) async {
    try {
      return await Process.start(
        args.command,
        args.commandArguments,
        workingDirectory: args.workingDirectory,
        mode: ProcessStartMode.inheritStdio,
      );
    } on Object catch (error) {
      await log.append(
        AgentSessionEvent.failed(
          sessionId: args.sessionId,
          occurredAt: now().toUtc(),
          failureCode: 'OSI_AGENT_PROCESS_START_FAILED',
          failureMessage:
              'Не удалось запустить процесс агента. Проверьте команду, путь проекта и доступность CLI.',
        ),
      );
      stderr.writeln('OSI_AGENT_PROCESS_START_FAILED: $error');
      return null;
    }
  }
}
