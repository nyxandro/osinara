/// Codex CLI log adapter for deriving a session title from local JSONL sessions.
///
/// Key constructs:
/// - [CodexSessionTitleAdapter]: matches Codex JSONL sessions by cwd/start time and reads the first user prompt.
library;

import 'dart:convert';
import 'dart:io';

import '../embedded_terminal/embedded_terminal_session.dart';
import '../launch_profiles/launch_profile.dart';
import 'cli_session_title_adapter.dart';

const _codexDirectoryName = '.codex';
const _sessionsDirectoryName = 'sessions';
const _sessionStartTolerance = Duration(seconds: 30);
const _jsonlHeadBytes = 512 * 1024;
const _maxTitleLength = 80;
const _titleOverflowSuffix = '...';

final class CodexSessionTitleAdapter implements CliSessionTitleAdapter {
  const CodexSessionTitleAdapter();

  @override
  bool supports(LaunchProfile profile) {
    return _commandName(profile.command) == 'codex' ||
        profile.agentName.toLowerCase().contains('codex');
  }

  @override
  Future<String?> readTitle({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) async {
    final sessionsDirectory = _sessionsDirectory(environment);
    if (sessionsDirectory == null || !await sessionsDirectory.exists()) {
      return null;
    }

    final transcript = await _latestMatchingTranscript(
      sessionsDirectory: sessionsDirectory,
      session: session,
    );
    if (transcript == null) {
      return null;
    }

    return _readPromptTitle(transcript);
  }

  Directory? _sessionsDirectory(Map<String, String> environment) {
    final home = environment['HOME'];
    if (home == null || home.trim().isEmpty) {
      return null;
    }

    return Directory(
      _join(_join(home, _codexDirectoryName), _sessionsDirectoryName),
    );
  }

  Future<File?> _latestMatchingTranscript({
    required Directory sessionsDirectory,
    required EmbeddedTerminalSession session,
  }) async {
    File? bestFile;
    var bestStartedAt = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
    final minimumStartedAt = session.startedAt.subtract(_sessionStartTolerance);

    await for (final entity in sessionsDirectory.list(
      recursive: true,
      followLinks: false,
    )) {
      if (entity is! File || !entity.path.endsWith('.jsonl')) {
        continue;
      }

      final metadata = await _readSessionMetadata(entity);
      if (metadata == null || metadata.cwd != session.projectPath) {
        continue;
      }
      if (metadata.startedAt.isBefore(minimumStartedAt)) {
        continue;
      }

      if (metadata.startedAt.isAfter(bestStartedAt)) {
        bestStartedAt = metadata.startedAt;
        bestFile = entity;
      }
    }

    return bestFile;
  }

  Future<_CodexSessionMetadata?> _readSessionMetadata(File transcript) async {
    final lines = (await _readHead(
      transcript,
    )).split('\n').where((line) => line.trim().isNotEmpty);

    for (final line in lines) {
      final decoded = _decodeJsonlObject(line);
      if (decoded == null || decoded['type'] != 'session_meta') {
        continue;
      }

      final payload = decoded['payload'];
      if (payload is! Map<String, Object?>) {
        return null;
      }

      final cwd = payload['cwd'];
      final timestamp = payload['timestamp'] ?? decoded['timestamp'];
      if (cwd is! String || cwd.trim().isEmpty || timestamp is! String) {
        return null;
      }

      final startedAt = DateTime.tryParse(timestamp);
      if (startedAt == null) {
        return null;
      }

      return _CodexSessionMetadata(cwd: cwd, startedAt: startedAt.toUtc());
    }

    return null;
  }

  Future<String?> _readPromptTitle(File transcript) async {
    final lines = (await _readHead(
      transcript,
    )).split('\n').where((line) => line.trim().isNotEmpty);

    for (final line in lines) {
      final decoded = _decodeJsonlObject(line);
      if (decoded == null) {
        continue;
      }

      final title =
          _eventUserMessage(decoded) ?? _responseItemUserMessage(decoded);
      if (title != null) {
        return title;
      }
    }

    return null;
  }

  String? _eventUserMessage(Map<String, Object?> decoded) {
    if (decoded['type'] != 'event_msg') {
      return null;
    }

    final payload = decoded['payload'];
    if (payload is! Map<String, Object?> || payload['type'] != 'user_message') {
      return null;
    }

    final message = payload['message'];
    return message is String ? _cleanTitle(message) : null;
  }

  String? _responseItemUserMessage(Map<String, Object?> decoded) {
    if (decoded['type'] != 'response_item') {
      return null;
    }

    final payload = decoded['payload'];
    if (payload is! Map<String, Object?> || payload['role'] != 'user') {
      return null;
    }

    final content = payload['content'];
    if (content is! List<Object?>) {
      return null;
    }

    for (final item in content) {
      if (item is! Map<String, Object?> || item['type'] != 'input_text') {
        continue;
      }

      final text = item['text'];
      if (text is String) {
        return _cleanTitle(text);
      }
    }

    return null;
  }

  Map<String, Object?>? _decodeJsonlObject(String line) {
    final trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return null;
    }

    final decoded = jsonDecode(trimmed);
    if (decoded is Map<String, Object?>) {
      return decoded;
    }

    return null;
  }

  Future<String> _readHead(File file) async {
    final handle = await file.open();
    try {
      final length = await handle.length();
      final bytesToRead = length > _jsonlHeadBytes ? _jsonlHeadBytes : length;
      final bytes = await handle.read(bytesToRead);
      return utf8.decode(bytes, allowMalformed: true);
    } finally {
      await handle.close();
    }
  }
}

final class _CodexSessionMetadata {
  const _CodexSessionMetadata({required this.cwd, required this.startedAt});

  final String cwd;
  final DateTime startedAt;
}

String _commandName(String command) {
  final normalized = command.replaceAll('\\', '/');
  final slashIndex = normalized.lastIndexOf('/');
  return slashIndex < 0 ? normalized : normalized.substring(slashIndex + 1);
}

String _join(String left, String right) {
  final separator = Platform.pathSeparator;
  if (left.endsWith(separator)) {
    return '$left$right';
  }

  return '$left$separator$right';
}

String? _cleanTitle(String rawTitle) {
  final collapsed = rawTitle.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (collapsed.isEmpty) {
    return null;
  }
  if (collapsed.length <= _maxTitleLength) {
    return collapsed;
  }

  return '${collapsed.substring(0, _maxTitleLength - _titleOverflowSuffix.length)}$_titleOverflowSuffix';
}
