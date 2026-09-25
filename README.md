# 🎬 omnicinema-mcp

> A local **asset-creation engine** exposed as a **Model Context Protocol (MCP)** server.
> Repository: <https://github.com/joeshwoa/omnicinema-mcp>

One local server that plans, designs, generates and edits production assets:

- 🧠 **Persona consultation** — a Director of Photography, Graphic Designer, Voice Director and Music Producer compile a prompt strategy (positive/negative prompt, palette, lens, BPM/key/structure, pacing) *before* anything is generated.
- 🖼️ **Offline design engine** — logos (emblem, monogram, wordmark, horizontal lockup; with reversed and icon variants), flat vector illustrations, and device-framed UI mockups as clean SVG (+ PNG), with no key and no network. Photos/textures via image APIs with your own key.
- 🎙️ **Audio** — narration via your system's TTS offline (or an HF TTS model), composed + synthesized soundtracks in seven genres (stereo WAV + editable multi-track MIDI), and procedural sound effects.
- 🎞️ **Video pipeline** — one-line idea → coherent multi-scene screenplay with shot-to-shot continuity → stock footage (Pexels / Pixabay / Unsplash) or an offline storyboard animatic → a frame-accurate edit with dissolves, Ken Burns motion, captions, a ducked soundtrack → MP4 via Remotion or ffmpeg.
- 🛡️ **Budget guard** — persistent free-tier tracking; generative calls halt with a cost breakdown until the user approves.
- 🔌 **Local REST API** — token-authed, 127.0.0.1-only, so other local tools can request assets.
- 🔭 **Review-only discovery** — finds candidate providers on public catalogs and queues them for a human; never integrates anything by itself.

---

## What you get without any keys (honest version)

| Capability | Offline result | Quality notes |
| --- | --- | --- |
| Logo / vector art / UI mockup | Real SVG + PNG designs | Deterministic, brief-driven, professional-looking flat design. Text uses system fonts (Poppins → Helvetica → DejaVu fallbacks), so letterforms vary slightly by machine; convert text to outlines in a vector editor for final brand use. |
| Cinematic photo / texture | A clearly **labelled placeholder** | Not a photo. Needs an image API (`HF_IMAGE_MODEL` / `REPLICATE_IMAGE_MODEL`) + `generative:true`. |
| Voiceover | Real speech via `say` (macOS), `pico2wave`, ffmpeg's built-in `flite`, or `espeak-ng` | Intelligible (verified by transcribing it with Whisper) but clearly synthetic. With no TTS engine installed you get a timing tone that the tool labels **NOT SPEECH**. For a natural voice use `HF_TTS_MODEL` + `generative:true`. |
| Soundtrack | Composed & synthesized stereo WAV + multi-track MIDI | Real arrangement (chords, bass, drums, melody, section dynamics), mastered to about −14 LUFS with no clipping. It is a synth demo, not a studio recording; the MIDI is there to re-voice in a DAW. |
| Sound effects | 13 procedural recipes (whoosh, rain, thunder, wind, ocean, impact, riser, click, ding, beep, fire, footsteps, heartbeat) | Good for placeholders/transitions; real recordings via Freesound with a key. |
| Video | An **animatic**: storyboard frames per shot with camera-matched motion, title card, captions, music, narration → MP4 | Real footage needs a stock key (free) or a generative video model (paid/quota). |

## Scope & ethics

Everything uses **official, documented APIs with your own keys**, within each service's Terms. It does **not** reuse browser sessions, scrape web UIs (Seedance, Higgsfield, Suno, Udio…), or auto-integrate code found online. If a service has no first-party API you can get a key for, it is out of scope.

---

## Requirements

- **Node.js ≥ 18.17**.
- Recommended system tools (all optional, each unlocks something):
  - **ffmpeg** — renders MP4 without Remotion, measures media, normalizes TTS loudness, rasterizes SVG (if built with librsvg) and provides the `flite` voice.
  - **rsvg-convert** (`librsvg2-bin` / `brew install librsvg`) — PNG export of every SVG.
  - **espeak-ng** (Linux) — offline narration if neither `say` nor ffmpeg-flite is available.
  - **Remotion toolchain** — `npm run setup:render` (downloads a headless Chrome on first render).

## Install

```bash
git clone https://github.com/joeshwoa/omnicinema-mcp.git
cd omnicinema-mcp
npm install            # core server (installs optional Remotion too unless you pass --omit=optional)
npm run build          # compile to dist/
npm run setup:render   # optional: install the pinned Remotion render toolchain
```

All runtime output lives under `CINEMA_ROOT` (default: the repo folder). Point it at an external drive to keep caches and renders off your system disk.

## Register as an MCP server

**Claude Desktop** — see [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json):

```json
{
  "mcpServers": {
    "omnicinema": {
      "command": "node",
      "args": ["/absolute/path/to/omnicinema-mcp/dist/index.js"],
      "env": { "CINEMA_ROOT": "/absolute/path/to/omnicinema-mcp" }
    }
  }
}
```

**Claude Code:** `claude mcp add omnicinema -- node /absolute/path/to/omnicinema-mcp/dist/index.js`

## Keys (all optional)

```bash
cp .env.example .env   # fill in ONLY the keys you have
```

| Variable | Enables | Network / cost |
| --- | --- | --- |
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` / `UNSPLASH_ACCESS_KEY` | Stock video/photos in `run_cinema_pipeline` | Free APIs; used automatically when set (`stock:false` to stay offline) |
| `FREESOUND_API_KEY` | Real SFX recordings (`generate_sfx` + `generative:true`) | Free API |
| `HUGGINGFACE_API_TOKEN` + `HF_IMAGE_MODEL` / `HF_TTS_MODEL` / `HF_MUSIC_MODEL` / `HF_VIDEO_MODEL` | Photos, natural voice, MusicGen, video | Quota / paid, only with `generative:true` |
| `REPLICATE_API_TOKEN` + `REPLICATE_IMAGE_MODEL` / `REPLICATE_MUSIC_MODEL` / `REPLICATE_VIDEO_MODEL` | Same, via Replicate | **Paid**, only with `generative:true` |
| `FAL_API_KEY` + `FAL_VIDEO_MODEL` | Video via fal.ai | **Paid**, only with `generative:true` |
| `ANTHROPIC_API_KEY` | Optional screenplay prose polish (1 call per run; `enrich:false` to skip) | Paid |

Model ids are yours to choose, so new models work without code changes. Behaviour toggles: `CINEMA_TTS=off|say|pico2wave|flite|espeak-ng`, `CINEMA_DISABLE_REMOTION=1` (force the ffmpeg renderer), `CINEMA_DISABLE_RASTER=1`, `LIMIT_<PROVIDER>_<DAILY|WEEKLY|MONTHLY>=n`.

## Tools (15)

Every tool's text output ends with the **files it wrote** and **next steps**; a JSON block follows for programs.

| Tool | Use it to… | Network / money |
| --- | --- | --- |
| `run_cinema_pipeline` | Turn an idea into a video. **Start with `dry_run:true`** to get the screenplay, shot list, providers and a cost estimate instantly. | Stock APIs if keys set; `generative:true` spends quota |
| `compile_montage` | Finish an `interactive_montage` project or re-cut any project (reorder via `montage-order.json`, swap clip files). | None |
| `generate_image` | Logo, vector art, UI mockup (offline SVG+PNG), photo/texture (API). | Only photo/texture with `generative:true` |
| `generate_voiceover` | Speak a script (offline TTS or HF TTS). | Only with `generative:true` |
| `generate_soundtrack` | Compose music in a genre, optionally to a length (`durationSeconds`). | Only with `generative:true` |
| `generate_sfx` | Sound effect / ambience. | Freesound with `generative:true` |
| `consult_personas` | Preview the compiled brief without generating. | None |
| `check_limits` | See free-tier usage per provider. | None |
| `list_providers` | See which providers are configured. | None |
| `install_dependencies` | Preview (`consent:false`) or run (`consent:true`) ffmpeg/Blender/Remotion installs. | Installs only with consent |
| `discover_providers` / `approve_suggestion` | Queue candidate providers for review / catalogue one (added disabled). | Public catalog search |
| `ipc_start` / `ipc_status` / `ipc_stop` | Local REST API for other tools. | Localhost only |

### Typical flow

1. `run_cinema_pipeline { prompt, dry_run: true }` → show the user the shot list and spend (usually "Nothing").
2. `run_cinema_pipeline { prompt, narration, soundtrack: true, musicStyle }` → MP4 path + screenplay + timeline.
3. Optional: edit `montage-order.json` or replace clip files in the project folder → `compile_montage { projectId }`.

## How the video is built

- **Screenplay:** the idea is parsed into subject / action / setting / story element; the film gets one lighting look (e.g. dusk → storm night → grey dawn), scenes follow an arc (setup → inciting → climax → resolution), shots follow film grammar (establishing → medium → close). Each shot's opening frame is identical to the previous shot's closing frame, camera moves are derived from the framing change, and screen direction is held. `screenplay.md` is human-readable.
- **Footage:** per shot, the configured stock providers are searched with short, specific queries; hits are ranked by orientation, duration and resolution, never reused, downloaded, and licensed in `attributions.txt`. Unfilled shots get storyboard frames.
- **Edit:** hard cuts inside a scene, true crossfades between scenes, Ken Burns motion matching the camera move, title card, captions from the narration, soundtrack fitted to the cut and ducked under the voice, fade out. Rendered by Remotion (`remotion/compositions/CinemaTimeline.tsx`) or, without it, by an equivalent ffmpeg filter graph.

## Output layout

```
assets/                      # standalone assets (<subject>_<kind>.svg/.png/.wav/.mid)
projects/<id>/               # screenplay.{md,json}, timeline.json, clips, audio, attributions.txt, manifest.json
output/<id>.mp4              # rendered video
data/usage-limits.json       # budget guard database   (gitignored)
data/review-queue.json       # discovery queue         (gitignored)
data/ipc-token.txt           # IPC bearer token, 0600  (gitignored)
```

## Tests

```bash
npm test     # 76 tests, offline, against a throwaway CINEMA_ROOT (your data/ is never touched)
```

Covers the designer (valid, deterministic SVG; librsvg render when installed), stock clients against a mocked `fetch` (no key → no request), screenplay quality rules, timeline/editorial rules, music/MIDI/SFX checks (loudness, clipping, structure), the MCP tool surface, and an offline end-to-end run that renders a real MP4 when ffmpeg or Remotion is present (skips cleanly otherwise). `OMNICINEMA_TEST_REMOTION=1 npm test` exercises Remotion instead of ffmpeg in that test.

## Known limits

- Offline photos are placeholders; offline video is an animatic, not footage.
- Offline voices are robotic; offline music is synthesized (no sampled instruments, no vocals).
- Logo/UI text depends on installed fonts; there is no font embedding or outlining.
- The screenplay engine is template-based (deterministic). `ANTHROPIC_API_KEY` adds an optional prose rewrite.
- Generative providers (Replicate/fal/HF) and stock APIs were unit-tested against mocked responses; they were not exercised against the live services in this release.
- Remotion needs its headless Chrome download on first render; if Remotion fails, the pipeline falls back to ffmpeg.

> **Remotion licensing:** free for individuals and small teams; a company license applies above a threshold — see <https://remotion.dev/license>.

## License

[MIT](LICENSE). Downloaded/generated assets keep **their own** licenses (see each project's `attributions.txt`). Please keep the scope boundary intact: official APIs + user-owned keys only; no scraping, token reuse, or auto-integration of untrusted code.
