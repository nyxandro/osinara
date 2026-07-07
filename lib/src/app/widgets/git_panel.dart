/// Left-side Git status panel that replaces the file tree for the selected project.
///
/// Key constructs:
/// - [GitPanel]: loads repository status and renders compact file-tree-like rows.
/// - [_GitNotRepositoryActions]: init/publish entry point for folders without `.git`.
/// - [_GitRepositoryActionsBar]: repository-level actions such as publish.
/// - [_GitStatusRow]: one changed file row with status badge and path.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../git/git_repository_actions.dart';
import '../../git/git_status_reader.dart';
import '../../localization/app_git_repository_strings.dart';
import '../../localization/app_strings.dart';
import '../../theme/osinara_theme.dart';
import 'git_publish_dialog.dart';

const _gitRowHeight = 26.0;
const _gitRowStartPadding = 4.0;
const _gitStatusBadgeWidth = 34.0;
const _gitIconTextGap = 6.0;
const _gitPanelPadding = 12.0;
const _gitActionGap = 8.0;
const _gitButtonIconSize = 16.0;
const _gitTrailingGap = 8.0;

class GitPanel extends StatefulWidget {
  const GitPanel({
    super.key,
    required this.projectPath,
    this.reader = const GitStatusReader(),
    this.actions = const GitRepositoryActions(),
  });

  final String projectPath;
  final GitStatusReader reader;
  final GitRepositoryActions actions;

  @override
  State<GitPanel> createState() => _GitPanelState();
}

class _GitPanelState extends State<GitPanel> {
  GitStatusSnapshot? _snapshot;
  String? _errorMessage;
  var _loading = true;
  var _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_loadStatus());
  }

  @override
  void didUpdateWidget(GitPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.projectPath == widget.projectPath &&
        oldWidget.reader == widget.reader) {
      return;
    }

    unawaited(_loadStatus());
  }

  Future<void> _loadStatus() async {
    final generation = ++_loadGeneration;
    setState(() {
      _loading = true;
      _errorMessage = null;
    });

    try {
      final snapshot = await widget.reader.read(widget.projectPath);
      if (!mounted || generation != _loadGeneration) {
        return;
      }

      setState(() {
        _snapshot = snapshot;
        _loading = false;
      });
    } on Object catch (error, stackTrace) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stackTrace,
          library: 'osinara git panel',
          context: ErrorDescription('loading git status'),
        ),
      );
      if (!mounted || generation != _loadGeneration) {
        return;
      }

      setState(() {
        _errorMessage = AppStrings.of(context).gitStatusFailed;
        _loading = false;
      });
    }
  }

  Future<void> _initializeRepository() async {
    setState(() {
      _loading = true;
      _errorMessage = null;
    });

    try {
      await widget.actions.initialize(widget.projectPath);
      await _loadStatus();
    } on Object catch (error, stackTrace) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stackTrace,
          library: 'osinara git panel',
          context: ErrorDescription('initializing git repository'),
        ),
      );
      if (!mounted) {
        return;
      }

      setState(() {
        _errorMessage = AppStrings.of(context).gitInitializeFailed;
        _loading = false;
      });
    }
  }

  Future<void> _publishRepository() async {
    final strings = AppStrings.of(context);
    final request = await showDialog<GitPublishRequest>(
      context: context,
      builder: (context) => GitPublishDialog(projectPath: widget.projectPath),
    );
    if (request == null) {
      return;
    }

    // Publishing crosses process/network boundaries, so the panel keeps the
    // action visible as progress and reloads status only after the push ends.
    setState(() {
      _loading = true;
      _errorMessage = null;
    });

    try {
      await widget.actions.publish(request);
      await _loadStatus();
    } on Object catch (error, stackTrace) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stackTrace,
          library: 'osinara git panel',
          context: ErrorDescription('publishing git repository'),
        ),
      );
      if (!mounted) {
        return;
      }

      setState(() {
        _errorMessage = strings.gitPublishFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final tokens = OsinaraThemeTokens.of(context);

    return DecoratedBox(
      key: const Key('git-panel'),
      decoration: BoxDecoration(
        color: tokens.filePanelBackground,
        border: Border(right: BorderSide(color: colorScheme.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_loading) const LinearProgressIndicator(minHeight: 1),
          Expanded(child: _buildBody(context)),
        ],
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    final strings = AppStrings.of(context);
    final snapshot = _snapshot;

    if (_errorMessage != null) {
      return _GitMessage(message: _errorMessage!);
    }
    if (_loading && snapshot == null) {
      return const SizedBox.expand();
    }
    if (snapshot == null) {
      return _GitMessage(message: strings.gitStatusFailed);
    }
    if (!snapshot.isRepository) {
      return _GitNotRepositoryActions(
        message: strings.gitNotRepository,
        initializeLabel: strings.gitInitializeRepository,
        onInitialize: _initializeRepository,
      );
    }

    return RefreshIndicator(
      onRefresh: _loadStatus,
      child: ListView(
        padding: EdgeInsets.zero,
        children: [
          _GitBranchRow(label: snapshot.branchLabel ?? strings.gitDetachedHead),
          _GitRepositoryActionsBar(
            publishLabel: strings.gitPublishRepository,
            onPublish: _publishRepository,
          ),
          if (snapshot.isClean) _GitMessage(message: strings.gitCleanTree),
          for (final entry in snapshot.entries) _GitStatusRow(entry: entry),
        ],
      ),
    );
  }
}

class _GitRepositoryActionsBar extends StatelessWidget {
  const _GitRepositoryActionsBar({
    required this.publishLabel,
    required this.onPublish,
  });

  final String publishLabel;
  final VoidCallback onPublish;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        _gitTrailingGap,
        _gitActionGap,
        _gitTrailingGap,
        _gitActionGap,
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton.icon(
          key: const Key('git-publish-button'),
          onPressed: onPublish,
          icon: const Icon(
            Icons.cloud_upload_rounded,
            size: _gitButtonIconSize,
          ),
          label: Text(publishLabel),
        ),
      ),
    );
  }
}

class _GitNotRepositoryActions extends StatelessWidget {
  const _GitNotRepositoryActions({
    required this.message,
    required this.initializeLabel,
    required this.onInitialize,
  });

  final String message;
  final String initializeLabel;
  final VoidCallback onInitialize;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ListView(
      padding: const EdgeInsets.all(_gitPanelPadding),
      children: [
        Text(
          message,
          style: TextStyle(fontSize: 13, color: colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: _gitPanelPadding),
        OutlinedButton.icon(
          key: const Key('git-init-button'),
          onPressed: onInitialize,
          icon: const Icon(Icons.add_rounded, size: _gitButtonIconSize),
          label: Text(initializeLabel),
        ),
      ],
    );
  }
}

class _GitBranchRow extends StatelessWidget {
  const _GitBranchRow({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return SizedBox(
      height: _gitRowHeight,
      child: Row(
        children: [
          const SizedBox(width: _gitRowStartPadding),
          Icon(
            Icons.account_tree_rounded,
            size: 16,
            color: colorScheme.primary,
          ),
          const SizedBox(width: _gitIconTextGap),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                height: 1.1,
                color: colorScheme.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GitStatusRow extends StatelessWidget {
  const _GitStatusRow({required this.entry});

  final GitStatusEntry entry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final mutedColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.72);

    return SizedBox(
      height: _gitRowHeight,
      child: Row(
        children: [
          const SizedBox(width: _gitRowStartPadding),
          SizedBox(
            width: _gitStatusBadgeWidth,
            child: Text(
              _shortStatus(entry.statusLabel),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: _statusColor(entry.statusLabel, colorScheme),
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Icon(Icons.description_rounded, size: 16, color: mutedColor),
          const SizedBox(width: _gitIconTextGap),
          Expanded(
            child: Text(
              entry.path,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, height: 1.1, color: mutedColor),
            ),
          ),
          const SizedBox(width: _gitTrailingGap),
          Text(
            entry.statusLabel,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, height: 1.1, color: mutedColor),
          ),
          const SizedBox(width: _gitTrailingGap),
        ],
      ),
    );
  }

  String _shortStatus(String label) {
    return switch (label) {
      'Modified' => 'M',
      'Untracked' => 'U',
      'Added' => 'A',
      'Deleted' => 'D',
      'Renamed' => 'R',
      'Conflict' => '!',
      _ => '*',
    };
  }

  Color _statusColor(String label, ColorScheme colorScheme) {
    return switch (label) {
      'Conflict' => colorScheme.error,
      'Untracked' => colorScheme.tertiary,
      _ => colorScheme.primary,
    };
  }
}

class _GitMessage extends StatelessWidget {
  const _GitMessage({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.all(_gitPanelPadding),
      child: Text(
        message,
        style: TextStyle(fontSize: 13, color: colorScheme.onSurfaceVariant),
      ),
    );
  }
}
