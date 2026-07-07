/// Window control abstraction for custom desktop chrome.
///
/// Key constructs:
/// - [AppWindowController]: testable contract for window actions used by title bar buttons.
/// - [WindowManagerAppWindowController]: production implementation backed by `window_manager`.
library;

import 'package:window_manager/window_manager.dart';

abstract interface class AppWindowController {
  Future<void> startDragging();

  Future<void> minimize();

  Future<bool> toggleMaximize();

  Future<bool> toggleFullScreen();

  Future<void> close();
}

final class WindowManagerAppWindowController implements AppWindowController {
  const WindowManagerAppWindowController();

  @override
  Future<void> close() async {
    await windowManager.close();
  }

  @override
  Future<void> minimize() async {
    await windowManager.minimize();
  }

  @override
  Future<void> startDragging() async {
    await windowManager.startDragging();
  }

  @override
  Future<bool> toggleFullScreen() async {
    final isFullScreen = await windowManager.isFullScreen();
    final nextFullScreen = !isFullScreen;
    await windowManager.setFullScreen(nextFullScreen);
    return nextFullScreen;
  }

  @override
  Future<bool> toggleMaximize() async {
    final isMaximized = await windowManager.isMaximized();
    if (isMaximized) {
      await windowManager.unmaximize();
      return false;
    }

    await windowManager.maximize();
    return true;
  }
}
