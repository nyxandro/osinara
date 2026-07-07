/// Dialog that collects explicit fields for publishing a local Git repository.
///
/// Key constructs:
/// - [GitPublishDialog]: validates provider, owner, repository, visibility,
///   remote name, and returns a [GitPublishRequest].
library;

import 'package:flutter/material.dart';

import '../../git/git_repository_actions.dart';
import '../../localization/app_git_repository_strings.dart';
import '../../localization/app_strings.dart';

const _dialogMaxWidth = 440.0;
const _dialogVerticalMargin = 64.0;
const _dialogPadding = 16.0;
const _sectionGap = 12.0;
const _fieldGap = 8.0;

class GitPublishDialog extends StatefulWidget {
  const GitPublishDialog({super.key, required this.projectPath});

  final String projectPath;

  @override
  State<GitPublishDialog> createState() => _GitPublishDialogState();
}

class _GitPublishDialogState extends State<GitPublishDialog> {
  final _formKey = GlobalKey<FormState>();
  final _ownerController = TextEditingController();
  final _repositoryController = TextEditingController();
  final _remoteController = TextEditingController();

  GitRemoteProvider? _provider;
  GitRepositoryVisibility? _visibility;
  var _submitted = false;

  @override
  void dispose() {
    _ownerController.dispose();
    _repositoryController.dispose();
    _remoteController.dispose();
    super.dispose();
  }

  void _submit() {
    final formState = _formKey.currentState;
    if (formState == null) {
      throw StateError(
        'OSI_GIT_PUBLISH_FORM_MISSING: Не удалось открыть форму публикации репозитория. Перезапустите приложение и попробуйте снова.',
      );
    }

    // Validation is explicit: every business-critical publish field must be
    // provided by the user before the process runner receives a request.
    setState(() {
      _submitted = true;
    });
    if (!formState.validate() || _provider == null || _visibility == null) {
      return;
    }

    Navigator.of(context).pop(
      GitPublishRequest(
        provider: _provider!,
        owner: _ownerController.text.trim(),
        repositoryName: _repositoryController.text.trim(),
        visibility: _visibility!,
        remoteName: _remoteController.text.trim(),
        projectPath: widget.projectPath,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final viewportHeight = MediaQuery.sizeOf(context).height;
    final maxDialogHeight = viewportHeight > _dialogVerticalMargin
        ? viewportHeight - _dialogVerticalMargin
        : viewportHeight;

    return Dialog(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: _dialogMaxWidth,
          maxHeight: maxDialogHeight,
        ),
        child: Padding(
          padding: const EdgeInsets.all(_dialogPadding),
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  strings.gitPublishRepository,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: _fieldGap),
                Text(
                  strings.gitPublishDescription,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: _sectionGap),
                Flexible(
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _ProviderChooser(
                          value: _provider,
                          submitted: _submitted,
                          onChanged: (provider) {
                            setState(() {
                              _provider = provider;
                            });
                          },
                        ),
                        const SizedBox(height: _sectionGap),
                        _PublishTextField(
                          key: const Key('git-publish-owner-field'),
                          controller: _ownerController,
                          label: strings.gitPublishOwner,
                        ),
                        const SizedBox(height: _fieldGap),
                        _PublishTextField(
                          key: const Key('git-publish-repo-field'),
                          controller: _repositoryController,
                          label: strings.gitPublishRepositoryName,
                        ),
                        const SizedBox(height: _fieldGap),
                        _PublishTextField(
                          key: const Key('git-publish-remote-field'),
                          controller: _remoteController,
                          label: strings.gitPublishRemoteName,
                        ),
                        const SizedBox(height: _sectionGap),
                        _VisibilityChooser(
                          value: _visibility,
                          submitted: _submitted,
                          onChanged: (visibility) {
                            setState(() {
                              _visibility = visibility;
                            });
                          },
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: _sectionGap),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(strings.cancel),
                    ),
                    const SizedBox(width: _fieldGap),
                    FilledButton(
                      key: const Key('git-publish-submit-button'),
                      onPressed: _submit,
                      child: Text(strings.gitPublishSubmit),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PublishTextField extends StatelessWidget {
  const _PublishTextField({
    super.key,
    required this.controller,
    required this.label,
  });

  final TextEditingController controller;
  final String label;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return TextFormField(
      controller: controller,
      decoration: InputDecoration(labelText: label),
      textInputAction: TextInputAction.next,
      validator: (value) {
        if (value == null || value.trim().isEmpty) {
          return strings.gitPublishRequiredField;
        }

        return null;
      },
    );
  }
}

class _ProviderChooser extends StatelessWidget {
  const _ProviderChooser({
    required this.value,
    required this.submitted,
    required this.onChanged,
  });

  final GitRemoteProvider? value;
  final bool submitted;
  final ValueChanged<GitRemoteProvider> onChanged;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(strings.gitPublishProvider),
            const SizedBox(width: _fieldGap),
            Expanded(
              child: Wrap(
                spacing: _fieldGap,
                children: [
                  for (final provider in GitRemoteProvider.values)
                    ChoiceChip(
                      key: Key('git-publish-provider-${provider.name}'),
                      label: Text(strings.gitPublishProviderLabel(provider)),
                      selected: value == provider,
                      onSelected: (_) => onChanged(provider),
                    ),
                ],
              ),
            ),
          ],
        ),
        if (submitted && value == null) ...[
          const SizedBox(height: _fieldGap),
          Text(
            strings.gitPublishProviderRequired,
            style: TextStyle(color: colorScheme.error),
          ),
        ],
      ],
    );
  }
}

class _VisibilityChooser extends StatelessWidget {
  const _VisibilityChooser({
    required this.value,
    required this.submitted,
    required this.onChanged,
  });

  final GitRepositoryVisibility? value;
  final bool submitted;
  final ValueChanged<GitRepositoryVisibility> onChanged;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(strings.gitPublishVisibility),
            const SizedBox(width: _fieldGap),
            Expanded(
              child: Wrap(
                spacing: _fieldGap,
                children: [
                  for (final visibility in GitRepositoryVisibility.values)
                    ChoiceChip(
                      key: Key('git-publish-visibility-${visibility.name}'),
                      label: Text(
                        strings.gitPublishVisibilityLabel(visibility),
                      ),
                      selected: value == visibility,
                      onSelected: (_) => onChanged(visibility),
                    ),
                ],
              ),
            ),
          ],
        ),
        if (submitted && value == null) ...[
          const SizedBox(height: _fieldGap),
          Text(
            strings.gitPublishVisibilityRequired,
            style: TextStyle(color: colorScheme.error),
          ),
        ],
      ],
    );
  }
}
