# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
