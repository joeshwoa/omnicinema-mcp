---
name: system-installer-skill
description: Detect the host OS and install the local multimedia dependencies (Remotion packages, ffmpeg, Blender) that autonomous-cinema-mcp needs. Always asks for explicit permission before running any install command, and points caches at the external volume. Use when setting up the pipeline on a new machine or when a render fails because Remotion/ffmpeg/Blender is missing.
---

# System Installer Skill

Sets up the local environment for `autonomous-cinema-mcp`. This skill is the
human-facing counterpart to the server's `install_dependencies` tool.

## Behavior

1. **Inspect the host OS.** Determine platform (`macOS` / `Linux` / `Windows`),
   architecture, and which of `node`, `npm`, `git`, `ffmpeg`, `blender` and which
   package managers (`brew`, `apt-get`, `dnf`, `winget`, `choco`) are present.

2. **Ask for permission — always.** Before running anything, present exactly:

   > This tool needs to install local video processing dependencies (Remotion CLI,
   > Node.js packages, and Blender). Do you grant permission to run the required
   > installation commands? [y/N]

   Show the exact commands that would run for the detected OS. Do not proceed on
   anything other than an affirmative `y`.

3. **On consent, install.** Run the platform-appropriate commands:
   - **macOS:** `brew install ffmpeg`, `brew install --cask blender`
   - **Linux:** `sudo apt-get install -y ffmpeg blender` (or `dnf`)
   - **Windows:** `winget install -e --id Gyan.FFmpeg`, `winget install -e --id BlenderFoundation.Blender`
   - **All:** `npm install --include=optional remotion react react-dom @remotion/cli @remotion/bundler @remotion/renderer`

4. **Map caches to the external volume.** Write an `.npmrc` whose `cache=` points
   under `CINEMA_ROOT/.cache/npm`, and create `CINEMA_ROOT/.cache/remotion`, so
   nothing bloats the system drive.

## How to run it

- **Via the MCP tool (preferred):** call `install_dependencies` with `consent:false`
  first to preview the plan and prompt, then `consent:true` to execute.
- **Manually:** `npm run setup:render` installs just the Remotion render toolchain.

## Safety

- Never installs silently; consent is required each time.
- Only installs well-known packages from official sources / package managers.
- `sudo` steps are surfaced explicitly in the plan and require the user's shell to
  grant elevation.
