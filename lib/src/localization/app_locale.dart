/// Supported UI languages for Osinara.
library;

import 'package:flutter/widgets.dart';

enum AppLocale {
  english(Locale('en')),
  russian(Locale('ru'));

  const AppLocale(this.locale);

  final Locale locale;

  static AppLocale fromLocale(Locale locale) {
    return switch (locale.languageCode) {
      'ru' => AppLocale.russian,
      'en' => AppLocale.english,
      _ => AppLocale.english,
    };
  }
}
