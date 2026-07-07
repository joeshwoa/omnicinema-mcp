# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-07

Expanded from a video pipeline (`autonomous-cinema-mcp`) into a master asset-creation
engine (`omnicinema-mcp`). The video pipeline is retained and enhanced.

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
- Package renamed to `omnicinema-mcp` (v0.2.0); the `autonomous-cinema-mcp` bin remains
  as an alias. Storage directory unchanged.

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

[0.1.0]: https://github.com/
