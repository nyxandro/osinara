/// Edge-pixel background sampler for terminal viewports.
///
/// Key constructs:
/// - [TerminalBackgroundSampler]: captures the painted terminal and reports a dominant edge color.
/// - [sampleDominantTerminalEdgeColor]: pure RGBA edge sampling helper used by tests.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

const terminalEdgeSampleBand = 3;
const terminalColorBucketMask = 0xF8;
const _terminalSampleDelay = Duration(milliseconds: 160);
const _fullyTransparentAlpha = 0;

class TerminalBackgroundSampler extends StatefulWidget {
  const TerminalBackgroundSampler({
    super.key,
    required this.onColorSampled,
    required this.child,
  });

  final ValueChanged<Color> onColorSampled;
  final Widget child;

  @override
  State<TerminalBackgroundSampler> createState() =>
      _TerminalBackgroundSamplerState();
}

class _TerminalBackgroundSamplerState extends State<TerminalBackgroundSampler> {
  final _boundaryKey = GlobalKey();
  Timer? _sampleTimer;
  Color? _lastReportedColor;

  @override
  void initState() {
    super.initState();
    _scheduleSample();
  }

  @override
  void didUpdateWidget(TerminalBackgroundSampler oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.child != widget.child) {
      _scheduleSample();
    }
  }

  @override
  void dispose() {
    _sampleTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(key: _boundaryKey, child: widget.child);
  }

  void _scheduleSample() {
    _sampleTimer?.cancel();

    // Sampling after the first paint lets terminal TUIs draw their edge background before the tab color is chosen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }

      _sampleTimer = Timer(_terminalSampleDelay, () {
        unawaited(_samplePaintedEdges());
      });
    });
  }

  Future<void> _samplePaintedEdges() async {
    final renderObject = _boundaryKey.currentContext?.findRenderObject();
    if (renderObject is! RenderRepaintBoundary) {
      return;
    }

    // `toImage` is only safe after paint; scrolling/settings transitions can leave one frame pending.
    if (renderObject.debugNeedsPaint) {
      _scheduleSample();
      return;
    }

    final image = await renderObject.toImage(pixelRatio: 1);
    final width = image.width;
    final height = image.height;
    final byteData = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    image.dispose();
    if (byteData == null) {
      return;
    }

    final color = sampleDominantTerminalEdgeColor(
      bytes: byteData,
      width: width,
      height: height,
    );
    if (color == null || color == _lastReportedColor || !mounted) {
      return;
    }

    _lastReportedColor = color;
    widget.onColorSampled(color);
  }
}

Color? sampleDominantTerminalEdgeColor({
  required ByteData bytes,
  required int width,
  required int height,
}) {
  if (width <= 0 || height <= 0) {
    return null;
  }

  final band = terminalEdgeSampleBand
      .clamp(1, width < height ? width : height)
      .toInt();
  final buckets = <int, _ColorBucket>{};

  void samplePixel(int x, int y) {
    final offset = ((y * width) + x) * 4;
    final red = bytes.getUint8(offset);
    final green = bytes.getUint8(offset + 1);
    final blue = bytes.getUint8(offset + 2);
    final alpha = bytes.getUint8(offset + 3);
    if (alpha == _fullyTransparentAlpha) {
      return;
    }

    final bucketKey =
        ((red & terminalColorBucketMask) << 16) |
        ((green & terminalColorBucketMask) << 8) |
        (blue & terminalColorBucketMask);
    final bucket = buckets.putIfAbsent(bucketKey, _ColorBucket.new);
    bucket.add(red: red, green: green, blue: blue, alpha: alpha);
  }

  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < band; x += 1) {
      samplePixel(x, y);
      samplePixel(width - 1 - x, y);
    }
  }
  for (var x = 0; x < width; x += 1) {
    for (var y = 0; y < band; y += 1) {
      samplePixel(x, y);
      samplePixel(x, height - 1 - y);
    }
  }

  if (buckets.isEmpty) {
    return null;
  }

  final dominant = buckets.values.reduce((left, right) {
    return left.count >= right.count ? left : right;
  });
  return dominant.toColor();
}

final class _ColorBucket {
  var red = 0;
  var green = 0;
  var blue = 0;
  var alpha = 0;
  var count = 0;

  void add({
    required int red,
    required int green,
    required int blue,
    required int alpha,
  }) {
    this.red += red;
    this.green += green;
    this.blue += blue;
    this.alpha += alpha;
    count += 1;
  }

  Color toColor() {
    return Color.fromARGB(
      (alpha / count).round(),
      (red / count).round(),
      (green / count).round(),
      (blue / count).round(),
    );
  }
}
