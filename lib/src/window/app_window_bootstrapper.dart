/// Desktop window initialization for Osinara custom chrome.
///
/// Key constructs:
/// - [AppWindowBootstrapper]: configures a hidden native title bar before showing the window.
library;

import 'dart:io';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

const _initialWindowSize = Size(1280, 820);
const _minimumWindowSize = Size(960, 620);
const _initialWindowTitle = 'Osinara';

abstract final class AppWindowBootstrapper {
  static Future<void> configure() async {
    if (!_isDesktopPlatform) {
      return;
    }

    await windowManager.ensureInitialized();

    const options = WindowOptions(
      size: _initialWindowSize,
      minimumSize: _minimumWindowSize,
      center: true,
      backgroundColor: Colors.transparent,
      skipTaskbar: false,
      title: _initialWindowTitle,
      titleBarStyle: TitleBarStyle.hidden,
      windowButtonVisibility: false,
    );

    // Apply hidden chrome before showing the window to avoid a one-frame native white title bar flash.
    unawaited(
      windowManager.waitUntilReadyToShow(options, () async {
        await windowManager.show();
        await windowManager.focus();
      }),
    );
  }
}

bool get _isDesktopPlatform {
  return Platform.isLinux || Platform.isMacOS || Platform.isWindows;
}
