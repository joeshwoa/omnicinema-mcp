# 🎬 autonomous-cinema-mcp

A local **Model Context Protocol (MCP)** server that orchestrates an AI video‑production pipeline end‑to‑end:

1. **Script & Continuity Engine** — generates a multi‑scene screenplay where every shot's opening frame is chained to exactly match the previous shot's closing frame.
2. **Local Dependency Installer** — detects your OS and installs the render toolchain (Remotion, ffmpeg, Blender) *after explicit consent*, mapping caches to your external volume.
3. **Asset Acquisition** — fetches matching b‑roll from **official** stock APIs (Pexels, Pixabay, Unsplash) and, optionally, from **bring‑your‑own‑key** generative video providers (Replicate, fal.ai, Hugging Face).
4. **Auto‑Montage Sequencer** — assembles a frame‑accurate [Remotion](https://remotion.dev) timeline (React/TypeScript) and renders an MP4.
5. **Provider Discovery** — scans official public catalogs (Hugging Face Hub, GitHub) for new tools and files them for **human review** — never auto‑integrating anything.

---

## ✋ Scope & ethics (please read)

This project is deliberately built to stay on the right side of other services' Terms of Service. It **does**:

- Use **official, documented APIs** with **your own API keys**, within each service's rate limits and terms.
- Ship a **human‑in‑the‑loop** discovery flow that only *suggests* new providers.
- Ask for **explicit consent** before installing anything on your machine.

It intentionally **does not**, and will not:

- Reuse your browser session tokens or cookies to drive third‑party web UIs.
- Scrape generative web apps (e.g. Seedance / Higgsfield web sandboxes) or bypass paid tiers / rate limits to obtain "free" generations.
- Auto‑integrate or auto‑execute arbitrary endpoints or code discovered online.

If a service offers no first‑party API you can get a key for, it is **out of scope** here. Want generative video? Bring a key for a provider that offers a real API (Replicate, fal.ai, Hugging Face, or your own endpoint) — see [Generative providers](#generative-providers-opt-in).

---

## Requirements

- **Node.js ≥ 18.17** (developed on Node 26).
- Optional, for rendering video: the Remotion toolchain (installed on demand) + a Chromium download that Remotion manages, and **ffmpeg**.
- Optional: **Blender** for 3D/asset workflows.
- An external volume if you want everything off your system drive (this repo defaults to `/Volumes/PortableSSD/autonomous-cinema-mcp`).

## Install

```bash
# 1. Clone onto your external volume (recommended)
cd /Volumes/PortableSSD
git clone <your-fork-url> autonomous-cinema-mcp
cd autonomous-cinema-mcp

# 2. Install the core server (lightweight) and build
npm install
npm run build

# 3. (Optional) install the render toolchain when you want to render video
npm run setup:render
```

Global install (exposes the `autonomous-cinema-mcp` bin):

```bash
npm install -g .
```

## Configure

```bash
cp .env.example .env
# then edit .env and add ONLY the keys you have
```

| Variable | Purpose | Get a key |
| --- | --- | --- |
| `PEXELS_API_KEY` | Stock video/photos | <https://www.pexels.com/api/> |
| `PIXABAY_API_KEY` | Stock video/images | <https://pixabay.com/api/docs/> |
| `UNSPLASH_ACCESS_KEY` | Stock stills (attribution required) | <https://unsplash.com/developers> |
| `REPLICATE_API_TOKEN` + `REPLICATE_VIDEO_MODEL` | Generative video | <https://replicate.com> |
| `FAL_API_KEY` + `FAL_VIDEO_MODEL` | Generative video | <https://fal.ai> |
| `HUGGINGFACE_API_TOKEN` + `HF_VIDEO_MODEL` | Generative video | <https://huggingface.co> |
| `ANTHROPIC_API_KEY` | Optional screenplay enrichment | <https://console.anthropic.com> |

Everything the pipeline writes (screenplays, downloads, timelines, renders) stays under `CINEMA_ROOT` (defaults to the repo directory).

## Use it as an MCP server

Register the server in your MCP client. For **Claude Desktop**, edit
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) — see
[`examples/claude_desktop_config.json`](examples/claude_desktop_config.json):

```json
{
  "mcpServers": {
    "autonomous-cinema": {
      "command": "node",
      "args": ["/Volumes/PortableSSD/autonomous-cinema-mcp/dist/index.js"],
      "env": { "CINEMA_ROOT": "/Volumes/PortableSSD/autonomous-cinema-mcp" }
    }
  }
}
```

For **Claude Code**:

```bash
claude mcp add autonomous-cinema -- node /Volumes/PortableSSD/autonomous-cinema-mcp/dist/index.js
```

Restart the client; the tools below become available.

## Tools

### `run_cinema_pipeline`
The main entry point.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string | — | The video concept. |
| `workflow_mode` | `fully_automated` \| `interactive_montage` | `fully_automated` | Interactive pauses after downloads so you can arrange clips before compiling. |
| `sceneCount` | int 1–12 | derived | Number of scenes. |
| `shotsPerScene` | int 1–6 | 2 | Shots per scene. |
| `shotDurationSeconds` | number 1–30 | 4 | Seconds per shot. |
| `fps` / `width` / `height` | int | 30 / 1920 / 1080 | Output format. |
| `style` | string | `modern cinematic` | e.g. `noir`, `neon cyberpunk`. |
| `prefer` | `video` \| `image` | `video` | Motion b‑roll vs stills. |
| `generative` | boolean | `false` | Opt in to generative providers (needs a configured key). |
| `render` | boolean | `true`\* | Render now if Remotion is installed. |

\* Only in `fully_automated` mode.

### Other tools
- **`compile_montage`** `{ projectId, render? }` — finish an interactive project (honors an optional `montage-order.json` you drop into the project folder).
- **`install_dependencies`** `{ consent, targets? }` — preview (`consent:false`) or run (`consent:true`) the dependency install.
- **`list_providers`** — show the curated registry and which providers are configured.
- **`discover_providers`** `{ query }` — append candidate tools to `discovery-suggestions.json` for review (activates nothing).
- **`approve_suggestion`** `{ suggestionId, approve }` — explicitly promote a reviewed suggestion into the registry (added disabled + unimplemented).

## Workflow modes

- **`fully_automated`** — screenplay → assets → timeline → validate → render, in one call.
- **`interactive_montage`** — stops after asset acquisition. Open the project folder, rearrange/replace clips, optionally write `montage-order.json` (an array of clip filenames in the order you want), then call `compile_montage`.

## Generative providers (opt‑in)

Set `generative: true` **and** configure one provider (token + model id). The pipeline tries providers in the registry's order, per shot, and falls back to stock/placeholder if generation fails. Model ids are **yours to choose** so the tool stays current without code changes.

## Output layout

```
projects/<timestamp>_<slug>/
  screenplay.json      # structured screenplay + continuity frames
  screenplay.md        # human‑readable screenplay
  timeline.json        # frame‑accurate montage (Remotion props)
  attributions.txt     # licenses + attributions for every clip
  manifest.json        # the pipeline report
  <shot-id>.{mp4,jpg,svg}   # one asset per shot
output/<projectId>.mp4  # rendered video (if rendered)
```

## Rendering

Rendering shells out to the Remotion CLI (kept as an **optional dependency** so the core server stays light). Install it with `npm run setup:render`. The composition is [`remotion/compositions/CinemaTimeline.tsx`](remotion/compositions/CinemaTimeline.tsx); it's data‑driven by `timeline.json` via `calculateMetadata`.

> **Remotion licensing:** Remotion is free for individuals and small teams but requires a company license above a threshold. Review <https://remotion.dev/license> before commercial use.

## Test / eval

```bash
npm run eval   # (alias: npm test)
```

The suite runs **offline** (placeholders, no network) and asserts:
- every shot opens on the previous shot's closing frame (continuity),
- generation is deterministic per prompt,
- the timeline tiles with **no gaps/overlaps** and **no missing assets**, and the validator catches an injected gap,
- `interactive_montage` pauses without rendering.

## Project structure

```
src/
  server.ts            # MCP server + tool schemas
  index.ts             # bin entry (stdio)
  config.ts            # paths pinned to CINEMA_ROOT (the external volume)
  pipeline/            # script-engine + orchestrator
  assets/              # stock clients (pexels/pixabay/unsplash) + placeholder
  providers/           # generative providers + registry
  discovery/           # review-only provider discovery
  installer/           # consent-gated system installer
  montage/             # timeline builder/validator + Remotion render
remotion/              # React/TS composition (rendered via Remotion CLI)
skills/system-installer-skill/  # setup skill
test/                  # eval suite
tools-registry.json    # curated provider routing config
```

## Contributing

Issues and PRs welcome. Please keep the [scope & ethics](#-scope--ethics-please-read) boundary intact: official APIs and user‑owned keys only; no scraping, token reuse, or auto‑integration of untrusted code.

## License

[MIT](LICENSE). Downloaded assets remain under **their own** licenses — see each project's `attributions.txt`.
