/// Theme catalog and app-specific visual tokens.
///
/// Key constructs:
/// - [OsinaraThemeId]: stable identifiers for selectable app themes.
/// - [OsinaraThemeOption]: catalog entry with localized labels and a theme builder.
/// - [OsinaraThemeTokens]: custom colors that Material [ColorScheme] does not cover.
/// - [OsinaraThemeCatalog]: single registry for available themes and lookup logic.
library;

import 'package:flutter/material.dart';

import '../localization/app_locale.dart';

const _darkSeedColor = Color(0xFF6D8CFF);
const _lightSeedColor = Color(0xFF4B65D8);
const _cardBorderOpacity = 0.10;
const _cardBorderRadius = 24.0;

enum OsinaraThemeId { dark, light }

final class OsinaraThemeOption {
  const OsinaraThemeOption({
    required this.id,
    required this.englishLabel,
    required this.russianLabel,
    required this.buildTheme,
  });

  final OsinaraThemeId id;
  final String englishLabel;
  final String russianLabel;
  final ThemeData Function() buildTheme;

  String label(AppLocale locale) {
    return switch (locale) {
      AppLocale.english => englishLabel,
      AppLocale.russian => russianLabel,
    };
  }
}

@immutable
final class OsinaraThemeTokens extends ThemeExtension<OsinaraThemeTokens> {
  const OsinaraThemeTokens({
    required this.filePanelBackground,
    required this.projectPanelBackground,
    required this.statusBarBackground,
    required this.resizeHandle,
    required this.resizeHandleActive,
    required this.folderIcon,
    required this.dartIcon,
    required this.markdownIcon,
    required this.configIcon,
    required this.windowTitleBarBackground,
    required this.windowTitleBarBorder,
    required this.windowTitleBarControlHover,
    required this.windowTitleBarControlPressed,
    required this.windowTitleBarCloseHover,
    required this.windowTitleBarClosePressed,
  });

  final Color filePanelBackground;
  final Color projectPanelBackground;
  final Color statusBarBackground;
  final Color resizeHandle;
  final Color resizeHandleActive;
  final Color folderIcon;
  final Color dartIcon;
  final Color markdownIcon;
  final Color configIcon;
  final Color windowTitleBarBackground;
  final Color windowTitleBarBorder;
  final Color windowTitleBarControlHover;
  final Color windowTitleBarControlPressed;
  final Color windowTitleBarCloseHover;
  final Color windowTitleBarClosePressed;

  static OsinaraThemeTokens of(BuildContext context) {
    final tokens = Theme.of(context).extension<OsinaraThemeTokens>();
    if (tokens != null) {
      return tokens;
    }

    throw StateError(
      'OSI_THEME_TOKENS_MISSING: Не удалось загрузить токены темы. Перезапустите приложение.',
    );
  }

  @override
  OsinaraThemeTokens copyWith({
    Color? filePanelBackground,
    Color? projectPanelBackground,
    Color? statusBarBackground,
    Color? resizeHandle,
    Color? resizeHandleActive,
    Color? folderIcon,
    Color? dartIcon,
    Color? markdownIcon,
    Color? configIcon,
    Color? windowTitleBarBackground,
    Color? windowTitleBarBorder,
    Color? windowTitleBarControlHover,
    Color? windowTitleBarControlPressed,
    Color? windowTitleBarCloseHover,
    Color? windowTitleBarClosePressed,
  }) {
    return OsinaraThemeTokens(
      filePanelBackground: filePanelBackground ?? this.filePanelBackground,
      projectPanelBackground:
          projectPanelBackground ?? this.projectPanelBackground,
      statusBarBackground: statusBarBackground ?? this.statusBarBackground,
      resizeHandle: resizeHandle ?? this.resizeHandle,
      resizeHandleActive: resizeHandleActive ?? this.resizeHandleActive,
      folderIcon: folderIcon ?? this.folderIcon,
      dartIcon: dartIcon ?? this.dartIcon,
      markdownIcon: markdownIcon ?? this.markdownIcon,
      configIcon: configIcon ?? this.configIcon,
      windowTitleBarBackground:
          windowTitleBarBackground ?? this.windowTitleBarBackground,
      windowTitleBarBorder: windowTitleBarBorder ?? this.windowTitleBarBorder,
      windowTitleBarControlHover:
          windowTitleBarControlHover ?? this.windowTitleBarControlHover,
      windowTitleBarControlPressed:
          windowTitleBarControlPressed ?? this.windowTitleBarControlPressed,
      windowTitleBarCloseHover:
          windowTitleBarCloseHover ?? this.windowTitleBarCloseHover,
      windowTitleBarClosePressed:
          windowTitleBarClosePressed ?? this.windowTitleBarClosePressed,
    );
  }

  @override
  OsinaraThemeTokens lerp(ThemeExtension<OsinaraThemeTokens>? other, double t) {
    if (other is! OsinaraThemeTokens) {
      return this;
    }

    return OsinaraThemeTokens(
      filePanelBackground: Color.lerp(
        filePanelBackground,
        other.filePanelBackground,
        t,
      )!,
      projectPanelBackground: Color.lerp(
        projectPanelBackground,
        other.projectPanelBackground,
        t,
      )!,
      statusBarBackground: Color.lerp(
        statusBarBackground,
        other.statusBarBackground,
        t,
      )!,
      resizeHandle: Color.lerp(resizeHandle, other.resizeHandle, t)!,
      resizeHandleActive: Color.lerp(
        resizeHandleActive,
        other.resizeHandleActive,
        t,
      )!,
      folderIcon: Color.lerp(folderIcon, other.folderIcon, t)!,
      dartIcon: Color.lerp(dartIcon, other.dartIcon, t)!,
      markdownIcon: Color.lerp(markdownIcon, other.markdownIcon, t)!,
      configIcon: Color.lerp(configIcon, other.configIcon, t)!,
      windowTitleBarBackground: Color.lerp(
        windowTitleBarBackground,
        other.windowTitleBarBackground,
        t,
      )!,
      windowTitleBarBorder: Color.lerp(
        windowTitleBarBorder,
        other.windowTitleBarBorder,
        t,
      )!,
      windowTitleBarControlHover: Color.lerp(
        windowTitleBarControlHover,
        other.windowTitleBarControlHover,
        t,
      )!,
      windowTitleBarControlPressed: Color.lerp(
        windowTitleBarControlPressed,
        other.windowTitleBarControlPressed,
        t,
      )!,
      windowTitleBarCloseHover: Color.lerp(
        windowTitleBarCloseHover,
        other.windowTitleBarCloseHover,
        t,
      )!,
      windowTitleBarClosePressed: Color.lerp(
        windowTitleBarClosePressed,
        other.windowTitleBarClosePressed,
        t,
      )!,
    );
  }
}

final class OsinaraThemeCatalog {
  const OsinaraThemeCatalog._();

  static final List<OsinaraThemeOption> all = [
    OsinaraThemeOption(
      id: OsinaraThemeId.dark,
      englishLabel: 'Dark',
      russianLabel: 'Тёмная',
      buildTheme: _buildDarkTheme,
    ),
    OsinaraThemeOption(
      id: OsinaraThemeId.light,
      englishLabel: 'Light',
      russianLabel: 'Светлая',
      buildTheme: _buildLightTheme,
    ),
  ];

  static OsinaraThemeOption byId(OsinaraThemeId id) {
    for (final option in all) {
      if (option.id == id) {
        return option;
      }
    }

    throw StateError(
      'OSI_THEME_NOT_FOUND: Не удалось найти выбранную тему интерфейса. Перезапустите приложение.',
    );
  }
}

ThemeData _buildDarkTheme() {
  const surfaceColor = Color(0xFF101726);
  const backgroundColor = Color(0xFF080B12);
  final colorScheme = ColorScheme.fromSeed(
    seedColor: _darkSeedColor,
    brightness: Brightness.dark,
    surface: surfaceColor,
  );

  return _buildThemeData(
    colorScheme: colorScheme,
    scaffoldBackgroundColor: backgroundColor,
    cardColor: surfaceColor,
    cardBorderColor: Colors.white.withValues(alpha: _cardBorderOpacity),
    tokens: const OsinaraThemeTokens(
      filePanelBackground: Color(0xFF171A2A),
      projectPanelBackground: surfaceColor,
      statusBarBackground: Color(0xFF0B0F19),
      resizeHandle: Color(0xFF2A3245),
      resizeHandleActive: Color(0xFF8EA2FF),
      folderIcon: Color(0xFF7E859C),
      dartIcon: Color(0xFF45B7FF),
      markdownIcon: Color(0xFF70D6FF),
      configIcon: Color(0xFFFF5C8A),
      windowTitleBarBackground: Color(0xFF0B0F19),
      windowTitleBarBorder: Color(0xFF22293A),
      windowTitleBarControlHover: Color(0xFF20283B),
      windowTitleBarControlPressed: Color(0xFF2A3550),
      windowTitleBarCloseHover: Color(0xFFB42342),
      windowTitleBarClosePressed: Color(0xFF8E1C34),
    ),
  );
}

ThemeData _buildLightTheme() {
  const surfaceColor = Color(0xFFFFFFFF);
  const backgroundColor = Color(0xFFF6F7FB);
  final colorScheme = ColorScheme.fromSeed(
    seedColor: _lightSeedColor,
    brightness: Brightness.light,
    surface: surfaceColor,
  );

  return _buildThemeData(
    colorScheme: colorScheme,
    scaffoldBackgroundColor: backgroundColor,
    cardColor: surfaceColor,
    cardBorderColor: const Color(0xFFDDE2F0),
    tokens: const OsinaraThemeTokens(
      filePanelBackground: Color(0xFFEFF2FA),
      projectPanelBackground: Color(0xFFF8F9FD),
      statusBarBackground: Color(0xFFE8ECF7),
      resizeHandle: Color(0xFFC7D0E7),
      resizeHandleActive: Color(0xFF4B65D8),
      folderIcon: Color(0xFF66708A),
      dartIcon: Color(0xFF1574B8),
      markdownIcon: Color(0xFF0D7899),
      configIcon: Color(0xFFB42353),
      windowTitleBarBackground: Color(0xFFF8F9FD),
      windowTitleBarBorder: Color(0xFFDDE2F0),
      windowTitleBarControlHover: Color(0xFFE9EDF8),
      windowTitleBarControlPressed: Color(0xFFDDE5F8),
      windowTitleBarCloseHover: Color(0xFFE5485D),
      windowTitleBarClosePressed: Color(0xFFC9364C),
    ),
  );
}

ThemeData _buildThemeData({
  required ColorScheme colorScheme,
  required Color scaffoldBackgroundColor,
  required Color cardColor,
  required Color cardBorderColor,
  required OsinaraThemeTokens tokens,
}) {
  return ThemeData(
    useMaterial3: true,
    brightness: colorScheme.brightness,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: scaffoldBackgroundColor,
    cardTheme: CardThemeData(
      color: cardColor,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_cardBorderRadius),
        side: BorderSide(color: cardBorderColor),
      ),
    ),
    extensions: [tokens],
  );
}
