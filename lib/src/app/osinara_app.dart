/// Root Material application for the Osinara desktop shell.
///
/// Key constructs:
/// - [OsinaraApp]: owns app-wide locale and theme selection state.
/// - [_OsinaraAppState]: wires localization, theme catalog, and workspace shell.
library;

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../embedded_terminal/embedded_terminal_process.dart';
import '../file_tree/file_tree_reader.dart';
import '../file_tree/file_tree_watch_service.dart';
import '../git/browser_launcher.dart';
import '../git/git_auth_process.dart';
import '../git/git_status_reader.dart';
import '../localization/app_locale.dart';
import '../localization/app_strings.dart';
import '../projects/project_workspace.dart';
import '../settings/workspace_state_store.dart';
import '../theme/osinara_theme.dart';
import '../window/app_window_controller.dart';
import 'widgets/app_window_frame.dart';
import 'widgets/file_viewer.dart';
import 'workspace_shell.dart';

class OsinaraApp extends StatefulWidget {
  const OsinaraApp({
    super.key,
    this.terminalProcessFactory,
    this.fileTreeReader,
    this.fileTreeWatchService,
    this.fileContentReader,
    this.gitStatusReader,
    this.gitAuthProcessLauncher,
    this.browserLauncher,
    this.workspaceStateRepository,
    this.windowController,
    this.initialProjects,
  });

  final EmbeddedTerminalProcessFactory? terminalProcessFactory;
  final FileTreeReader? fileTreeReader;
  final FileTreeWatchService? fileTreeWatchService;
  final FileContentReader? fileContentReader;
  final GitStatusReader? gitStatusReader;
  final GitAuthProcessLauncher? gitAuthProcessLauncher;
  final BrowserLauncher? browserLauncher;
  final WorkspaceStateRepository? workspaceStateRepository;
  final AppWindowController? windowController;
  final List<ProjectWorkspace>? initialProjects;

  @override
  State<OsinaraApp> createState() => _OsinaraAppState();
}

class _OsinaraAppState extends State<OsinaraApp> {
  var _locale = AppLocale.english;
  var _themeId = OsinaraThemeId.dark;

  @override
  Widget build(BuildContext context) {
    final theme = OsinaraThemeCatalog.byId(_themeId);

    // Theme selection stays at the root so every panel receives the same tokens.
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Osinara',
      locale: _locale.locale,
      supportedLocales: AppStrings.supportedLocales,
      localizationsDelegates: const [
        AppStrings.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: theme.buildTheme(),
      home: AppWindowFrame(
        windowController: widget.windowController,
        child: WorkspaceShell(
          locale: _locale,
          themeId: _themeId,
          initialProjects: widget.initialProjects,
          terminalProcessFactory: widget.terminalProcessFactory,
          fileTreeReader: widget.fileTreeReader,
          fileTreeWatchService: widget.fileTreeWatchService,
          fileContentReader: widget.fileContentReader,
          gitStatusReader: widget.gitStatusReader,
          gitAuthProcessLauncher: widget.gitAuthProcessLauncher,
          browserLauncher: widget.browserLauncher,
          workspaceStateRepository: widget.workspaceStateRepository,
          onLocaleChanged: (locale) => setState(() => _locale = locale),
          onThemeChanged: (themeId) => setState(() => _themeId = themeId),
        ),
      ),
    );
  }
}
