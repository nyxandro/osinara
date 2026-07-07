/// JSON file storage for local app settings.
///
/// Key constructs:
/// - [AppSettingsRepository]: storage contract used by UI and tests.
/// - [AppSettingsStore]: reads and writes [AppSettings] without hiding malformed data.
library;

import 'dart:convert';
import 'dart:io';

import 'app_settings.dart';

const _jsonIndent = '  ';

abstract interface class AppSettingsRepository {
  Future<AppSettings> read();

  Future<void> write(AppSettings settings);
}

final class AppSettingsStore implements AppSettingsRepository {
  const AppSettingsStore(this.file);

  final File file;

  @override
  Future<AppSettings> read() async {
    if (!await file.exists()) {
      return const AppSettings(selectedTerminalProfile: null);
    }

    final raw = await file.readAsString();
    final decoded = jsonDecode(raw);
    return AppSettings.fromJson(decoded);
  }

  @override
  Future<void> write(AppSettings settings) async {
    final parent = file.parent;
    if (!await parent.exists()) {
      await parent.create(recursive: true);
    }

    const encoder = JsonEncoder.withIndent(_jsonIndent);
    await file.writeAsString('${encoder.convert(settings.toJson())}\n');
  }
}
