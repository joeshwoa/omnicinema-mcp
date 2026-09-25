# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-25

### Fixed
- **Fresh clones did not build.** A bare `assets/` rule in `.gitignore` also matched
  `src/assets/`, so the SVG designer and stock clients were never committed. The rule is
  anchored to the repo root and the modules are restored (`src/assets/`).
- **Every Remotion render produced the 3-second demo placeholder**: the composition reads
  `props.timeline` but was given the raw timeline. Renders now use the real timeline.
- `npm run setup:render` rewrote `package.json`; it now installs the pinned optional deps.
- Generative video in `run_cinema_pipeline` bypassed the budget guard; it is now gated.
- The test suite deleted the real `data/usage-limits.json`; tests now run in a temp root.
- Discovery failed when `data/` did not exist; `projectId` is validated (no path traversal).

### Added
- Offline SVG designer: logos (emblem / monogram / wordmark / horizontal, keyword-matched
  marks, reversed + icon variants), layered vector art (7 templates), device-framed UI
  mockups (dashboard, landing, sign-in, store, chat, mobile), labelled photo placeholders,
  storyboard frames; PNG export when `rsvg-convert` or ffmpeg+librsvg is available.
- Stock clients for Pexels, Pixabay and Unsplash (official APIs, license + attribution,
  Unsplash download tracking) and a stock manager with ranking, dedupe and budget gating.
- `run_cinema_pipeline` `dry_run` (plan + cost estimate, no side effects), `stock`,
  `captions`, `approveOverBudget`; `generate_soundtrack` `durationSeconds`.
- ffmpeg render fallback when Remotion is not installed.
- Offline narration via system TTS (say / pico2wave / ffmpeg flite / espeak-ng), normalized
  to -16 LUFS; 13 procedural SFX recipes.
- 47 new tests (76 total), including an offline end-to-end render.

### Changed
- Screenplay engine rewritten: parsed subject/action/setting, one lighting look per film,
  story arc, film-grammar shot progression, camera moves derived from framing changes,
  180° rule, real INT/EXT locations, short stock queries.
- Music engine: composed score (voice-led chords, genre bass/drums, melody, section
  dynamics) rendered in stereo with genre instruments, reverb, sidechain, and mastering to
  about -14 LUFS; Type-1 multi-track MIDI of the same score; arrangements fit a target length.
- Edit: hard cuts inside scenes, true crossfades between scenes, Ken Burns motion, title
  card, captions, soundtrack trimmed/faded/ducked under narration, fade out.
- Tool descriptions say when to use each tool and which flags use the network or money;
  every result ends with output files and next steps.

## [0.2.0] — 2026-07-07

Expanded the initial local video pipeline into a master asset-creation engine
(`omnicinema-mcp`). The video pipeline is retained and enhanced.

### Added
- **Multi-agent persona consultation** (`src/personas/`): Director of Photography,
  Graphic Designer, Voice Director, and Music Producer. Deterministic "debate" →
  compiled `PromptBrief` (positive/negative prompt + technical params + transcript).
  Tool: `consult_personas`.
- **Image & design engine** (`src/pipeline/image-engine.ts`): cinematic photos,
  transparent logos, vector art, textures, UI mockups. Real offline **SVG** design +
  official image APIs (HF Inference / Replicate, BYO key). Tool: `generate_image`.
- **Voiceover + full music engine** (`src/pipeline/audio-engine.ts`): narration, SFX,
  and complete multi-section songs across genres (hip-hop, rap, cinematic orchestral,
  rock, lo-fi, electronic). Generative via MusicGen/TTS APIs **or** deterministic local
  synthesis to **WAV + editable MIDI**. Exact millisecond durations. Tools:
  `generate_voiceover`, `generate_soundtrack`, `generate_sfx`.
- **Free-tier budget guard** (`src/limits/limit-manager.ts`): persistent
  `data/usage-limits.json` with daily/weekly/monthly rollover and a halt-and-approve
  user gate. Tool: `check_limits`; env overrides `LIMIT_<PROVIDER>_<PERIOD>`.
- **Inter-tool IPC REST API** (`src/api/ipc-protocol.ts`): localhost-only, bearer-token
  auth, `/schema` `/limits` `/consult` `/assets/*`; over-budget → HTTP 402. Tools:
  `ipc_start`, `ipc_status`, `ipc_stop`.
- **Audio locked to video**: `run_cinema_pipeline` gains `narration` / `soundtrack` /
  `musicStyle`; Remotion composition plays attached audio tracks.
- Discovery now writes to `data/review-queue.json` with distinct console alerts.
- 5 new offline test suites (29 tests total).

### Changed
- Renamed the package, CLI bin, and project directory to `omnicinema-mcp` (v0.2.0).

## [0.1.0] — 2026-07-07

### Added
- **MCP server** exposing six tools: `run_cinema_pipeline`, `compile_montage`,
  `install_dependencies`, `list_providers`, `discover_providers`,
  `approve_suggestion`.
- **Script & Continuity Engine** — deterministic, seeded multi-scene screenplay
  generation. Each shot's opening frame is guaranteed to equal the previous
  shot's closing frame; optional Anthropic API enrichment.
- **Asset acquisition** via official stock APIs (Pexels, Pixabay, Unsplash) with
  your own keys, plus an offline SVG placeholder fallback.
- **Opt-in generative video providers** (Replicate, fal.ai, Hugging Face
  Inference) behind a common interface and a curated `tools-registry.json`.
- **Auto-Montage Sequencer** — frame-accurate Remotion (React/TS) timeline with a
  strict no-gaps/no-overlaps tiling, a validator, and MP4 rendering via the
  Remotion CLI (optional dependency).
- **Consent-gated system installer** — OS detection, exact command preview, and
  npm cache mapping onto the configured external volume.
- **Review-only provider discovery** — scans Hugging Face Hub and GitHub Search
  and files suggestions for explicit human approval; never auto-integrates.
- **Eval suite** covering continuity, determinism, timeline tiling, an offline
  end-to-end run, and the interactive pause.
- **CI** (GitHub Actions) running build + eval on Node 20 and 22.

### Scope (by design)
- Official APIs and user-owned keys only. No browser session-token reuse, no
  scraping of generative web UIs / paywall circumvention, and no auto-integration
  of untrusted endpoints or code.

[0.3.0]: https://github.com/joeshwoa/omnicinema-mcp
[0.2.0]: https://github.com/joeshwoa/omnicinema-mcp
[0.1.0]: https://github.com/joeshwoa/omnicinema-mcp
