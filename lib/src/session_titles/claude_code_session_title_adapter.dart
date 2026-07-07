/// Claude Code log adapter for deriving a session title after the first prompt.
///
/// Key constructs:
/// - [ClaudeCodeSessionTitleAdapter]: reads Claude session metadata and transcript JSONL.
library;

import 'dart:convert';
import 'dart:io';

import '../embedded_terminal/embedded_terminal_session.dart';
import '../launch_profiles/launch_profile.dart';
import 'cli_session_title_adapter.dart';

const _claudeDirectoryName = '.claude';
const _sessionsDirectoryName = 'sessions';
const _projectsDirectoryName = 'projects';
const _derivedNameSource = 'derived';
const _sessionStartTolerance = Duration(seconds: 30);
const _jsonlTailBytes = 256 * 1024;
const _maxTitleLength = 80;
const _titleOverflowSuffix = '...';

final class ClaudeCodeSessionTitleAdapter implements CliSessionTitleAdapter {
  const ClaudeCodeSessionTitleAdapter();

  @override
  bool supports(LaunchProfile profile) {
    return _commandName(profile.command) == 'claude' ||
        profile.agentName.toLowerCase().contains('claude');
  }

  @override
  Future<String?> readTitle({
    required EmbeddedTerminalSession session,
    required Map<String, String> environment,
  }) async {
    final claudeHome = _claudeHome(environment);
    if (claudeHome == null) {
      return null;
    }

    final metadata = await _readSessionMetadata(
      claudeHome: claudeHome,
      session: session,
    );
    if (metadata == null) {
      return null;
    }

    final explicitName = _explicitMetadataName(metadata);
    if (explicitName != null) {
      return explicitName;
    }

    final transcript = _transcriptFile(
      claudeHome: claudeHome,
      metadata: metadata,
    );
    if (transcript == null || !await transcript.exists()) {
      return null;
    }

    return _readPromptTitle(transcript);
  }

  Directory? _claudeHome(Map<String, String> environment) {
    final home = environment['HOME'];
    if (home == null || home.trim().isEmpty) {
      return null;
    }

    return Directory(_join(home, _claudeDirectoryName));
  }

  Future<Map<String, Object?>?> _readSessionMetadata({
    required Directory claudeHome,
    required EmbeddedTerminalSession session,
  }) async {
    final sessionsDirectory = Directory(
      _join(claudeHome.path, _sessionsDirectoryName),
    );
    if (!await sessionsDirectory.exists()) {
      return null;
    }

    final processId = session.processId;
    if (processId != null) {
      final processMetadata = File(
        _join(sessionsDirectory.path, '$processId.json'),
      );
      if (await processMetadata.exists()) {
        return _readJsonObject(processMetadata);
      }
    }

    return _latestMatchingSessionMetadata(
      sessionsDirectory: sessionsDirectory,
      session: session,
    );
  }

  Future<Map<String, Object?>?> _latestMatchingSessionMetadata({
    required Directory sessionsDirectory,
    required EmbeddedTerminalSession session,
  }) async {
    Map<String, Object?>? bestMetadata;
    var bestStartedAt = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
    final minimumStartedAt = session.startedAt.subtract(_sessionStartTolerance);

    await for (final entity in sessionsDirectory.list(followLinks: false)) {
      if (entity is! File || !entity.path.endsWith('.json')) {
        continue;
      }

      final metadata = await _readJsonObject(entity);
      if (metadata == null) {
        continue;
      }
      if (metadata['cwd'] != session.projectPath) {
        continue;
      }

      final startedAt = _metadataStartedAt(metadata);
      if (startedAt == null || startedAt.isBefore(minimumStartedAt)) {
        continue;
      }

      if (startedAt.isAfter(bestStartedAt)) {
        bestStartedAt = startedAt;
        bestMetadata = metadata;
      }
    }

    return bestMetadata;
  }

  Future<Map<String, Object?>?> _readJsonObject(File file) async {
    final raw = (await file.readAsString()).trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) {
      return null;
    }

    final decoded = jsonDecode(raw);
    if (decoded is Map<String, Object?>) {
      return decoded;
    }

    throw StateError(
      'OSI_CLAUDE_SESSION_METADATA_INVALID: Не удалось прочитать название сессии Claude Code: metadata имеет неверный формат.',
    );
  }

  DateTime? _metadataStartedAt(Map<String, Object?> metadata) {
    final value = metadata['startedAt'];
    if (value is num) {
      return DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true);
    }

    return null;
  }

  String? _explicitMetadataName(Map<String, Object?> metadata) {
    final name = metadata['name'];
    final nameSource = metadata['nameSource'];
    if (name is! String || name.trim().isEmpty) {
      return null;
    }
    if (nameSource == _derivedNameSource) {
      return null;
    }

    return _cleanTitle(name);
  }

  File? _transcriptFile({
    required Directory claudeHome,
    required Map<String, Object?> metadata,
  }) {
    final cwd = metadata['cwd'];
    final sessionId = metadata['sessionId'];
    if (cwd is! String || cwd.trim().isEmpty) {
      return null;
    }
    if (sessionId is! String || sessionId.trim().isEmpty) {
      return null;
    }

    final encodedProjectPath = _encodeClaudeProjectPath(cwd);
    return File(
      _join(
        _join(
          _join(claudeHome.path, _projectsDirectoryName),
          encodedProjectPath,
        ),
        '$sessionId.jsonl',
      ),
    );
  }

  Future<String?> _readPromptTitle(File transcript) async {
    final raw = await _readTail(transcript);
    final lines = raw
        .split('\n')
        .where((line) => line.trim().isNotEmpty)
        .toList();

    for (final line in lines.reversed) {
      final decoded = _decodeJsonlObject(line);
      if (decoded == null) {
        continue;
      }

      final lastPrompt = decoded['lastPrompt'];
      if (decoded['type'] == 'last-prompt' && lastPrompt is String) {
        return _cleanTitle(lastPrompt);
      }
    }

    for (final line in lines) {
      final decoded = _decodeJsonlObject(line);
      if (decoded == null || decoded['type'] != 'user') {
        continue;
      }

      final message = decoded['message'];
      if (message is Map<String, Object?>) {
        final content = message['content'];
        if (content is String) {
          return _cleanTitle(content);
        }
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

  Future<String> _readTail(File file) async {
    final handle = await file.open();
    try {
      final length = await handle.length();
      final start = length > _jsonlTailBytes ? length - _jsonlTailBytes : 0;
      await handle.setPosition(start);
      final bytes = await handle.read(length - start);
      final raw = utf8.decode(bytes, allowMalformed: true);

      // If reading from the middle of a large file, drop the first partial line before JSON decoding.
      if (start > 0) {
        final firstLineBreak = raw.indexOf('\n');
        if (firstLineBreak >= 0) {
          return raw.substring(firstLineBreak + 1);
        }
      }

      return raw;
    } finally {
      await handle.close();
    }
  }
}

String _commandName(String command) {
  final normalized = command.replaceAll('\\', '/');
  final slashIndex = normalized.lastIndexOf('/');
  return slashIndex < 0 ? normalized : normalized.substring(slashIndex + 1);
}

String _encodeClaudeProjectPath(String projectPath) {
  return projectPath.replaceAll(RegExp(r'[\\/]+'), '-');
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
