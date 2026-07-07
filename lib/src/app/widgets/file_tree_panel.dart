/// Left project file-tree panel with lazy directory loading.
///
/// Key constructs:
/// - [FileTreePanel]: renders the selected project's children from [FileTreeController].
/// - [_TreeRow]: single visible file or folder row.
/// - [_ExpandGlyph]: compact state indicator for lazy directory expansion.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../file_tree/file_tree_controller.dart';
import '../../file_tree/file_tree_node.dart';
import '../../file_tree/file_tree_reader.dart';
import '../../file_tree/file_tree_watch_service.dart';
import '../../theme/osinara_theme.dart';

const _treeRowHeight = 26.0;
const _treeIndent = 18.0;

class FileTreePanel extends StatefulWidget {
  const FileTreePanel({
    super.key,
    required this.projectPath,
    required this.onFileSelected,
    this.reader = const FileTreeReader(),
    this.watchService = const DirectoryFileTreeWatchService(),
  });

  final String projectPath;
  final ValueChanged<FileTreeNode> onFileSelected;
  final FileTreeReader reader;
  final FileTreeWatchService watchService;

  @override
  State<FileTreePanel> createState() => _FileTreePanelState();
}

class _FileTreePanelState extends State<FileTreePanel> {
  late FileTreeController _controller;

  @override
  void initState() {
    super.initState();
    _controller = _createController();
    _controller.addListener(_handleControllerChanged);
    unawaited(_controller.start());
  }

  @override
  void didUpdateWidget(FileTreePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.projectPath == widget.projectPath &&
        oldWidget.reader == widget.reader &&
        oldWidget.watchService == widget.watchService) {
      return;
    }

    _controller.removeListener(_handleControllerChanged);
    _controller.dispose();
    _controller = _createController();
    _controller.addListener(_handleControllerChanged);
    unawaited(_controller.start());
  }

  @override
  void dispose() {
    _controller.removeListener(_handleControllerChanged);
    _controller.dispose();
    super.dispose();
  }

  FileTreeController _createController() {
    return FileTreeController(
      projectPath: widget.projectPath,
      reader: widget.reader,
      watchService: widget.watchService,
    );
  }

  void _handleControllerChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);
    final rootIsLoading = _controller.isLoading(widget.projectPath);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.filePanelBackground,
        border: Border(right: BorderSide(color: colorScheme.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_controller.errorMessage != null)
            Padding(
              padding: const EdgeInsets.all(10),
              child: Text(
                _controller.errorMessage!,
                style: TextStyle(color: colorScheme.error),
              ),
            ),
          if (rootIsLoading) const LinearProgressIndicator(minHeight: 1),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: _buildChildren(widget.projectPath, 0),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildChildren(String parentPath, int depth) {
    final children = _controller.childrenFor(parentPath);
    final rows = <Widget>[];

    // Directory expansion is represented from the cached one-level reads.
    for (final child in children) {
      final expanded = _controller.isExpanded(child.path);
      rows.add(
        _TreeRow(
          node: child,
          depth: depth,
          expanded: expanded,
          loading: _controller.isLoading(child.path),
          onTap: () {
            if (child.isDirectory) {
              unawaited(_controller.toggleDirectory(child));
              return;
            }

            widget.onFileSelected(child);
          },
        ),
      );

      if (child.isDirectory && expanded) {
        rows.addAll(_buildChildren(child.path, depth + 1));
      }
    }

    return rows;
  }
}

class _TreeRow extends StatelessWidget {
  const _TreeRow({
    required this.node,
    required this.depth,
    required this.expanded,
    required this.loading,
    required this.onTap,
  });

  final FileTreeNode node;
  final int depth;
  final bool expanded;
  final bool loading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);
    final mutedColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.72);

    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: _treeRowHeight,
        child: Row(
          children: [
            SizedBox(width: 4 + depth * _treeIndent),
            _ExpandGlyph(
              visible: node.isDirectory,
              expanded: expanded,
              loading: loading,
            ),
            const SizedBox(width: 4),
            Icon(
              _iconFor(node),
              size: 16,
              color: _iconColor(node, colorScheme, tokens),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                node.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.1,
                  color: node.isDirectory ? colorScheme.onSurface : mutedColor,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  IconData _iconFor(FileTreeNode node) {
    if (node.isDirectory) {
      return expanded ? Icons.folder_open_rounded : Icons.folder_rounded;
    }

    if (node.name.endsWith('.dart')) {
      return Icons.flutter_dash_rounded;
    }

    if (node.name.endsWith('.md')) {
      return Icons.article_rounded;
    }

    if (node.name.endsWith('.yaml') || node.name.endsWith('.yml')) {
      return Icons.data_object_rounded;
    }

    if (node.name == '.gitignore') {
      return Icons.merge_type_rounded;
    }

    return Icons.description_rounded;
  }

  Color _iconColor(
    FileTreeNode node,
    ColorScheme colorScheme,
    OsinaraThemeTokens tokens,
  ) {
    if (node.isDirectory) {
      return tokens.folderIcon;
    }

    if (node.name.endsWith('.dart')) {
      return tokens.dartIcon;
    }

    if (node.name.endsWith('.md')) {
      return tokens.markdownIcon;
    }

    if (node.name.endsWith('.yaml') || node.name.endsWith('.yml')) {
      return tokens.configIcon;
    }

    return colorScheme.onSurfaceVariant;
  }
}

class _ExpandGlyph extends StatelessWidget {
  const _ExpandGlyph({
    required this.visible,
    required this.expanded,
    required this.loading,
  });

  final bool visible;
  final bool expanded;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (!visible) {
      return const SizedBox(width: 12);
    }

    if (loading) {
      return const SizedBox.square(
        dimension: 12,
        child: CircularProgressIndicator(strokeWidth: 1.5),
      );
    }

    return AnimatedRotation(
      turns: expanded ? 0.25 : 0,
      duration: const Duration(milliseconds: 160),
      curve: Curves.easeOutCubic,
      child: const Icon(Icons.chevron_right_rounded, size: 12),
    );
  }
}
