/// Tests for the Git authentication dialog UI.
///
/// Key constructs:
/// - [GitAuthDialog]: verifies code display, browser opening, and success state.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/git_auth_dialog.dart';
import 'package:osinara/src/git/browser_launcher.dart';
import 'package:osinara/src/git/git_auth_flow.dart';
import 'package:osinara/src/git/git_auth_process.dart';
import 'package:osinara/src/localization/app_locale.dart';
import 'package:osinara/src/localization/app_strings.dart';
import 'package:osinara/src/theme/osinara_theme.dart';

void main() {
  testWidgets('shows device code and success state', (tester) async {
    final process = _FakeGitAuthProcess();
    final browserLauncher = _FakeBrowserLauncher();

    await tester.pumpWidget(
      _dialogApp(process: process, browserLauncher: browserLauncher),
    );
    await tester.tap(find.text('open'));
    await tester.pump();

    process.addOutput('! First copy your one-time code: 1136-7478\n');
    await tester.pump();
    await tester.pump();

    expect(find.text('1136-7478'), findsOneWidget);
    expect(browserLauncher.openedUrls, ['https://github.com/login/device']);

    process.complete(0);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(find.byType(GitAuthDialog), findsNothing);
    expect(find.text('result:succeeded'), findsOneWidget);
  });
}

Widget _dialogApp({
  required _FakeGitAuthProcess process,
  required _FakeBrowserLauncher browserLauncher,
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
    home: _DialogHost(process: process, browserLauncher: browserLauncher),
  );
}

final class _DialogHost extends StatefulWidget {
  const _DialogHost({required this.process, required this.browserLauncher});

  final _FakeGitAuthProcess process;
  final _FakeBrowserLauncher browserLauncher;

  @override
  State<_DialogHost> createState() => _DialogHostState();
}

final class _DialogHostState extends State<_DialogHost> {
  var _result = 'none';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          Text('result:$_result'),
          TextButton(
            onPressed: () async {
              final result = await showDialog<GitAuthDialogResult>(
                context: context,
                builder: (context) => GitAuthDialog(
                  provider: GitAuthProvider.github,
                  processLauncher: _FakeGitAuthProcessLauncher(widget.process),
                  browserLauncher: widget.browserLauncher,
                  environment: const {},
                ),
              );
              setState(() => _result = result?.name ?? 'none');
            },
            child: const Text('open'),
          ),
        ],
      ),
    );
  }
}

final class _FakeGitAuthProcessLauncher implements GitAuthProcessLauncher {
  const _FakeGitAuthProcessLauncher(this.process);

  final _FakeGitAuthProcess process;

  @override
  Future<GitAuthProcess> start(GitAuthProcessRequest request) async => process;
}

final class _FakeGitAuthProcess implements GitAuthProcess {
  final _output = StreamController<String>();
  final _exitCode = Completer<int>();

  @override
  Stream<String> get output => _output.stream;

  @override
  Future<int> get exitCode => _exitCode.future;

  @override
  void write(String data) {}

  @override
  bool kill() {
    complete(130);
    return true;
  }

  void addOutput(String chunk) => _output.add(chunk);

  void complete(int exitCode) {
    if (!_exitCode.isCompleted) {
      _exitCode.complete(exitCode);
    }
    unawaited(_output.close());
  }
}

final class _FakeBrowserLauncher implements BrowserLauncher {
  final openedUrls = <String>[];

  @override
  Future<void> open(String url) async {
    openedUrls.add(url);
  }
}
