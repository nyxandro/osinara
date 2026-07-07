import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/terminal/terminal_preference.dart';
import 'package:osinara/src/terminal/terminal_profile.dart';

void main() {
  group('TerminalPreferenceResolver', () {
    test('keeps a saved terminal when it is still installed', () {
      final selected = TerminalPreferenceResolver.resolve(
        installedProfiles: [TerminalProfile.kitty, TerminalProfile.xterm],
        savedProfile: TerminalProfile.xterm,
      );

      expect(selected, TerminalProfile.xterm);
    });

    test(
      'selects the first installed terminal when saved terminal is missing',
      () {
        final selected = TerminalPreferenceResolver.resolve(
          installedProfiles: [TerminalProfile.kitty, TerminalProfile.xterm],
          savedProfile: TerminalProfile.gnomeTerminal,
        );

        expect(selected, TerminalProfile.kitty);
      },
    );

    test('returns null when no supported terminals are installed', () {
      final selected = TerminalPreferenceResolver.resolve(
        installedProfiles: const [],
        savedProfile: TerminalProfile.gnomeTerminal,
      );

      expect(selected, isNull);
    });
  });
}
