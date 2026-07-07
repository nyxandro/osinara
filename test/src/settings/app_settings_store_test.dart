import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/settings/app_settings.dart';
import 'package:osinara/src/settings/app_settings_store.dart';
import 'package:osinara/src/terminal/terminal_profile.dart';

void main() {
  group('AppSettingsStore', () {
    test(
      'returns empty settings when the settings file does not exist',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'osinara-settings-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final store = AppSettingsStore(File('${directory.path}/settings.json'));

        final settings = await store.read();

        expect(settings.selectedTerminalProfile, isNull);
      },
    );

    test('persists and reads selected terminal profile', () async {
      final directory = await Directory.systemTemp.createTemp(
        'osinara-settings-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final store = AppSettingsStore(File('${directory.path}/settings.json'));

      await store.write(
        const AppSettings(selectedTerminalProfile: TerminalProfile.kitty),
      );

      final settings = await store.read();
      expect(settings.selectedTerminalProfile, TerminalProfile.kitty);
    });

    test('rejects unknown terminal profile identifiers', () async {
      final directory = await Directory.systemTemp.createTemp(
        'osinara-settings-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/settings.json');
      await file.writeAsString('{"selectedTerminalProfile":"missing"}');
      final store = AppSettingsStore(file);

      expect(store.read(), throwsA(isA<StateError>()));
    });
  });
}
