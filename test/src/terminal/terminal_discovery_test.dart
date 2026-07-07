import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/terminal/terminal_discovery.dart';
import 'package:osinara/src/terminal/terminal_profile.dart';

void main() {
  group('TerminalDiscovery', () {
    test('returns only installed profiles for the current platform', () {
      final discovery = TerminalDiscovery(
        platform: LaunchPlatform.linux,
        executableExists: (executable, _) => executable == 'kitty',
      );

      final profiles = discovery.installedProfiles();

      expect(profiles, [TerminalProfile.kitty]);
    });

    test(
      'returns an empty list when no supported terminal executable exists',
      () {
        final discovery = TerminalDiscovery(
          platform: LaunchPlatform.linux,
          executableExists: (_, _) => false,
        );

        final profiles = discovery.installedProfiles();

        expect(profiles, isEmpty);
      },
    );

    test('detects Windows Terminal when running inside WSL', () {
      final discovery = TerminalDiscovery(
        platform: LaunchPlatform.linux,
        environment: const {'WSL_DISTRO_NAME': 'Ubuntu'},
        executableExists: (executable, _) => executable == 'wt.exe',
      );

      final profiles = discovery.installedProfiles();

      expect(profiles, [TerminalProfile.wslWindowsTerminal]);
    });
  });
}
