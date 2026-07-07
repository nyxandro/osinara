/// Project location metadata for local, WSL, and SSH-backed workspaces.
///
/// Key constructs:
/// - [ProjectLocationKind]: stable project source type.
/// - [ProjectLocation]: immutable address of a project folder.
library;

enum ProjectLocationKind { local, wsl, ssh }

final class ProjectLocation {
  const ProjectLocation._({
    required this.kind,
    required this.path,
    this.wslDistro,
    this.sshHost,
  });

  factory ProjectLocation.local({required String path}) {
    _validatePath(path);
    return ProjectLocation._(kind: ProjectLocationKind.local, path: path);
  }

  factory ProjectLocation.wsl({required String distro, required String path}) {
    _validateNonEmpty(
      value: distro,
      fieldName: 'distro',
      errorCode: 'OSI_WSL_DISTRO_MISSING',
      message: 'Не удалось добавить WSL-проект: имя дистрибутива не указано.',
    );
    _validatePath(path);
    return ProjectLocation._(
      kind: ProjectLocationKind.wsl,
      path: path,
      wslDistro: distro,
    );
  }

  factory ProjectLocation.ssh({required String host, required String path}) {
    _validateNonEmpty(
      value: host,
      fieldName: 'host',
      errorCode: 'OSI_SSH_HOST_MISSING',
      message: 'Не удалось добавить SSH-проект: сервер не указан.',
    );
    _validatePath(path);
    return ProjectLocation._(
      kind: ProjectLocationKind.ssh,
      path: path,
      sshHost: host,
    );
  }

  final ProjectLocationKind kind;
  final String path;
  final String? wslDistro;
  final String? sshHost;

  Map<String, Object?> toJson() {
    return {
      'kind': kind.name,
      'path': path,
      'wslDistro': wslDistro,
      'sshHost': sshHost,
    };
  }

  static ProjectLocation fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_PROJECT_LOCATION_INVALID: Не удалось загрузить проект: формат location неверный.',
      );
    }

    final kind = _requiredString(json, 'kind');
    final path = _requiredString(json, 'path');
    return switch (kind) {
      'local' => ProjectLocation.local(path: path),
      'wsl' => ProjectLocation.wsl(
        distro: _requiredString(json, 'wslDistro'),
        path: path,
      ),
      'ssh' => ProjectLocation.ssh(
        host: _requiredString(json, 'sshHost'),
        path: path,
      ),
      _ => throw StateError(
        'OSI_PROJECT_LOCATION_KIND_INVALID: Не удалось загрузить проект: тип location не поддерживается.',
      ),
    };
  }

  String get displayPrefix {
    return switch (kind) {
      ProjectLocationKind.local => 'Local',
      ProjectLocationKind.wsl => 'WSL: $wslDistro',
      ProjectLocationKind.ssh => 'SSH: $sshHost',
    };
  }

  ProjectLocation copyWith({String? path}) {
    final nextPath = path ?? this.path;
    return switch (kind) {
      ProjectLocationKind.local => ProjectLocation.local(path: nextPath),
      ProjectLocationKind.wsl => ProjectLocation.wsl(
        distro: wslDistro!,
        path: nextPath,
      ),
      ProjectLocationKind.ssh => ProjectLocation.ssh(
        host: sshHost!,
        path: nextPath,
      ),
    };
  }
}

String _requiredString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }

  throw StateError(
    'OSI_PROJECT_LOCATION_FIELD_INVALID: Не удалось загрузить проект: поле $key отсутствует или имеет неверный формат.',
  );
}

void _validatePath(String path) {
  _validateNonEmpty(
    value: path,
    fieldName: 'path',
    errorCode: 'OSI_PROJECT_LOCATION_PATH_MISSING',
    message: 'Не удалось добавить проект: путь к папке не указан.',
  );
}

void _validateNonEmpty({
  required String value,
  required String fieldName,
  required String errorCode,
  required String message,
}) {
  if (value.trim().isEmpty) {
    throw ArgumentError.value(value, fieldName, '$errorCode: $message');
  }
}
