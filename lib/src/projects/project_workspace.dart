/// Project identity and filesystem location used by the workspace shell.
///
/// Key constructs:
/// - [ProjectWorkspace]: immutable project record shown in the Projects panel.
library;

import 'project_location.dart';

final class ProjectWorkspace {
  const ProjectWorkspace._({
    required this.id,
    required this.name,
    required this.location,
    required this.iconName,
  });

  factory ProjectWorkspace.local({
    required String id,
    required String name,
    required String path,
    String iconName = defaultProjectIconName,
  }) {
    return ProjectWorkspace._(
      id: _validateRequired(id, 'id', 'OSI_PROJECT_ID_MISSING'),
      name: _validateRequired(name, 'name', 'OSI_PROJECT_NAME_MISSING'),
      location: ProjectLocation.local(path: path),
      iconName: _validateRequired(
        iconName,
        'iconName',
        'OSI_PROJECT_ICON_MISSING',
      ),
    );
  }

  factory ProjectWorkspace.wsl({
    required String id,
    required String name,
    required String distro,
    required String path,
    String iconName = defaultProjectIconName,
  }) {
    return ProjectWorkspace._(
      id: _validateRequired(id, 'id', 'OSI_PROJECT_ID_MISSING'),
      name: _validateRequired(name, 'name', 'OSI_PROJECT_NAME_MISSING'),
      location: ProjectLocation.wsl(distro: distro, path: path),
      iconName: _validateRequired(
        iconName,
        'iconName',
        'OSI_PROJECT_ICON_MISSING',
      ),
    );
  }

  factory ProjectWorkspace.ssh({
    required String id,
    required String name,
    required String host,
    required String path,
    String iconName = defaultProjectIconName,
  }) {
    return ProjectWorkspace._(
      id: _validateRequired(id, 'id', 'OSI_PROJECT_ID_MISSING'),
      name: _validateRequired(name, 'name', 'OSI_PROJECT_NAME_MISSING'),
      location: ProjectLocation.ssh(host: host, path: path),
      iconName: _validateRequired(
        iconName,
        'iconName',
        'OSI_PROJECT_ICON_MISSING',
      ),
    );
  }

  final String id;
  final String name;
  final ProjectLocation location;
  final String iconName;

  String get path => location.path;

  Map<String, Object?> toJson() {
    return {
      'id': id,
      'name': name,
      'location': location.toJson(),
      'iconName': iconName,
    };
  }

  static ProjectWorkspace fromJson(Object? json) {
    if (json is! Map<String, Object?>) {
      throw StateError(
        'OSI_PROJECT_INVALID: Не удалось загрузить проект: формат записи проекта неверный.',
      );
    }

    return ProjectWorkspace._(
      id: _requiredString(json, 'id', 'OSI_PROJECT_ID_INVALID'),
      name: _requiredString(json, 'name', 'OSI_PROJECT_NAME_INVALID'),
      location: ProjectLocation.fromJson(json['location']),
      iconName: _requiredString(json, 'iconName', 'OSI_PROJECT_ICON_INVALID'),
    );
  }

  ProjectWorkspace copyWith({String? name, String? path, String? iconName}) {
    return ProjectWorkspace._(
      id: id,
      name: name == null
          ? this.name
          : _validateRequired(name, 'name', 'OSI_PROJECT_NAME_MISSING'),
      location: path == null ? location : location.copyWith(path: path),
      iconName: iconName == null
          ? this.iconName
          : _validateRequired(iconName, 'iconName', 'OSI_PROJECT_ICON_MISSING'),
    );
  }
}

const defaultProjectIconName = 'folder';

String _validateRequired(String value, String fieldName, String errorCode) {
  if (value.trim().isEmpty) {
    throw ArgumentError.value(
      value,
      fieldName,
      '$errorCode: Не удалось сохранить проект: обязательное поле не заполнено.',
    );
  }

  return value;
}

String _requiredString(
  Map<String, Object?> json,
  String key,
  String errorCode,
) {
  final value = json[key];
  if (value is String && value.trim().isNotEmpty) {
    return value;
  }

  throw StateError(
    '$errorCode: Не удалось загрузить проект: поле $key отсутствует или имеет неверный формат.',
  );
}
