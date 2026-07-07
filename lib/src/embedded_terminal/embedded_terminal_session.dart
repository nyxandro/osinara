/// State model for one embedded CLI terminal tab.
///
/// Key constructs:
/// - [EmbeddedTerminalStatus]: lifecycle state shown in tabs and project list.
/// - [EmbeddedTerminalSession]: terminal, process metadata, title, and lifecycle notifier.
library;

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import '../launch_profiles/launch_profile.dart';

enum EmbeddedTerminalStatus { starting, running, exited, failed }

final class EmbeddedTerminalSession extends ChangeNotifier {
  EmbeddedTerminalSession({
    required this.id,
    required this.projectName,
    required this.projectPath,
    required this.profile,
    required this.terminal,
    DateTime? startedAt,
    this.processId,
    this.status = EmbeddedTerminalStatus.running,
    this.exitCode,
    String? title,
  }) : startedAt = startedAt ?? DateTime.now().toUtc(),
       // Keep title writes behind updateTitle so listeners are always notified.
       // ignore: prefer_initializing_formals
       _title = title;

  final String id;
  final String projectName;
  final String projectPath;
  final LaunchProfile profile;
  final Terminal terminal;
  final DateTime startedAt;
  final int? processId;
  EmbeddedTerminalStatus status;
  int? exitCode;
  String? _title;

  String? get title => _title;

  void updateTitle(String title) {
    final normalized = title.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(
        title,
        'title',
        'OSI_SESSION_TITLE_EMPTY: Не удалось обновить название сессии: title пустой. Передайте непустое название.',
      );
    }
    if (_title == normalized) {
      return;
    }

    // Session title is mutable metadata derived from external CLI logs after the first prompt.
    _title = normalized;
    notifyListeners();
  }

  void markExited(int code) {
    status = EmbeddedTerminalStatus.exited;
    exitCode = code;
    notifyListeners();
  }

  void markFailed() {
    status = EmbeddedTerminalStatus.failed;
    notifyListeners();
  }
}
