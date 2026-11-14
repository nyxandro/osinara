/**
 * Model instructions for installing tools in a sandbox.
 *
 * Export:
 * - `SANDBOX_PACKAGE_RULES`: how a missing tool is installed and which ones the image already has,
 *   the same in every zone with Bash; what persists is said by each zone's own workspace rules.
 *
 * The sandbox runs commands as a root user without a single privilege, so apt cannot unpack a
 * package and `dpkg` fails on any file with a special owner, leaving apt broken for the next
 * install: the model spent turns on it on 04.10, 04.11 and 11.11.2026 (#463). The list names
 * what the sandbox image installs (`Dockerfile`, stage `sandbox-runtime`).
 */
export const SANDBOX_PACKAGE_RULES =
  "Install Python packages and CLIs (yt-dlp and the like) with `pip` and Node packages and CLIs with `npm install -g`. There is no system package manager: commands run without system privileges, so `apt-get` and `dpkg` fail; do not try them or work around them. FFmpeg, pandoc, LibreOffice, poppler-utils, git, curl, jq, ripgrep, zip and build tools are already installed. For a tool that exists only as a system package, download a static build into `$HOME` and run it by its path; if there is none, say that the tool is unavailable here.";
