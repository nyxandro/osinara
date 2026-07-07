/// Entry point for the Osinara desktop workspace shell.
library;

import 'package:flutter/material.dart';

import 'src/app/osinara_app.dart';
import 'src/window/app_window_bootstrapper.dart';

export 'src/app/osinara_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppWindowBootstrapper.configure();

  runApp(const OsinaraApp());
}
