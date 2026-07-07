/**
 * Provider registry.
 *
 * Bridges the human-curated `tools-registry.json` catalog with the typed,
 * code-backed generative providers. The registry is READ at runtime; it is only
 * ever WRITTEN by a human (or by an explicit review-and-merge of discovery
 * suggestions). Nothing here auto-loads or auto-executes code found on the
 * internet — that is a deliberate safety boundary.
 */
import fs from "node:fs";
import { paths } from "../config.js";
import { log } from "../logger.js";
import { fal } from "./fal.js";
import { huggingface } from "./huggingface.js";
import { replicate } from "./replicate.js";
import type { GenOptions, GenResult, GenerativeProvider } from "./types.js";

/** Code-backed generative providers, in default preference order. */
export const GENERATIVE_PROVIDERS: GenerativeProvider[] = [replicate, fal, huggingface];

export interface RegistryEntry {
  slug: string;
  name: string;
  category: "stock" | "generative-video" | "generative-image" | "audio";
  description: string;
  docsUrl: string;
  authEnv: string[];
  /** Whether this entry is wired to code in this repo. */
  implemented: boolean;
  /** Curated on/off switch; a human edits this. */
  enabled: boolean;
}

export interface ToolsRegistry {
  version: number;
  updatedAt: string;
  note: string;
  providers: RegistryEntry[];
}

export function loadRegistry(): ToolsRegistry {
  try {
    const raw = fs.readFileSync(paths.toolsRegistry, "utf8");
    return JSON.parse(raw) as ToolsRegistry;
  } catch (err) {
    log.warn(`Could not read tools-registry.json: ${String(err)}`);
    return { version: 0, updatedAt: new Date().toISOString(), note: "fallback (file unreadable)", providers: [] };
  }
}

/** Enumerate providers with live "configured" status merged in. */
export function describeProviders(): (RegistryEntry & { configured: boolean })[] {
  const registry = loadRegistry();
  const codeBySlug = new Map(GENERATIVE_PROVIDERS.map((p) => [p.slug, p]));
  return registry.providers.map((entry) => ({
    ...entry,
    configured: codeBySlug.get(entry.slug)?.configured() ?? false,
  }));
}

/**
 * Generate a clip for one shot by trying configured generative providers in the
 * registry's enabled order. Returns the first success, or ok:false if none work.
 */
export async function generateForShot(
  prompt: string,
  destAbsPath: string,
  opts: GenOptions,
): Promise<GenResult> {
  const registry = loadRegistry();
  const enabledOrder = registry.providers
    .filter((e) => e.enabled && e.category === "generative-video")
    .map((e) => e.slug);

  const ordered = [...GENERATIVE_PROVIDERS].sort(
    (a, b) => indexOr(enabledOrder, a.slug) - indexOr(enabledOrder, b.slug),
  );

  for (const provider of ordered) {
    if (!provider.configured()) continue;
    const result = await provider.generate(prompt, destAbsPath, opts);
    if (result.ok) return result;
  }
  return { ok: false, provider: "none", license: "", attribution: "", note: "no configured generative provider succeeded" };
}

export function anyGenerativeConfigured(): boolean {
  return GENERATIVE_PROVIDERS.some((p) => p.configured());
}

function indexOr(arr: string[], v: string): number {
  const i = arr.indexOf(v);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
