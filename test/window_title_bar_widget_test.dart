import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/app_window_frame.dart';
import 'package:osinara/src/localization/app_strings.dart';
import 'package:osinara/src/theme/osinara_theme.dart';
import 'package:osinara/src/window/app_window_controller.dart';

void main() {
  testWidgets('renders themed title bar and wires window controls', (
    tester,
  ) async {
    final controller = _RecordingWindowController();

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [AppStrings.delegate],
        theme: OsinaraThemeCatalog.byId(OsinaraThemeId.dark).buildTheme(),
        home: AppWindowFrame(
          windowController: controller,
          child: const SizedBox(key: Key('window-frame-body')),
        ),
      ),
    );

    final titleBar = find.byKey(const Key('app-title-bar'));
    final titleBarWidget = tester.widget<DecoratedBox>(titleBar);
    final titleBarDecoration = titleBarWidget.decoration as BoxDecoration;
    final tokens = OsinaraThemeTokens.of(tester.element(titleBar));

    expect(titleBarDecoration.color, tokens.windowTitleBarBackground);
    expect(find.text('Osinara'), findsOneWidget);
    expect(
      tester.getTopLeft(titleBar).dy,
      lessThan(
        tester.getTopLeft(find.byKey(const Key('window-frame-body'))).dy,
      ),
    );

    await tester.tap(find.byKey(const Key('window-minimize-button')));
    await tester.tap(find.byKey(const Key('window-maximize-button')));
    await tester.tap(find.byKey(const Key('window-close-button')));

    expect(find.byKey(const Key('window-fullscreen-button')), findsNothing);
    expect(controller.minimizeCalls, 1);
    expect(controller.maximizeCalls, 1);
    expect(controller.fullScreenCalls, 0);
    expect(controller.closeCalls, 1);
  });
}

final class _RecordingWindowController implements AppWindowController {
  var closeCalls = 0;
  var fullScreenCalls = 0;
  var maximizeCalls = 0;
  var minimizeCalls = 0;
  var dragCalls = 0;
  var maximized = false;
  var fullScreen = false;

  @override
  Future<void> close() async {
    closeCalls += 1;
  }

  @override
  Future<void> minimize() async {
    minimizeCalls += 1;
  }

  @override
  Future<void> startDragging() async {
    dragCalls += 1;
  }

  @override
  Future<bool> toggleFullScreen() async {
    fullScreenCalls += 1;
    fullScreen = !fullScreen;
    return fullScreen;
  }

  @override
  Future<bool> toggleMaximize() async {
    maximizeCalls += 1;
    maximized = !maximized;
    return maximized;
  }
}
