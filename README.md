# 🎬 omnicinema-mcp

> A master **asset-creation engine** exposed as a local **Model Context Protocol (MCP)** server.
> *(Package and directory: `omnicinema-mcp`, on the external drive.)*

One local server that plans, generates, and assembles production assets end-to-end:

- 🧠 **Multi-agent persona consultation** — a Director of Photography, Graphic Designer, Voice Director, and Music Producer "debate" and compile a rigid prompt strategy *before* anything is generated.
- 🖼️ **Image & design engine** — cinematic photos, transparent logos, vector art, textures, UI mockups. Real offline SVG design + official image APIs (BYO key).
- 🎙️ **Voiceover + full music engine** — narration, SFX, and complete multi-section songs across genres (hip-hop, rap, cinematic orchestral, rock, lo-fi, electronic) via MusicGen APIs **or** deterministic local synthesis (WAV **+** editable MIDI). Reports exact millisecond durations.
- 🎞️ **Video pipeline** — screenplay with shot-to-shot frame continuity → stock/generative b-roll → frame-accurate Remotion montage (now with locked audio tracks) → MP4.
- 🛡️ **Free-tier budget guard** — persistent usage tracking with a user-gate that halts before exhausting a quota.
- 🔌 **Inter-tool REST API** — a localhost, token-authed endpoint so another local tool can request assets programmatically.
- 🔭 **Human-in-the-loop discovery** — scans official catalogs and queues suggestions for explicit approval.

---

## ✋ Scope & ethics (please read)

Everything here uses **official, documented APIs with your own keys**, within each service's Terms of Service. It **does not**, and will not:

- reuse browser session tokens or scrape hosted web sandboxes (e.g. **Seedance / Higgsfield / Suno / Udio** web UIs) to obtain "free" generations or bypass paid tiers;
- auto-integrate or execute arbitrary endpoints/code discovered online.

If a service has no first-party API you can get a key for, it is **out of scope**. The always-available fallbacks — offline **SVG** design and offline **MIDI/WAV** music synthesis — need no keys and no network.

---

## Requirements

- **Node.js ≥ 18.17** (developed on Node 26).
- Optional, for video rendering: the Remotion toolchain (installed on demand) + **ffmpeg**.
- Optional: **ffprobe** (part of ffmpeg) for measuring non-WAV audio durations.
- An external volume if you want everything off your system drive (defaults to `/Volumes/PortableSSD/omnicinema-mcp`).

## Install

```bash
cd /Volumes/PortableSSD/omnicinema-mcp
npm install          # core server (lightweight)
npm run build        # compile to dist/
npm run setup:render # optional: install the Remotion render toolchain
npm install -g .     # optional: expose the `omnicinema-mcp` bin globally
```

---

## Onboarding

### 1. The limits database

The budget guard persists usage to **`data/usage-limits.json`**. You don't create it by hand — it's auto-created on first use and rolls daily/weekly/monthly windows forward automatically. Each provider has a conservative default guard rail; override any of them via env:

```bash
# LIMIT_<PROVIDER>_<DAILY|WEEKLY|MONTHLY>=<integer>
LIMIT_HUGGINGFACE_DAILY=250
LIMIT_REPLICATE_MONTHLY=1000
```

Inspect current usage anytime with the `check_limits` tool. When a generative call would exceed a quota (or nearly exhaust the daily allowance), the tool **halts** and returns a cost breakdown; re-issue with `approveOverBudget: true` to proceed.

### 2. Dependencies

`npm install` gets the core server. `npm run setup:render` adds Remotion for video. The `install_dependencies` tool can detect your OS and install ffmpeg/Blender/Remotion **after explicit consent** (preview with `consent:false`, execute with `consent:true`).

### 3. Environment keys

```bash
cp .env.example .env   # then fill in ONLY the keys you have
```

| Variable | Enables | Get a key |
| --- | --- | --- |
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` / `UNSPLASH_ACCESS_KEY` | Stock video/photos/stills | pexels.com/api · pixabay.com/api/docs · unsplash.com/developers |
| `FREESOUND_API_KEY` | Stock SFX / ambience | freesound.org/apiv2/apply |
| `HUGGINGFACE_API_TOKEN` + `HF_IMAGE_MODEL` / `HF_TTS_MODEL` / `HF_MUSIC_MODEL` / `HF_VIDEO_MODEL` | HF Inference image / TTS / music / video | huggingface.co/settings/tokens |
| `REPLICATE_API_TOKEN` + `REPLICATE_IMAGE_MODEL` / `REPLICATE_MUSIC_MODEL` / `REPLICATE_VIDEO_MODEL` | Replicate image / music / video | replicate.com |
| `FAL_API_KEY` + `FAL_VIDEO_MODEL` | fal.ai video | fal.ai |
| `ANTHROPIC_API_KEY` | Optional screenplay enrichment | console.anthropic.com |

Model ids are **yours to choose**, so the tool tracks new models (FLUX, Kokoro, MusicGen, …) without code changes. With **no keys at all**, the engines still produce real offline output (SVG designs, synthesized music, placeholder footage).

### 4. The cross-tool programmatic API

Start the localhost REST server so another local tool can drive this engine:

```
ipc_start  →  { url: "http://127.0.0.1:8787", token: "…" }
```

Then, from any local process:

```bash
TOKEN=…   # from ipc_start (also stored in data/ipc-token.txt)
curl -s localhost:8787/schema -H "Authorization: Bearer $TOKEN"          # metadata contract
curl -s localhost:8787/limits -H "Authorization: Bearer $TOKEN"          # usage
curl -s localhost:8787/assets/image -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"assetKind":"logo","subject":"Nova Labs","style":"vibrant"}'
```

**Security:** bound to `127.0.0.1`, bearer-token required (auto-generated to `data/ipc-token.txt`, mode 0600), no CORS, no code execution. Over-budget requests return **HTTP 402** with a breakdown; retry with `"approveOverBudget": true`.

---

## Register as an MCP server

**Claude Desktop** (`claude_desktop_config.json`) — see [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json):

```json
{
  "mcpServers": {
    "omnicinema": {
      "command": "node",
      "args": ["/Volumes/PortableSSD/omnicinema-mcp/dist/index.js"],
      "env": { "CINEMA_ROOT": "/Volumes/PortableSSD/omnicinema-mcp" }
    }
  }
}
```

**Claude Code:** `claude mcp add omnicinema -- node /Volumes/PortableSSD/omnicinema-mcp/dist/index.js`

## Tools (15)

| Tool | Purpose |
| --- | --- |
| `consult_personas` | Run the persona debate and return the compiled brief (no generation). |
| `generate_image` | Cinematic photo / logo / vector art / texture / UI mockup. |
| `generate_voiceover` | Spoken narration with precise ms duration. |
| `generate_soundtrack` | Full multi-section song in any genre (WAV + MIDI). |
| `generate_sfx` | Sound effect / ambience. |
| `check_limits` | Per-provider free-tier usage. |
| `run_cinema_pipeline` | Screenplay → assets → montage → MP4 (optional `narration`, `soundtrack`). |
| `compile_montage` | Finish an interactive video project. |
| `install_dependencies` | Consent-gated OS dependency installer. |
| `list_providers` | Curated registry + configured status. |
| `discover_providers` / `approve_suggestion` | Review-only discovery + explicit promotion. |
| `ipc_start` / `ipc_status` / `ipc_stop` | Control the inter-tool REST server. |

## Personas

Each asset kind has a **lead** persona (and sometimes advisors). The consultation compiles a positive prompt, a negative prompt, and technical parameters, with a transcript of the debate.

| Persona | Leads | Dictates |
| --- | --- | --- |
| Director of Photography | cinematic-photo, texture | lens, volumetric lighting, shadows, angle, depth of field |
| Graphic Designer / Vector Artist | logo, vector-art, ui-mockup | flat color, padding, SVG-clean geometry, palette |
| Voice Director & Audio Engineer | voiceover, sfx (advises soundtrack) | pacing/WPM, inflection, ducking, frequency treatment |
| Music Producer & Beats Engineer | soundtrack | BPM, key, verse/chorus structure, instrumentation |

## Audio & music engine

`generate_soundtrack` composes a full arrangement (intro/verse/chorus/…): the Music Producer plans **BPM, key, structure, and instrumentation** per genre, then the engine either calls a MusicGen/AudioCraft API (`generative:true` + a configured key) or renders it locally to **WAV + editable MIDI** with deterministic synthesis (bass, chords, drums, arp). Every audio asset returns an exact **millisecond duration**, so `run_cinema_pipeline`'s `narration`/`soundtrack` options lock audio to the video timeline frame-accurately.

## Output layout

```
assets/                      # standalone image/audio assets (<subject>_<kind>.<ext>, plus .mid)
projects/<id>/               # a video project: screenplay, timeline.json, clips, audio, manifest
output/<id>.mp4              # rendered video
data/usage-limits.json       # budget guard database  (gitignored)
data/review-queue.json       # discovery suggestions   (gitignored)
data/ipc-token.txt           # IPC bearer token 0600   (gitignored)
```

## Test / eval

```bash
npm run eval   # (alias: npm test) — 29 tests, fully offline (no network, no keys)
```

Covers persona lead-selection & determinism, budget rollover/gate, music-synthesis duration accuracy + valid WAV/MIDI, offline SVG design, the IPC auth/schema/generate contract, discovery safety gates, and the video pipeline (continuity, timeline tiling, audio lock).

## Project structure

```
src/
  server.ts             # MCP server + 15 tools
  personas/             # DoP, designer, voice director, music producer + consultation
  pipeline/             # image-engine, audio-engine, runCinemaPipeline, script-engine
  audio/                # wav, theory, synth, midi
  assets/               # stock clients + offline vector/SVG designer
  providers/            # image/audio/video providers + registry
  limits/               # budget guard
  api/                  # localhost IPC REST server
  discovery/            # review-only provider discovery
  montage/              # timeline builder/validator + Remotion render
remotion/               # React/TS composition (video + audio tracks)
test/                   # 6 offline test suites
```

> **Remotion licensing:** free for individuals and small teams; a company license applies above a threshold — see <https://remotion.dev/license>.

## Contributing & License

[MIT](LICENSE). Downloaded/generated assets keep **their own** licenses (see each project's `attributions.txt`). Please keep the scope boundary intact: official APIs + user-owned keys only; no scraping, token reuse, or auto-integration of untrusted code.
