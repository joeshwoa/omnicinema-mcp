/**
 * Stock asset manager — one clip per shot.
 *
 * For every shot (minus `skipShotIds`, e.g. shots already generated), search the
 * configured stock providers in registry order via their official APIs, pick the
 * best-fitting unused hit (orientation, duration ≥ shot, resolution near the
 * target), download it into the project folder, and record license +
 * attribution. Shots that cannot be filled get an offline storyboard frame
 * (SVG, rasterized to PNG when a rasterizer exists), so the pipeline always
 * produces a complete, renderable timeline — an animatic — with no keys and no
 * network.
 *
 * Safety: providers without a key are never called; the budget guard is
 * consulted before each API request (stock quotas are tracked like any other).
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { loadRegistry } from "../providers/registry.js";
import { checkBudget, recordUsage } from "../limits/limit-manager.js";
import type { AssetClip, Screenplay, Shot } from "../types.js";
import { pexels } from "./stock/pexels.js";
import { pixabay } from "./stock/pixabay.js";
import { unsplash } from "./stock/unsplash.js";
import type { StockHit, StockKind, StockProvider } from "./stock/types.js";
import { generateStoryboardFrameSvg } from "./vector.js";
import { rasterizeSvg } from "./raster.js";

export const STOCK_PROVIDERS: StockProvider[] = [pexels, pixabay, unsplash];

/** Slugs of stock providers that have a key configured. */
export function configuredStockProviders(providers: StockProvider[] = STOCK_PROVIDERS): string[] {
  return providers.filter((p) => p.configured()).map((p) => p.slug);
}

export interface AcquireOptions {
  projectAbsDir: string;
  prefer: "video" | "image";
  skipShotIds?: Set<string>;
  /** Skip every provider (offline storyboard only). */
  offline?: boolean;
  /** Proceed past the free-tier guard for stock APIs. */
  approveOverBudget?: boolean;
  /** Injected providers (tests); defaults to the registry-ordered built-ins. */
  providers?: StockProvider[];
  timeoutMs?: number;
}

export interface AcquireResult {
  clips: AssetClip[];
  warnings: string[];
}

/** Built-in providers ordered by tools-registry.json (disabled ones dropped). */
export function orderedStockProviders(): StockProvider[] {
  const reg = loadRegistry().providers.filter((e) => e.category === "stock");
  if (!reg.length) return STOCK_PROVIDERS;
  const enabled = reg.filter((e) => e.enabled).map((e) => e.slug);
  return STOCK_PROVIDERS.filter((p) => enabled.includes(p.slug)).sort((a, b) => enabled.indexOf(a.slug) - enabled.indexOf(b.slug));
}

export async function acquireAssets(screenplay: Screenplay, opts: AcquireOptions): Promise<AcquireResult> {
  fs.mkdirSync(opts.projectAbsDir, { recursive: true });
  const warnings: string[] = [];
  const clips: AssetClip[] = [];
  const shots = screenplay.scenes.flatMap((s) => s.shots);
  const providers = opts.offline ? [] : (opts.providers ?? orderedStockProviders()).filter((p) => p.configured());
  const blocked = new Set<string>();
  const failures = new Map<string, number>();
  const cache = new Map<string, StockHit[]>();
  const used = new Set<string>();
  const kinds: StockKind[] = opts.prefer === "image" ? ["image", "video"] : ["video", "image"];

  const search = async (p: StockProvider, q: string, kind: StockKind): Promise<StockHit[]> => {
    const key = `${p.slug}|${kind}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const budget = checkBudget(p.slug, 1);
    if (budget.requiresApproval && !opts.approveOverBudget) {
      if (!blocked.has(p.slug)) warnings.push(`stock(${p.slug}): budget guard — ${budget.message} Skipped; re-run with approveOverBudget:true or raise LIMIT_${p.slug.toUpperCase()}_DAILY.`);
      blocked.add(p.slug);
      return [];
    }
    recordUsage(p.slug, 1);
    const results = await p.search(q, {
      kind, width: screenplay.width, height: screenplay.height, perPage: 12, timeoutMs: opts.timeoutMs ?? 20_000,
    });
    cache.set(key, results);
    return results;
  };

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]!;
    if (opts.skipShotIds?.has(shot.id)) continue;
    let clip: AssetClip | null = null;

    outer: for (const kind of kinds) {
      for (const p of providers) {
        if (blocked.has(p.slug) || !p.supports.includes(kind)) continue;
        if ((failures.get(p.slug) ?? 0) >= 3) continue; // provider looks down; stop hammering it
        for (const q of queriesFor(screenplay, shot)) {
          let hits: StockHit[];
          try {
            hits = await search(p, q, kind);
          } catch (err) {
            failures.set(p.slug, (failures.get(p.slug) ?? 0) + 1);
            warnings.push(`stock(${p.slug}) search "${q}" failed: ${short(err)}`);
            break;
          }
          const ranked = rank(hits.filter((h) => !used.has(`${h.provider}:${h.id}`)), shot, screenplay);
          for (const h of ranked.slice(0, 2)) {
            const file = `${shot.id}.${h.ext}`;
            const dest = path.join(opts.projectAbsDir, file);
            try {
              const bytes = await p.download(h, dest, 180_000);
              if (bytes < 1024) throw new Error(`file too small (${bytes} bytes)`);
              used.add(`${h.provider}:${h.id}`);
              clip = {
                id: `clip-${shot.id}`, shotId: shot.id, source: "stock", provider: h.provider,
                remoteUrl: h.pageUrl, localPath: file, durationSeconds: shot.durationSeconds,
                kind: h.kind, width: h.width, height: h.height, license: h.license, attribution: h.attribution,
              };
              log.info(`stock ${shot.id}: ${h.provider} ${h.kind} ${h.id} (${q})`);
              break outer;
            } catch (err) {
              try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
              warnings.push(`stock(${p.slug}) download ${h.id} failed: ${short(err)}`);
            }
          }
        }
      }
    }

    if (!clip) clip = await placeholderClip(screenplay, shot, i, shots.length, opts.projectAbsDir, providers.length > 0);
    clips.push(clip);
  }

  const placeholders = clips.filter((c) => c.source === "placeholder").length;
  if (placeholders && !providers.length && !opts.offline) {
    warnings.push(`No stock provider configured (set PEXELS_API_KEY, PIXABAY_API_KEY or UNSPLASH_ACCESS_KEY); ${placeholders} shot(s) use offline storyboard frames.`);
  } else if (placeholders && providers.length) {
    warnings.push(`${placeholders} shot(s) had no usable stock match and use offline storyboard frames.`);
  }
  return { clips, warnings };
}

/** Candidate search queries for a shot, most specific first. */
export function queriesFor(sp: Screenplay, shot: Shot): string[] {
  const out = [shot.assetQuery, shot.keywords.slice(0, 2).join(" "), shot.keywords[0] ?? "", sp.title];
  return [...new Set(out.map((q) => q.trim()).filter((q) => q.length > 1))];
}

/** Score hits: orientation match, long-enough clip, resolution near target. */
export function rank(hits: StockHit[], shot: Shot, sp: Screenplay): StockHit[] {
  const targetAr = sp.width / sp.height;
  const score = (h: StockHit) => {
    let s = 0;
    const ar = h.width / Math.max(1, h.height);
    s -= Math.abs(Math.log(ar / targetAr)) * 4;
    if (h.kind === "video") {
      const d = h.durationSeconds ?? 0;
      s += d >= shot.durationSeconds + 0.5 ? 2 : d >= shot.durationSeconds ? 1 : -3;
      if (d > 60) s -= 1; // huge downloads for a few seconds of use
    }
    const res = h.width / sp.width;
    s += res >= 1 ? 1 - Math.min(1, (res - 1) * 0.5) : -2 * (1 - res);
    return s;
  };
  return [...hits].sort((a, b) => score(b) - score(a));
}

async function placeholderClip(sp: Screenplay, shot: Shot, idx: number, total: number, dir: string, hadProviders: boolean): Promise<AssetClip> {
  const scene = sp.scenes.find((s) => s.id === shot.sceneId);
  const svgFile = `${shot.id}.svg`;
  const svgPath = path.join(dir, svgFile);
  generateStoryboardFrameSvg({
    filmTitle: sp.title,
    sceneHeading: scene?.heading ?? shot.sceneId,
    shotId: shot.id,
    shotNumber: idx + 1,
    shotCount: total,
    action: shot.action,
    framing: shot.openingFrame.framing,
    cameraMovement: shot.cameraMovement,
    lighting: shot.openingFrame.lighting,
    subjectPosition: shot.openingFrame.subjectPosition,
    palette: shot.openingFrame.palette,
    durationSeconds: shot.durationSeconds,
    keywords: shot.keywords,
    footer: hadProviders ? "Storyboard frame — no matching stock clip" : "Offline storyboard frame — add a stock API key for real footage",
  }, svgPath, sp.width, sp.height);
  const pngFile = `${shot.id}.png`;
  const rasterized = await rasterizeSvg(svgPath, path.join(dir, pngFile), sp.width, sp.height);
  return {
    id: `clip-${shot.id}`, shotId: shot.id, source: "placeholder", provider: "offline-storyboard",
    remoteUrl: "", localPath: rasterized ? pngFile : svgFile, durationSeconds: shot.durationSeconds,
    kind: rasterized ? "image" : "placeholder", width: sp.width, height: sp.height,
    license: "MIT (generated by omnicinema-mcp)", attribution: "Offline storyboard frame (generated)",
  };
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
