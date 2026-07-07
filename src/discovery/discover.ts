/**
 * Provider discovery — SAFE, human-in-the-loop version of "self-evolution".
 *
 * This scans official, public catalog APIs (Hugging Face Hub, GitHub Search) for
 * candidate video tools and writes them to `discovery-suggestions.json` as
 * suggestions with status "needs_review". It NEVER:
 *   - auto-integrates a discovered endpoint,
 *   - executes or imports code found online,
 *   - edits tools-registry.json on its own.
 *
 * Promoting a suggestion into the active registry is an explicit, audited action
 * (`approveSuggestion`) that a human or agent must take deliberately. This is the
 * deliberate safety boundary that replaces an autonomous auto-integrating daemon.
 */
import fs from "node:fs";
import { paths } from "../config.js";
import { getJson, USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import { loadRegistry, type RegistryEntry } from "../providers/registry.js";

export interface Suggestion {
  source: "huggingface" | "github";
  id: string;
  name: string;
  url: string;
  category: "generative-video" | "unknown";
  signal: number; // likes / stars — a rough popularity heuristic
  description: string;
  query: string;
  discoveredAt: string;
  status: "needs_review" | "approved" | "rejected";
}

interface SuggestionsFile {
  updatedAt: string;
  note: string;
  suggestions: Suggestion[];
}

function readSuggestions(): SuggestionsFile {
  try {
    return JSON.parse(fs.readFileSync(paths.discoverySuggestions, "utf8")) as SuggestionsFile;
  } catch {
    return { updatedAt: new Date().toISOString(), note: "human-review queue; nothing here is active", suggestions: [] };
  }
}

function writeSuggestions(file: SuggestionsFile): void {
  file.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.discoverySuggestions, JSON.stringify(file, null, 2), "utf8");
}

/** Query official catalogs and append new candidates to the review queue. */
export async function discover(query: string): Promise<{ added: number; total: number; suggestions: Suggestion[] }> {
  const found: Suggestion[] = [];
  const now = new Date().toISOString();

  // Hugging Face Hub — official public API.
  try {
    const models = await getJson<{ id: string; likes?: number; pipeline_tag?: string }[]>(
      `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=text-to-video&sort=likes&direction=-1&limit=10`,
    );
    for (const m of models) {
      found.push({
        source: "huggingface", id: m.id, name: m.id,
        url: `https://huggingface.co/${m.id}`, category: "generative-video",
        signal: m.likes ?? 0, description: m.pipeline_tag ?? "text-to-video model",
        query, discoveredAt: now, status: "needs_review",
      });
    }
  } catch (err) {
    log.warn(`HF discovery failed: ${String(err)}`);
  }

  // GitHub Search — official public API (unauthenticated is rate-limited).
  try {
    const ghHeaders: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    };
    const ghToken = process.env.GITHUB_TOKEN?.trim();
    if (ghToken) ghHeaders.authorization = `Bearer ${ghToken}`;
    const gh = await getJson<{ items: { full_name: string; html_url: string; stargazers_count: number; description: string | null }[] }>(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query + " text-to-video")}&sort=stars&order=desc&per_page=10`,
      ghHeaders,
    );
    for (const r of gh.items) {
      found.push({
        source: "github", id: r.full_name, name: r.full_name,
        url: r.html_url, category: "unknown", signal: r.stargazers_count,
        description: r.description ?? "", query, discoveredAt: now, status: "needs_review",
      });
    }
  } catch (err) {
    log.warn(`GitHub discovery failed: ${String(err)}`);
  }

  const file = readSuggestions();
  const existing = new Set(file.suggestions.map((s) => `${s.source}:${s.id}`));
  let added = 0;
  for (const s of found) {
    const key = `${s.source}:${s.id}`;
    if (!existing.has(key)) {
      file.suggestions.push(s);
      existing.add(key);
      added++;
    }
  }
  writeSuggestions(file);
  log.info(`Discovery for "${query}": ${added} new suggestion(s), ${file.suggestions.length} total.`);
  return { added, total: file.suggestions.length, suggestions: found };
}

export function listSuggestions(): Suggestion[] {
  return readSuggestions().suggestions;
}

/**
 * Explicitly promote a reviewed suggestion into tools-registry.json. Requires the
 * caller to pass approve=true — there is no automatic promotion path. Even after
 * this, the new entry is added DISABLED, so a human still flips `enabled` on.
 */
export function approveSuggestion(
  suggestionId: string,
  approve: boolean,
): { ok: boolean; message: string } {
  if (!approve) {
    return { ok: false, message: "approve flag was not set; no change made." };
  }
  const file = readSuggestions();
  const suggestion = file.suggestions.find((s) => s.id === suggestionId);
  if (!suggestion) return { ok: false, message: `suggestion "${suggestionId}" not found.` };

  const registry = loadRegistry();
  if (registry.providers.some((p) => p.slug === slugify(suggestion.id))) {
    suggestion.status = "approved";
    writeSuggestions(file);
    return { ok: true, message: "already present in registry; marked approved." };
  }

  const entry: RegistryEntry = {
    slug: slugify(suggestion.id),
    name: suggestion.name,
    category: "generative-video",
    description: `${suggestion.description} (discovered via ${suggestion.source}; ${suggestion.url})`,
    docsUrl: suggestion.url,
    authEnv: [],
    implemented: false, // NOT wired to code — a human must add an adapter first.
    enabled: false, // added disabled by design.
  };
  registry.providers.push(entry);
  registry.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.toolsRegistry, JSON.stringify(registry, null, 2), "utf8");

  suggestion.status = "approved";
  writeSuggestions(file);
  return {
    ok: true,
    message:
      `Added "${entry.slug}" to tools-registry.json as DISABLED and unimplemented. ` +
      `A human must write an adapter and set enabled=true before it is used.`,
  };
}

function slugify(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
