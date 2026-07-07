/// Project settings modal for editing metadata or removing a project from Osinara.
///
/// Key constructs:
/// - [ProjectSettingsDialog]: edit form for project name, path, and icon.
/// - [ProjectSettingsResult]: explicit save/delete result returned to the shell.
library;

import 'package:flutter/material.dart';

import '../../localization/app_strings.dart';
import '../../projects/project_workspace.dart';

enum ProjectSettingsAction { save, delete }

final class ProjectSettingsResult {
  const ProjectSettingsResult.save({
    required this.name,
    required this.path,
    required this.iconName,
  }) : action = ProjectSettingsAction.save;

  const ProjectSettingsResult.delete()
    : action = ProjectSettingsAction.delete,
      name = null,
      path = null,
      iconName = null;

  final ProjectSettingsAction action;
  final String? name;
  final String? path;
  final String? iconName;
}

class ProjectSettingsDialog extends StatefulWidget {
  const ProjectSettingsDialog({super.key, required this.project});

  final ProjectWorkspace project;

  @override
  State<ProjectSettingsDialog> createState() => _ProjectSettingsDialogState();
}

class _ProjectSettingsDialogState extends State<ProjectSettingsDialog> {
  late final TextEditingController _nameController;
  late final TextEditingController _pathController;
  late final TextEditingController _iconController;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.project.name);
    _pathController = TextEditingController(text: widget.project.path);
    _iconController = TextEditingController(text: widget.project.iconName);
  }

  @override
  void dispose() {
    _nameController.dispose();
    _pathController.dispose();
    _iconController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return AlertDialog(
      key: const Key('project-settings-dialog'),
      title: Text(strings.projectSettings),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.project.location.displayPrefix,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('project-settings-name-field'),
              controller: _nameController,
              decoration: InputDecoration(labelText: strings.projectName),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('project-settings-path-field'),
              controller: _pathController,
              decoration: InputDecoration(labelText: strings.projectFolderPath),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('project-settings-icon-field'),
              controller: _iconController,
              decoration: InputDecoration(labelText: strings.projectIcon),
            ),
            const SizedBox(height: 12),
            Text(
              strings.removeProjectDescription,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('project-settings-delete-button'),
          onPressed: () =>
              Navigator.of(context).pop(const ProjectSettingsResult.delete()),
          child: Text(
            strings.removeProject,
            style: TextStyle(color: colorScheme.error),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(strings.close),
        ),
        FilledButton(
          key: const Key('project-settings-save-button'),
          onPressed: () => Navigator.of(context).pop(
            ProjectSettingsResult.save(
              name: _nameController.text,
              path: _pathController.text,
              iconName: _iconController.text,
            ),
          ),
          child: Text(strings.saveProject),
        ),
      ],
    );
  }
}
