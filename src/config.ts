/**
 * Central configuration + path management.
 *
 * Every path the pipeline writes to is derived from CINEMA_ROOT, which defaults
 * to the repository root. This is what keeps all source, caches, downloads, and
 * rendered output on the external volume (e.g. /Volumes/PortableSSD/...).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repository root = one level up from dist/ or src/. */
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Minimal, dependency-free `.env` loader. Populates process.env from a `.env`
 * file at the repo root without overwriting variables already present in the
 * environment. We avoid a dependency here so the MCP server stays lightweight.
 */
function loadDotEnv(root: string): void {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(REPO_ROOT);

/** The root under which all runtime artifacts live. */
export const CINEMA_ROOT = path.resolve(process.env.CINEMA_ROOT || REPO_ROOT);

export const paths = {
  root: CINEMA_ROOT,
  repoRoot: REPO_ROOT,
  assets: path.join(CINEMA_ROOT, "assets"),
  cache: path.join(CINEMA_ROOT, ".cache"),
  output: path.join(CINEMA_ROOT, "output"),
  projects: path.join(CINEMA_ROOT, "projects"),
  remotion: path.join(REPO_ROOT, "remotion"),
  toolsRegistry: path.join(REPO_ROOT, "tools-registry.json"),
  data: path.join(CINEMA_ROOT, "data"),
  usageLimits: path.join(CINEMA_ROOT, "data", "usage-limits.json"),
  reviewQueue: path.join(CINEMA_ROOT, "data", "review-queue.json"),
  ipcToken: path.join(CINEMA_ROOT, "data", "ipc-token.txt"),
  /** @deprecated use `reviewQueue`; kept as an alias for the discovery module. */
  discoverySuggestions: path.join(CINEMA_ROOT, "data", "review-queue.json"),
} as const;

/** Create every runtime directory up front. Safe to call repeatedly. */
export function ensureDirs(): void {
  for (const dir of [paths.assets, paths.cache, paths.output, paths.projects, paths.data]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Resolve a per-project directory (each pipeline run gets its own). */
export function projectDir(projectId: string): string {
  return path.join(paths.projects, projectId);
}

export const env = {
  // Stock
  pexels: () => process.env.PEXELS_API_KEY?.trim() || "",
  pixabay: () => process.env.PIXABAY_API_KEY?.trim() || "",
  unsplash: () => process.env.UNSPLASH_ACCESS_KEY?.trim() || "",
  freesound: () => process.env.FREESOUND_API_KEY?.trim() || "",
  // Generative auth (bring-your-own-key)
  huggingface: () => process.env.HUGGINGFACE_API_TOKEN?.trim() || "",
  replicate: () => process.env.REPLICATE_API_TOKEN?.trim() || "",
  fal: () => process.env.FAL_API_KEY?.trim() || "",
  // Model ids (user-chosen so the tool stays current without code changes)
  hfImageModel: () => process.env.HF_IMAGE_MODEL?.trim() || "",
  hfTtsModel: () => process.env.HF_TTS_MODEL?.trim() || "",
  replicateImageModel: () => process.env.REPLICATE_IMAGE_MODEL?.trim() || "",
  replicateMusicModel: () => process.env.REPLICATE_MUSIC_MODEL?.trim() || "",
  falImageModel: () => process.env.FAL_IMAGE_MODEL?.trim() || "",
  // LLM enrichment (optional)
  anthropic: () => process.env.ANTHROPIC_API_KEY?.trim() || "",
  anthropicModel: () => process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
  // Behavior
  allowInstall: () => process.env.CINEMA_ALLOW_INSTALL?.trim() === "1",
  // Inter-tool IPC server
  ipcHost: () => process.env.OMNICINEMA_IPC_HOST?.trim() || "127.0.0.1",
  ipcPort: () => Number.parseInt(process.env.OMNICINEMA_IPC_PORT?.trim() || "8787", 10),
  ipcToken: () => process.env.OMNICINEMA_IPC_TOKEN?.trim() || "",
  /** Read an integer quota override from env, e.g. LIMIT_HUGGINGFACE_DAILY. */
  quota: (provider: string, period: "DAILY" | "WEEKLY" | "MONTHLY"): number | null => {
    const raw = process.env[`LIMIT_${provider.toUpperCase()}_${period}`]?.trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  },
} as const;
