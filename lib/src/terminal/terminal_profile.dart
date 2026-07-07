/// Supported external terminal profiles and their owning OS platforms.
///
/// Key constructs:
/// - [LaunchPlatform]: OS family used by launch and discovery logic.
/// - [TerminalProfile]: supported terminal integrations with known CLI syntax.
/// - [LaunchPlatformRuntime]: maps the current Dart runtime to a launch platform.
/// - [TerminalProfileInfo]: stable IDs, labels, executables, and platform filters.
library;

import 'dart:io';

enum LaunchPlatform { linux, macos, windows }

enum TerminalProfile {
  gnomeTerminal,
  kitty,
  konsole,
  xterm,
  wslWindowsTerminal,
  macosTerminal,
  windowsTerminal,
}

extension LaunchPlatformRuntime on LaunchPlatform {
  static LaunchPlatform current() {
    if (Platform.isLinux) {
      return LaunchPlatform.linux;
    }

    if (Platform.isMacOS) {
      return LaunchPlatform.macos;
    }

    if (Platform.isWindows) {
      return LaunchPlatform.windows;
    }

    throw UnsupportedError(
      'OSI_PLATFORM_UNSUPPORTED: Не удалось запустить терминал: текущая операционная система не поддерживается.',
    );
  }
}

extension TerminalProfileInfo on TerminalProfile {
  String get id => name;

  LaunchPlatform get platform {
    return switch (this) {
      TerminalProfile.gnomeTerminal ||
      TerminalProfile.kitty ||
      TerminalProfile.konsole ||
      TerminalProfile.xterm ||
      TerminalProfile.wslWindowsTerminal => LaunchPlatform.linux,
      TerminalProfile.macosTerminal => LaunchPlatform.macos,
      TerminalProfile.windowsTerminal => LaunchPlatform.windows,
    };
  }

  String get executable {
    return switch (this) {
      TerminalProfile.gnomeTerminal => 'gnome-terminal',
      TerminalProfile.kitty => 'kitty',
      TerminalProfile.konsole => 'konsole',
      TerminalProfile.xterm => 'xterm',
      TerminalProfile.wslWindowsTerminal => 'wt.exe',
      TerminalProfile.macosTerminal => 'osascript',
      TerminalProfile.windowsTerminal => 'wt.exe',
    };
  }

  String get label {
    return switch (this) {
      TerminalProfile.gnomeTerminal => 'GNOME Terminal',
      TerminalProfile.kitty => 'kitty',
      TerminalProfile.konsole => 'Konsole',
      TerminalProfile.xterm => 'xterm',
      TerminalProfile.wslWindowsTerminal => 'Windows Terminal (WSL)',
      TerminalProfile.macosTerminal => 'Terminal.app',
      TerminalProfile.windowsTerminal => 'Windows Terminal',
    };
  }

  static List<TerminalProfile> forPlatform(LaunchPlatform platform) {
    return TerminalProfile.values
        .where((profile) => profile.platform == platform)
        .toList(growable: false);
  }

  static TerminalProfile fromId(String id) {
    for (final profile in TerminalProfile.values) {
      if (profile.id == id) {
        return profile;
      }
    }

    throw StateError(
      'OSI_TERMINAL_PROFILE_UNKNOWN: Не удалось загрузить настройки терминала: профиль "$id" не поддерживается текущей версией приложения.',
    );
  }
}
