import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/git_panel.dart';
import 'package:osinara/src/git/git_repository_actions.dart';
import 'package:osinara/src/git/git_status_reader.dart';
import 'package:osinara/src/localization/app_strings.dart';
import 'package:osinara/src/theme/osinara_theme.dart';

void main() {
  testWidgets('renders branch and changed files', (tester) async {
    await tester.pumpWidget(
      _app(
        GitPanel(
          projectPath: '/workspace/osinara',
          reader: GitStatusReader(
            runner: _FakeGitCommandRunner(
              const GitCommandResult(
                exitCode: 0,
                stdout:
                    '## main...origin/main\n M lib/main.dart\n?? notes.md\n',
                stderr: '',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('git-panel')), findsOneWidget);
    expect(find.text('main...origin/main'), findsOneWidget);
    expect(find.text('lib/main.dart'), findsOneWidget);
    expect(find.text('notes.md'), findsOneWidget);
    expect(find.text('Modified'), findsOneWidget);
    expect(find.text('Untracked'), findsOneWidget);
  });

  testWidgets('publishes an initialized repository with explicit fields', (
    tester,
  ) async {
    final actions = _FakeGitRepositoryActions();

    await tester.pumpWidget(
      _app(
        GitPanel(
          projectPath: '/workspace/osinara',
          actions: actions,
          reader: GitStatusReader(
            runner: _FakeGitCommandRunner(
              const GitCommandResult(
                exitCode: 0,
                stdout: '## main\n',
                stderr: '',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('git-publish-button')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('git-publish-owner-field')),
      'nyxandro',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-repo-field')),
      'osinara',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-remote-field')),
      'origin',
    );
    await tester.tap(find.byKey(const Key('git-publish-provider-github')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('git-publish-visibility-private')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('git-publish-submit-button')));
    await tester.pumpAndSettle();

    expect(actions.publishRequests, hasLength(1));
    expect(actions.publishRequests.single.provider, GitRemoteProvider.github);
    expect(actions.publishRequests.single.owner, 'nyxandro');
    expect(actions.publishRequests.single.repositoryName, 'osinara');
    expect(
      actions.publishRequests.single.visibility,
      GitRepositoryVisibility.private,
    );
    expect(actions.publishRequests.single.remoteName, 'origin');
    expect(actions.publishRequests.single.projectPath, '/workspace/osinara');
  });

  testWidgets('requires an explicit publish visibility', (tester) async {
    final actions = _FakeGitRepositoryActions();

    await tester.pumpWidget(
      _app(
        GitPanel(
          projectPath: '/workspace/osinara',
          actions: actions,
          reader: GitStatusReader(
            runner: _FakeGitCommandRunner(
              const GitCommandResult(
                exitCode: 0,
                stdout: '## main\n',
                stderr: '',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('git-publish-button')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('git-publish-owner-field')),
      'nyxandro',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-repo-field')),
      'osinara',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-remote-field')),
      'origin',
    );
    await tester.tap(find.byKey(const Key('git-publish-provider-github')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('git-publish-submit-button')));
    await tester.pump();

    expect(actions.publishRequests, isEmpty);
    expect(
      find.textContaining('OSI_GIT_PUBLISH_VISIBILITY_REQUIRED'),
      findsOneWidget,
    );
  });

  testWidgets('requires an explicit publish provider', (tester) async {
    final actions = _FakeGitRepositoryActions();

    await tester.pumpWidget(
      _app(
        GitPanel(
          projectPath: '/workspace/osinara',
          actions: actions,
          reader: GitStatusReader(
            runner: _FakeGitCommandRunner(
              const GitCommandResult(
                exitCode: 0,
                stdout: '## main\n',
                stderr: '',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('git-publish-button')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('git-publish-owner-field')),
      'nyxandro',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-repo-field')),
      'osinara',
    );
    await tester.enterText(
      find.byKey(const Key('git-publish-remote-field')),
      'origin',
    );
    await tester.tap(find.byKey(const Key('git-publish-visibility-private')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('git-publish-submit-button')));
    await tester.pump();

    expect(actions.publishRequests, isEmpty);
    expect(
      find.textContaining('OSI_GIT_PUBLISH_PROVIDER_REQUIRED'),
      findsOneWidget,
    );
  });

  testWidgets('renders non repository message', (tester) async {
    final actions = _FakeGitRepositoryActions();

    await tester.pumpWidget(
      _app(
        GitPanel(
          projectPath: '/workspace/plain',
          actions: actions,
          reader: GitStatusReader(
            runner: _FakeGitCommandRunner(
              const GitCommandResult(
                exitCode: 128,
                stdout: '',
                stderr: 'fatal: not a git repository',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Not a Git repository'), findsOneWidget);
    expect(find.byKey(const Key('git-init-button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('git-init-button')));
    await tester.pump();

    expect(actions.initializedPaths, ['/workspace/plain']);
  });
}

Widget _app(Widget child) {
  return MaterialApp(
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: const [AppStrings.delegate],
    theme: OsinaraThemeCatalog.byId(OsinaraThemeId.dark).buildTheme(),
    home: Scaffold(body: child),
  );
}

final class _FakeGitCommandRunner implements GitCommandRunner {
  const _FakeGitCommandRunner(this.result);

  final GitCommandResult result;

  @override
  Future<GitCommandResult> run({
    required String projectPath,
    required List<String> arguments,
  }) async {
    return result;
  }
}

final class _FakeGitRepositoryActions extends GitRepositoryActions {
  _FakeGitRepositoryActions() : super(runner: _NoopGitActionRunner());

  final initializedPaths = <String>[];
  final publishRequests = <GitPublishRequest>[];

  @override
  Future<void> initialize(String projectPath) async {
    initializedPaths.add(projectPath);
  }

  @override
  Future<void> publish(GitPublishRequest request) async {
    publishRequests.add(request);
  }
}

final class _NoopGitActionRunner implements GitActionRunner {
  @override
  Future<GitActionResult> run({
    required String executable,
    required List<String> arguments,
    required String workingDirectory,
  }) async {
    return const GitActionResult(exitCode: 0, stdout: '', stderr: '');
  }
}
