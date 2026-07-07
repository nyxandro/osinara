/// CLI entrypoint for launching an agent process and writing status events.
library;

import 'dart:io';

import 'package:osinara/src/wrapper/osinara_run.dart';

Future<void> main(List<String> args) async {
  final exitCode = await OsiRun(now: DateTime.now).run(args);
  exit(exitCode);
}
