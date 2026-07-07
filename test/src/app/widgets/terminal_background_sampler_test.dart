import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/terminal_background_sampler.dart';

void main() {
  test('sampleDominantTerminalEdgeColor returns dominant edge color', () {
    const width = 8;
    const height = 8;
    const terminalBackground = Color(0xFF1E1E1E);
    const noisyInterior = Color(0xFFFF9900);
    final bytes = ByteData(width * height * 4);

    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        final edgePixel =
            x < terminalEdgeSampleBand ||
            y < terminalEdgeSampleBand ||
            x >= width - terminalEdgeSampleBand ||
            y >= height - terminalEdgeSampleBand;
        _writePixel(
          bytes: bytes,
          width: width,
          x: x,
          y: y,
          color: edgePixel ? terminalBackground : noisyInterior,
        );
      }
    }

    expect(
      sampleDominantTerminalEdgeColor(
        bytes: bytes,
        width: width,
        height: height,
      ),
      terminalBackground,
    );
  });

  test('sampleDominantTerminalEdgeColor ignores transparent edge pixels', () {
    const width = 6;
    const height = 6;
    const terminalBackground = Color(0xFF202020);
    final bytes = ByteData(width * height * 4);

    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        _writePixel(
          bytes: bytes,
          width: width,
          x: x,
          y: y,
          color: const Color(0x00000000),
        );
      }
    }
    _writePixel(
      bytes: bytes,
      width: width,
      x: 0,
      y: 0,
      color: terminalBackground,
    );

    expect(
      sampleDominantTerminalEdgeColor(
        bytes: bytes,
        width: width,
        height: height,
      ),
      terminalBackground,
    );
  });
}

void _writePixel({
  required ByteData bytes,
  required int width,
  required int x,
  required int y,
  required Color color,
}) {
  final offset = ((y * width) + x) * 4;
  bytes.setUint8(offset, _colorChannel(color.r));
  bytes.setUint8(offset + 1, _colorChannel(color.g));
  bytes.setUint8(offset + 2, _colorChannel(color.b));
  bytes.setUint8(offset + 3, _colorChannel(color.a));
}

int _colorChannel(double value) {
  return (value * 255).round().clamp(0, 255);
}
