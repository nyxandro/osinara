/// Full-size embedded terminal viewport for one active PTY-backed session.
///
/// Key constructs:
/// - [EmbeddedTerminalWorkspace]: renders the selected [TerminalView] without extra chrome.
/// - [terminalThemeForBackground]: creates a terminal theme with a sampled viewport background.
library;

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../embedded_terminal/embedded_terminal_session.dart';
import 'terminal_background_sampler.dart';

const _terminalFontSize = 13.5;

class EmbeddedTerminalWorkspace extends StatelessWidget {
  const EmbeddedTerminalWorkspace({
    super.key,
    required this.session,
    required this.backgroundColor,
    required this.onBackgroundColorSampled,
  });

  final EmbeddedTerminalSession session;
  final Color? backgroundColor;
  final ValueChanged<Color> onBackgroundColorSampled;

  @override
  Widget build(BuildContext context) {
    final effectiveTheme = terminalThemeForBackground(backgroundColor);

    // The terminal must occupy the whole content area under the tab bar without cards, margins, or borders.
    return ColoredBox(
      key: const Key('embedded-terminal-pane'),
      color: effectiveTheme.background,
      child: TerminalBackgroundSampler(
        onColorSampled: onBackgroundColorSampled,
        child: TerminalView(
          key: const Key('embedded-terminal-view'),
          session.terminal,
          theme: effectiveTheme,
          textStyle: const TerminalStyle(fontSize: _terminalFontSize),
          padding: EdgeInsets.zero,
          autofocus: true,
        ),
      ),
    );
  }
}

TerminalTheme terminalThemeForBackground(Color? backgroundColor) {
  final baseTheme = TerminalThemes.defaultTheme;
  final background = backgroundColor ?? baseTheme.background;

  return TerminalTheme(
    cursor: baseTheme.cursor,
    selection: baseTheme.selection,
    foreground: baseTheme.foreground,
    background: background,
    black: baseTheme.black,
    red: baseTheme.red,
    green: baseTheme.green,
    yellow: baseTheme.yellow,
    blue: baseTheme.blue,
    magenta: baseTheme.magenta,
    cyan: baseTheme.cyan,
    white: baseTheme.white,
    brightBlack: baseTheme.brightBlack,
    brightRed: baseTheme.brightRed,
    brightGreen: baseTheme.brightGreen,
    brightYellow: baseTheme.brightYellow,
    brightBlue: baseTheme.brightBlue,
    brightMagenta: baseTheme.brightMagenta,
    brightCyan: baseTheme.brightCyan,
    brightWhite: baseTheme.brightWhite,
    searchHitBackground: baseTheme.searchHitBackground,
    searchHitBackgroundCurrent: baseTheme.searchHitBackgroundCurrent,
    searchHitForeground: baseTheme.searchHitForeground,
  );
}
