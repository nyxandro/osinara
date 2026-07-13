/**
 * Installed Osinara software version.
 *
 * Export:
 * - `CURRENT_SOFTWARE_VERSION`: validated SemVer read directly from package.json.
 */
import packageMetadata from "../../../package.json" with { type: "json" };

import { parseSemver } from "./semver.js";

export const CURRENT_SOFTWARE_VERSION = parseSemver(packageMetadata.version).version;
