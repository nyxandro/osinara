/// Tests for settings actions that launch Git browser authentication.
///
/// Key constructs:
/// - [SettingsContent]: verifies GitHub/GitLab auth buttons emit provider actions.
library;

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/settings_content.dart';
import 'package:osinara/src/git/git_auth_flow.dart';
import 'package:osinara/src/localization/app_locale.dart';
import 'package:osinara/src/localization/app_strings.dart';
import 'package:osinara/src/theme/osinara_theme.dart';

void main() {
  testWidgets('starts GitHub and GitLab browser auth actions', (tester) async {
    tester.view.physicalSize = const Size(1000, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final startedProviders = <GitAuthProvider>[];

    await tester.pumpWidget(_settingsApp(onStartGitAuth: startedProviders.add));

    await tester.tap(find.byKey(const Key('git-auth-github-button')));
    await tester.pump();

    await tester.tap(find.byKey(const Key('git-auth-gitlab-button')));
    await tester.pump();

    expect(startedProviders, [GitAuthProvider.github, GitAuthProvider.gitlab]);
  });

  testWidgets('shows updated Git provider connection status', (tester) async {
    await tester.pumpWidget(
      _settingsApp(
        onStartGitAuth: (_) {},
        gitAuthStatuses: const {
          GitAuthProvider.github: GitAuthConnectionStatus.connected,
        },
      ),
    );

    expect(find.text('Connected'), findsOneWidget);
  });
}

Widget _settingsApp({
  required ValueChanged<GitAuthProvider> onStartGitAuth,
  Map<GitAuthProvider, GitAuthConnectionStatus> gitAuthStatuses = const {},
}) {
  return MaterialApp(
    locale: AppLocale.english.locale,
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: const [
      AppStrings.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    theme: OsinaraThemeCatalog.byId(OsinaraThemeId.dark).buildTheme(),
    home: Scaffold(
      body: SettingsContent(
        locale: AppLocale.english,
        themeId: OsinaraThemeId.dark,
        onLocaleChanged: (_) {},
        onThemeChanged: (_) {},
        onStartGitAuth: onStartGitAuth,
        gitAuthStatuses: gitAuthStatuses,
        onClose: () {},
      ),
    ),
  );
}
