/// Zed-like modal for adding local, WSL, or SSH projects to the workspace.
///
/// Key constructs:
/// - [ProjectAddDialog]: searchable command palette-style project picker.
/// - [_ManualProjectForm]: inline required-field form for local/WSL/SSH project addresses.
/// - [_CandidateRow]: selectable discovered project folder row.
library;

import 'dart:io';

import 'package:flutter/material.dart';

import '../../localization/app_strings.dart';
import '../../projects/project_candidate.dart';
import '../../projects/project_location.dart';

const _dialogWidth = 620.0;
const _dialogMaxHeight = 640.0;

enum _ManualProjectMode { local, wsl, ssh }

class ProjectAddDialog extends StatefulWidget {
  const ProjectAddDialog({super.key, required this.sections});

  final List<ProjectCandidateSection> sections;

  @override
  State<ProjectAddDialog> createState() => _ProjectAddDialogState();
}

class _ProjectAddDialogState extends State<ProjectAddDialog> {
  final _searchController = TextEditingController();
  var _manualMode = _ManualProjectMode.local;
  var _manualFormVisible = false;
  String? _errorMessage;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
      backgroundColor: colorScheme.surface,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: colorScheme.primary.withValues(alpha: 0.62)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: _dialogWidth,
          maxHeight: _dialogMaxHeight,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _SearchField(controller: _searchController, onChanged: _refresh),
            if (_errorMessage != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                child: Text(
                  _errorMessage!,
                  style: TextStyle(color: colorScheme.error),
                ),
              ),
            _CommandRow(
              key: const Key('connect-ssh-server-row'),
              icon: Icons.add_rounded,
              label: strings.connectSshServer,
              onTap: () => _showManualForm(_ManualProjectMode.ssh),
            ),
            _CommandRow(
              key: const Key('add-wsl-distro-row'),
              icon: Icons.add_rounded,
              label: strings.addWslDistro,
              onTap: () => _showManualForm(_ManualProjectMode.wsl),
            ),
            _CommandRow(
              key: const Key('open-folder-row'),
              icon: Icons.folder_open_outlined,
              label: strings.openFolder,
              onTap: () => _showManualForm(_ManualProjectMode.local),
            ),
            if (_manualFormVisible)
              _ManualProjectForm(
                mode: _manualMode,
                onSubmit: _submitManualProject,
              ),
            Divider(height: 1, color: colorScheme.outlineVariant),
            Expanded(
              child: _CandidateList(
                sections: _filteredSections(),
                onOpenFolder: () => _showManualForm(_ManualProjectMode.local),
              ),
            ),
            Divider(height: 1, color: colorScheme.outlineVariant),
            _Footer(strings: strings),
          ],
        ),
      ),
    );
  }

  void _refresh(String _) {
    setState(() {});
  }

  void _showManualForm(_ManualProjectMode mode) {
    setState(() {
      _manualMode = mode;
      _manualFormVisible = true;
      _errorMessage = null;
    });
  }

  List<ProjectCandidateSection> _filteredSections() {
    final query = _searchController.text.trim().toLowerCase();
    if (query.isEmpty) {
      return widget.sections;
    }

    return widget.sections
        .map((section) {
          final candidates = section.candidates
              .where((candidate) {
                return candidate.name.toLowerCase().contains(query) ||
                    candidate.location.path.toLowerCase().contains(query) ||
                    (candidate.subtitle?.toLowerCase().contains(query) ??
                        false);
              })
              .toList(growable: false);

          return ProjectCandidateSection(
            id: section.id,
            title: section.title,
            candidates: candidates,
          );
        })
        .where((section) => section.candidates.isNotEmpty)
        .toList(growable: false);
  }

  void _submitManualProject(_ManualProjectInput input) {
    try {
      final location = switch (input.mode) {
        _ManualProjectMode.local => ProjectLocation.local(path: input.path),
        _ManualProjectMode.wsl => ProjectLocation.wsl(
          distro: input.requiredEndpoint,
          path: input.path,
        ),
        _ManualProjectMode.ssh => ProjectLocation.ssh(
          host: input.requiredEndpoint,
          path: input.path,
        ),
      };
      final name = _basename(input.path);
      final candidate = ProjectCandidate(
        id: _projectId(location, name),
        name: name,
        location: location,
        subtitle: input.path,
      );

      Navigator.of(context).pop(candidate.toWorkspace());
    } on Object catch (error) {
      setState(() {
        _errorMessage = _safeErrorMessage(error);
      });
    }
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({required this.controller, required this.onChanged});

  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return TextField(
      key: const Key('project-add-search'),
      controller: controller,
      autofocus: true,
      decoration: InputDecoration(
        hintText: strings.searchRemoteProjects,
        border: InputBorder.none,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 14,
        ),
      ),
      onChanged: onChanged,
    );
  }
}

class _CandidateList extends StatelessWidget {
  const _CandidateList({required this.sections, required this.onOpenFolder});

  final List<ProjectCandidateSection> sections;
  final VoidCallback onOpenFolder;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        for (final section in sections) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
            child: Text(
              section.title,
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ),
          for (final candidate in section.candidates)
            _CandidateRow(candidate: candidate),
          _CommandRow(
            key: Key('open-folder-row-${section.id}'),
            icon: Icons.add_rounded,
            label: strings.openFolder,
            onTap: onOpenFolder,
          ),
          _CommandRow(
            key: Key('server-options-row-${section.id}'),
            icon: Icons.settings_outlined,
            label: strings.viewServerOptions,
            onTap: () {},
          ),
          Divider(height: 1, color: colorScheme.outlineVariant),
        ],
      ],
    );
  }
}

class _CandidateRow extends StatelessWidget {
  const _CandidateRow({required this.candidate});

  final ProjectCandidate candidate;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ListTile(
      key: Key('project-candidate-${candidate.id}'),
      dense: true,
      leading: Icon(
        Icons.folder_outlined,
        color: colorScheme.primary,
        size: 18,
      ),
      title: Text(
        candidate.location.path,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: candidate.subtitle == null
          ? null
          : Text(candidate.location.displayPrefix),
      onTap: () => Navigator.of(context).pop(candidate.toWorkspace()),
    );
  }
}

class _CommandRow extends StatelessWidget {
  const _CommandRow({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      leading: Icon(icon, size: 18),
      title: Text(label),
      onTap: onTap,
    );
  }
}

final class _ManualProjectInput {
  const _ManualProjectInput({
    required this.mode,
    required this.path,
    required this.endpoint,
  });

  final _ManualProjectMode mode;
  final String path;
  final String endpoint;

  String get requiredEndpoint => endpoint;
}

class _ManualProjectForm extends StatefulWidget {
  const _ManualProjectForm({required this.mode, required this.onSubmit});

  final _ManualProjectMode mode;
  final ValueChanged<_ManualProjectInput> onSubmit;

  @override
  State<_ManualProjectForm> createState() => _ManualProjectFormState();
}

class _ManualProjectFormState extends State<_ManualProjectForm> {
  final _endpointController = TextEditingController();
  final _pathController = TextEditingController();

  @override
  void dispose() {
    _endpointController.dispose();
    _pathController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final endpointLabel = switch (widget.mode) {
      _ManualProjectMode.local => null,
      _ManualProjectMode.wsl => strings.wslDistroName,
      _ManualProjectMode.ssh => strings.sshServerHost,
    };

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: Column(
        children: [
          if (endpointLabel != null) ...[
            TextField(
              key: Key('${widget.mode.name}-endpoint-field'),
              controller: _endpointController,
              decoration: InputDecoration(labelText: endpointLabel),
            ),
            const SizedBox(height: 8),
          ],
          TextField(
            key: Key('${widget.mode.name}-path-field'),
            controller: _pathController,
            decoration: InputDecoration(labelText: strings.projectFolderPath),
          ),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              key: Key('${widget.mode.name}-submit-button'),
              onPressed: () => widget.onSubmit(
                _ManualProjectInput(
                  mode: widget.mode,
                  path: _pathController.text,
                  endpoint: _endpointController.text,
                ),
              ),
              child: Text(strings.addProject),
            ),
          ),
        ],
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [Text('${strings.select}  Enter')],
      ),
    );
  }
}

String _basename(String path) {
  final normalized = path.endsWith(Platform.pathSeparator)
      ? path.substring(0, path.length - 1)
      : path;
  final separatorIndex = normalized.lastIndexOf(Platform.pathSeparator);
  if (separatorIndex < 0) {
    return normalized;
  }

  return normalized.substring(separatorIndex + 1);
}

String _projectId(ProjectLocation location, String name) {
  return '${location.kind.name}-$name-${location.path.hashCode.abs()}';
}

String _safeErrorMessage(Object error) {
  if (error is ArgumentError || error is StateError) {
    return error.toString();
  }

  return 'OSI_PROJECT_ADD_FAILED: Не удалось добавить проект. Проверьте введённые данные и повторите попытку.';
}
