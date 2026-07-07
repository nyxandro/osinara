/// Custom desktop window frame rendered inside the Flutter theme.
///
/// Key constructs:
/// - [AppWindowFrame]: wraps the app body with a themed title bar and window controls.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../localization/app_strings.dart';
import '../../theme/osinara_theme.dart';
import '../../window/app_window_controller.dart';

const _windowTitleBarHeight = 46.0;
const _windowControlWidth = 46.0;
const _windowControlIconSize = 16.0;
const _windowTitleFontSize = 13.0;
const _windowTitleLetterSpacing = 0.9;

class AppWindowFrame extends StatefulWidget {
  const AppWindowFrame({super.key, this.windowController, required this.child});

  final AppWindowController? windowController;
  final Widget child;

  @override
  State<AppWindowFrame> createState() => _AppWindowFrameState();
}

class _AppWindowFrameState extends State<AppWindowFrame> {
  late final AppWindowController _windowController =
      widget.windowController ?? const WindowManagerAppWindowController();
  var _isMaximized = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _WindowTitleBar(
          controller: _windowController,
          isMaximized: _isMaximized,
          onToggleMaximize: _toggleMaximize,
        ),
        Expanded(child: widget.child),
      ],
    );
  }

  Future<void> _toggleMaximize() async {
    final isMaximized = await _windowController.toggleMaximize();
    if (mounted) {
      setState(() => _isMaximized = isMaximized);
    }
  }
}

class _WindowTitleBar extends StatelessWidget {
  const _WindowTitleBar({
    required this.controller,
    required this.isMaximized,
    required this.onToggleMaximize,
  });

  final AppWindowController controller;
  final bool isMaximized;
  final Future<void> Function() onToggleMaximize;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final tokens = OsinaraThemeTokens.of(context);
    final colorScheme = Theme.of(context).colorScheme;

    return DecoratedBox(
      key: const Key('app-title-bar'),
      decoration: BoxDecoration(
        color: tokens.windowTitleBarBackground,
        border: Border(bottom: BorderSide(color: tokens.windowTitleBarBorder)),
      ),
      child: SizedBox(
        height: _windowTitleBarHeight,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Positioned.fill(
              child: _WindowDragRegion(
                controller: controller,
                onDoubleTap: onToggleMaximize,
              ),
            ),
            Text(
              strings.appTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: colorScheme.onSurface.withValues(alpha: 0.66),
                fontSize: _windowTitleFontSize,
                fontWeight: FontWeight.w700,
                letterSpacing: _windowTitleLetterSpacing,
              ),
            ),
            Positioned(
              right: 0,
              top: 0,
              bottom: 0,
              child: Row(
                children: [
                  _WindowControlButton(
                    key: const Key('window-minimize-button'),
                    icon: Icons.minimize_rounded,
                    tooltip: strings.minimizeWindow,
                    onPressed: () => unawaited(controller.minimize()),
                  ),
                  _WindowControlButton(
                    key: const Key('window-maximize-button'),
                    icon: isMaximized
                        ? Icons.filter_none_rounded
                        : Icons.crop_square_rounded,
                    tooltip: isMaximized
                        ? strings.restoreWindow
                        : strings.maximizeWindow,
                    onPressed: () => unawaited(onToggleMaximize()),
                  ),
                  _WindowControlButton(
                    key: const Key('window-close-button'),
                    icon: Icons.close_rounded,
                    tooltip: strings.closeWindow,
                    close: true,
                    onPressed: () => unawaited(controller.close()),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WindowDragRegion extends StatelessWidget {
  const _WindowDragRegion({
    required this.controller,
    required this.onDoubleTap,
  });

  final AppWindowController controller;
  final Future<void> Function() onDoubleTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => unawaited(controller.startDragging()),
      onDoubleTap: () => unawaited(onDoubleTap()),
    );
  }
}

class _WindowControlButton extends StatefulWidget {
  const _WindowControlButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.close = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final bool close;

  @override
  State<_WindowControlButton> createState() => _WindowControlButtonState();
}

class _WindowControlButtonState extends State<_WindowControlButton> {
  var _hovered = false;
  var _pressed = false;

  @override
  Widget build(BuildContext context) {
    final tokens = OsinaraThemeTokens.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    final background = _backgroundColor(tokens);
    final foreground = widget.close && (_hovered || _pressed)
        ? Colors.white
        : colorScheme.onSurface.withValues(alpha: 0.72);

    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 500),
      child: Semantics(
        button: true,
        label: widget.tooltip,
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() {
            _hovered = false;
            _pressed = false;
          }),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (_) => setState(() => _pressed = true),
            onTapCancel: () => setState(() => _pressed = false),
            onTapUp: (_) => setState(() => _pressed = false),
            onTap: widget.onPressed,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              width: _windowControlWidth,
              height: _windowTitleBarHeight,
              color: background,
              alignment: Alignment.center,
              child: Icon(
                widget.icon,
                size: _windowControlIconSize,
                color: foreground,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Color _backgroundColor(OsinaraThemeTokens tokens) {
    if (widget.close && _pressed) {
      return tokens.windowTitleBarClosePressed;
    }
    if (widget.close && _hovered) {
      return tokens.windowTitleBarCloseHover;
    }
    if (_pressed) {
      return tokens.windowTitleBarControlPressed;
    }
    if (_hovered) {
      return tokens.windowTitleBarControlHover;
    }

    return Colors.transparent;
  }
}
