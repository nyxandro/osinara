/// Discovers installed terminal executables for supported terminal profiles.
///
/// Key constructs:
/// - [TerminalExecutableExists]: injectable executable lookup for tests and runtime.
/// - [TerminalDiscovery]: filters supported profiles to terminals present on PATH.
library;

import 'dart:io';

import 'terminal_profile.dart';

const _posixPathSeparator = ':';
const _windowsPathSeparator = ';';
const _executePermissionMask = 0x49;

typedef TerminalExecutableExists =
    bool Function(String executable, Map<String, String> environment);

final class TerminalDiscovery {
  const TerminalDiscovery({
    required this.platform,
    this.environment,
    this.executableExists = executableExistsOnPath,
  });

  final LaunchPlatform platform;
  final Map<String, String>? environment;
  final TerminalExecutableExists executableExists;

  List<TerminalProfile> installedProfiles() {
    final env = environment ?? Platform.environment;

    // Discovery is intentionally conservative: only known launch syntaxes are exposed.
    return TerminalProfileInfo.forPlatform(platform)
        .where((profile) => _profileIsAvailable(profile, env))
        .toList(growable: false);
  }

  bool _profileIsAvailable(
    TerminalProfile profile,
    Map<String, String> environment,
  ) {
    if (profile == TerminalProfile.wslWindowsTerminal &&
        !_isWslEnvironment(environment)) {
      return false;
    }

    return executableExists(profile.executable, environment);
  }
}

bool executableExistsOnPath(
  String executable,
  Map<String, String> environment,
) {
  final pathValue = _pathValue(environment);
  if (pathValue == null || pathValue.trim().isEmpty) {
    return false;
  }

  final separator = Platform.isWindows
      ? _windowsPathSeparator
      : _posixPathSeparator;
  final directories = pathValue
      .split(separator)
      .where((directory) => directory.trim().isNotEmpty);

  // Every candidate is checked as a real executable file, not just a label.
  for (final directory in directories) {
    final candidate = File(_joinPath(directory, executable));
    if (_isExecutableFile(candidate)) {
      return true;
    }
  }

  return false;
}

String? _pathValue(Map<String, String> environment) {
  return environment['PATH'] ?? environment['Path'];
}

bool _isWslEnvironment(Map<String, String> environment) {
  final distroName = environment['WSL_DISTRO_NAME'];
  return distroName != null && distroName.trim().isNotEmpty;
}

bool _isExecutableFile(File file) {
  final stat = file.statSync();
  if (stat.type != FileSystemEntityType.file) {
    return false;
  }

  if (Platform.isWindows) {
    return true;
  }

  return stat.mode & _executePermissionMask != 0;
}

String _joinPath(String left, String right) {
  final separator = Platform.pathSeparator;
  if (left.endsWith(separator)) {
    return '$left$right';
  }

  return '$left$separator$right';
}
