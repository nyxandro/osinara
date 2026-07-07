/// Launch profile card with an embedded-terminal launch action.
library;

import 'package:flutter/material.dart';

import '../../launch_profiles/launch_profile.dart';
import '../../localization/app_strings.dart';

class LaunchProfileCard extends StatelessWidget {
  const LaunchProfileCard({
    super.key,
    required this.profile,
    required this.enabled,
    required this.onLaunch,
  });

  final LaunchProfile profile;
  final bool enabled;
  final VoidCallback onLaunch;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    // Launching creates an embedded PTY tab, so no external terminal choice is needed.
    return SizedBox(
      width: 260,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.terminal_rounded, color: colorScheme.primary),
              const SizedBox(height: 16),
              Text(
                profile.agentName,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              Text(
                profile.command,
                style: TextStyle(color: colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 20),
              OutlinedButton.icon(
                onPressed: enabled ? onLaunch : null,
                icon: const Icon(Icons.play_arrow_rounded),
                label: Text(strings.launch),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
