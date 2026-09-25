/**
 * Stock footage/photo provider contract.
 *
 * Every provider talks to an official, documented API with the user's own key.
 * `configured()` is checked before ANY network call: no key → no request.
 */
export type StockKind = "video" | "image";

export interface StockSearchOptions {
  kind: StockKind;
  /** Desired frame size; used to pick the closest rendition and orientation. */
  width: number;
  height: number;
  /** Minimum clip length for videos (seconds). */
  minDurationSeconds?: number;
  perPage?: number;
  timeoutMs?: number;
}

export interface StockHit {
  provider: string;
  id: string;
  kind: StockKind;
  /** Direct media URL to download (a rendition, not the web page). */
  downloadUrl: string;
  /** Human-facing page for the asset (for attribution). */
  pageUrl: string;
  width: number;
  height: number;
  durationSeconds?: number;
  author: string;
  authorUrl: string;
  license: string;
  attribution: string;
  /** File extension to save as ("mp4", "jpg"). */
  ext: string;
  /** Provider-specific follow-up required on download (Unsplash tracking). */
  trackDownloadUrl?: string;
}

export interface StockProvider {
  slug: string;
  name: string;
  /** Env var(s) holding the key. */
  authEnv: string[];
  supports: StockKind[];
  configured(): boolean;
  /** Throws on HTTP/network errors; returns [] when nothing matches. */
  search(query: string, opts: StockSearchOptions): Promise<StockHit[]>;
  /** Download a hit to disk (and satisfy any provider download-tracking rule). */
  download(hit: StockHit, destAbsPath: string, timeoutMs?: number): Promise<number>;
}

export function orientationFor(width: number, height: number): "landscape" | "portrait" | "square" {
  const r = width / Math.max(1, height);
  if (r > 1.15) return "landscape";
  if (r < 0.87) return "portrait";
  return "square";
}

/** Pick the rendition closest to (but ideally not below) the target width. */
export function closestRendition<T extends { width: number; height: number }>(items: T[], targetWidth: number): T | undefined {
  const usable = items.filter((i) => i.width > 0 && i.height > 0);
  if (!usable.length) return undefined;
  const atLeast = usable.filter((i) => i.width >= targetWidth).sort((a, b) => a.width - b.width);
  if (atLeast.length) return atLeast[0];
  return [...usable].sort((a, b) => b.width - a.width)[0];
}

/** Trim a query to a provider's limits (Pixabay caps q at 100 chars). */
export function cleanQuery(q: string, max = 100): string {
  return q.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
