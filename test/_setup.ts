/**
 * Test isolation: run every suite against a throwaway CINEMA_ROOT so tests
 * never touch the user's real data/usage-limits.json, projects/ or assets/,
 * and never read the developer's .env keys (provider keys are cleared).
 * Loaded via `--import` before any module reads config.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.OMNICINEMA_TEST_KEEP_ROOT) {
  process.env.CINEMA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omni-test-root-"));
}
for (const k of [
  "PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY", "FREESOUND_API_KEY",
  "REPLICATE_API_TOKEN", "REPLICATE_VIDEO_MODEL", "REPLICATE_IMAGE_MODEL", "REPLICATE_MUSIC_MODEL",
  "FAL_API_KEY", "FAL_VIDEO_MODEL", "HUGGINGFACE_API_TOKEN", "HF_VIDEO_MODEL", "HF_IMAGE_MODEL",
  "HF_TTS_MODEL", "HF_MUSIC_MODEL", "ANTHROPIC_API_KEY",
]) {
  // Set to empty (not deleted) so config's .env loader cannot re-populate them.
  process.env[k] = "";
}
