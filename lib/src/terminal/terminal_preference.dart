/// Resolves selected terminal preference against currently installed profiles.
///
/// Key constructs:
/// - [TerminalPreferenceResolver]: keeps saved terminal when valid, otherwise picks a detected default.
library;

import 'terminal_profile.dart';

abstract final class TerminalPreferenceResolver {
  static TerminalProfile? resolve({
    required List<TerminalProfile> installedProfiles,
    required TerminalProfile? savedProfile,
  }) {
    if (savedProfile != null && installedProfiles.contains(savedProfile)) {
      return savedProfile;
    }

    if (installedProfiles.isEmpty) {
      return null;
    }

    // The first installed profile follows the explicit priority in TerminalProfile.values.
    return installedProfiles.first;
  }
}
