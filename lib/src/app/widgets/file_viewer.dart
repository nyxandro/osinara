/// Read-only text file viewer rendered inside workspace file tabs.
///
/// Key constructs:
/// - [FileContentReader]: injectable file-content boundary for production IO and tests.
/// - [LocalFileContentReader]: production reader with size guard.
/// - [maxFileViewerBytes]: hard cap that prevents loading huge files into the UI isolate.
/// - [FileViewer]: async read-only viewer for project files.
library;

import 'dart:io';

import 'package:flutter/material.dart';

const maxFileViewerBytes = 1024 * 1024;

abstract interface class FileContentReader {
  Future<String> read(String path);
}

final class LocalFileContentReader implements FileContentReader {
  const LocalFileContentReader();

  @override
  Future<String> read(String path) {
    return _readTextFile(path);
  }
}

class FileViewer extends StatefulWidget {
  const FileViewer({
    super.key,
    required this.filePath,
    this.reader = const LocalFileContentReader(),
  });

  final String filePath;
  final FileContentReader reader;

  @override
  State<FileViewer> createState() => _FileViewerState();
}

class _FileViewerState extends State<FileViewer> {
  late Future<String> _content;

  @override
  void initState() {
    super.initState();
    _content = widget.reader.read(widget.filePath);
  }

  @override
  void didUpdateWidget(FileViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.filePath != widget.filePath ||
        oldWidget.reader != widget.reader) {
      _content = widget.reader.read(widget.filePath);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<String>(
      key: Key('file-viewer-${widget.filePath}'),
      future: _content,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }

        if (snapshot.hasError) {
          return _FileViewerMessage(message: snapshot.error.toString());
        }

        return _FileTextContent(content: snapshot.requireData);
      },
    );
  }
}

class _FileTextContent extends StatelessWidget {
  const _FileTextContent({required this.content});

  final String content;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ColoredBox(
      key: const Key('file-viewer-content'),
      color: colorScheme.surface,
      child: Scrollbar(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          scrollDirection: Axis.horizontal,
          child: SingleChildScrollView(
            child: SelectableText(
              content,
              style: TextStyle(
                color: colorScheme.onSurface,
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FileViewerMessage extends StatelessWidget {
  const _FileViewerMessage({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620),
        child: Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(color: colorScheme.error),
        ),
      ),
    );
  }
}

Future<String> _readTextFile(String path) async {
  if (path.trim().isEmpty) {
    throw ArgumentError.value(
      path,
      'path',
      'OSI_FILE_VIEW_PATH_MISSING: Не удалось открыть файл: путь к файлу не указан.',
    );
  }

  final file = File(path);
  if (!await file.exists()) {
    throw StateError(
      'OSI_FILE_VIEW_NOT_FOUND: Не удалось открыть файл: файл не найден.',
    );
  }

  final size = await file.length();
  if (size > maxFileViewerBytes) {
    throw StateError(
      'OSI_FILE_VIEW_TOO_LARGE: Файл слишком большой для просмотра внутри Osinara. Откройте его внешним редактором.',
    );
  }

  return file.readAsString();
}
