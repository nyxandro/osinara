/// Reusable panel sizing primitives for the desktop workspace.
///
/// Key constructs:
/// - [PanelWidths]: resolved side-panel widths for the current window size.
/// - [AnimatedSidePanel]: animated width wrapper used by collapsible panels.
/// - [PanelResizeHandle]: overlay drag hit-zone with a column-resize mouse cursor.
/// - [clampPanelWidth], [maximumResizablePanelWidth]: sizing helpers for drag updates.
/// - [maximumWorkspaceFilePanelWidth], [maximumWorkspaceProjectPanelWidth]: workspace-specific resize caps.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/osinara_theme.dart';

const defaultFilePanelWidth = 345.0;
const defaultProjectPanelWidth = 310.0;
const minimumSidePanelWidth = 190.0;
const maximumFilePanelWidth = 560.0;
const maximumProjectPanelWidth = 520.0;
const minimumCenterWidth = 360.0;
const resizeHandleWidth = 8.0;
const resizeHandleVisualWidth = 1.0;
const panelAnimationDuration = Duration(milliseconds: 240);
const _resizeHandleActiveMultiplier = 2.0;
const _resizeHandleAnimationDuration = Duration(milliseconds: 120);

final class PanelWidths {
  const PanelWidths({required this.files, required this.projects});

  final double files;
  final double projects;

  static PanelWidths resolve({
    required double totalWidth,
    required bool filesVisible,
    required bool projectsVisible,
    required double preferredFilesWidth,
    required double preferredProjectsWidth,
  }) {
    if (!filesVisible && !projectsVisible) {
      return const PanelWidths(files: 0, projects: 0);
    }

    final sideBudget = math.max(0.0, totalWidth - minimumCenterWidth);
    final preferredFiles = filesVisible
        ? math.min(preferredFilesWidth, maximumFilePanelWidth)
        : 0.0;
    final preferredProjects = projectsVisible
        ? math.min(preferredProjectsWidth, maximumProjectPanelWidth)
        : 0.0;
    final preferredTotal = preferredFiles + preferredProjects;

    if (preferredTotal <= sideBudget || preferredTotal == 0) {
      return PanelWidths(files: preferredFiles, projects: preferredProjects);
    }

    // Narrow windows keep the center usable by proportionally reducing side panels.
    final scale = sideBudget / preferredTotal;
    return PanelWidths(
      files: preferredFiles * scale,
      projects: preferredProjects * scale,
    );
  }
}

class AnimatedSidePanel extends StatelessWidget {
  const AnimatedSidePanel({
    super.key,
    required this.panelKey,
    required this.visible,
    required this.width,
    required this.child,
  });

  final Key panelKey;
  final bool visible;
  final double width;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      key: panelKey,
      duration: panelAnimationDuration,
      curve: Curves.easeOutCubic,
      width: visible ? width : 0,
      child: ClipRect(child: visible ? child : const SizedBox.shrink()),
    );
  }
}

class PanelResizeHandle extends StatefulWidget {
  const PanelResizeHandle({super.key, required this.onDragDelta});

  final ValueChanged<double> onDragDelta;

  @override
  State<PanelResizeHandle> createState() => _PanelResizeHandleState();
}

class _PanelResizeHandleState extends State<PanelResizeHandle> {
  var _hovered = false;
  var _dragging = false;

  @override
  Widget build(BuildContext context) {
    final tokens = OsinaraThemeTokens.of(context);
    final active = _hovered || _dragging;

    // The handle is an overlay hit target, so it must not paint an inactive background or consume layout width.
    return MouseRegion(
      cursor: SystemMouseCursors.resizeColumn,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onHorizontalDragStart: (_) => setState(() => _dragging = true),
        onHorizontalDragEnd: (_) => setState(() => _dragging = false),
        onHorizontalDragCancel: () => setState(() => _dragging = false),
        onHorizontalDragUpdate: (details) =>
            widget.onDragDelta(details.delta.dx),
        child: SizedBox(
          width: resizeHandleWidth,
          child: Center(
            child: AnimatedContainer(
              duration: _resizeHandleAnimationDuration,
              width: active
                  ? resizeHandleVisualWidth * _resizeHandleActiveMultiplier
                  : 0,
              color: active ? tokens.resizeHandleActive : Colors.transparent,
            ),
          ),
        ),
      ),
    );
  }
}

double clampPanelWidth({required double value, required double maximum}) {
  final safeMaximum = math.max(minimumSidePanelWidth, maximum);
  return value.clamp(minimumSidePanelWidth, safeMaximum).toDouble();
}

double maximumResizablePanelWidth({
  required double totalWidth,
  required double otherPanelWidth,
  required double ownMaximum,
  required bool filesVisible,
  required bool projectsVisible,
}) {
  final available = totalWidth - minimumCenterWidth - otherPanelWidth;
  return math.min(ownMaximum, math.max(minimumSidePanelWidth, available));
}

double maximumWorkspaceFilePanelWidth({
  required double totalWidth,
  required bool projectsVisible,
  required double projectPanelWidth,
}) {
  // File panel resizing must reserve space for the optional right Projects panel.
  return maximumResizablePanelWidth(
    totalWidth: totalWidth,
    otherPanelWidth: projectsVisible ? projectPanelWidth : 0.0,
    ownMaximum: maximumFilePanelWidth,
    filesVisible: true,
    projectsVisible: projectsVisible,
  );
}

double maximumWorkspaceProjectPanelWidth({
  required double totalWidth,
  required bool filesVisible,
  required double filePanelWidth,
}) {
  // Projects panel resizing must reserve space for the optional left Files/Git panel.
  return maximumResizablePanelWidth(
    totalWidth: totalWidth,
    otherPanelWidth: filesVisible ? filePanelWidth : 0.0,
    ownMaximum: maximumProjectPanelWidth,
    filesVisible: filesVisible,
    projectsVisible: true,
  );
}
