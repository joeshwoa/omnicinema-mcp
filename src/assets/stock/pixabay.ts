/**
 * Pixabay — official API (https://pixabay.com/api/docs/).
 * Key: PIXABAY_API_KEY, sent as the `key` query parameter (redacted in logs).
 * License: Pixabay Content License. Pixabay asks that media be downloaded to
 * your own server rather than hot-linked — we always download.
 */
import { env } from "../../config.js";
import { downloadTo, getJson } from "../../http.js";
import { cleanQuery, closestRendition, orientationFor, type StockHit, type StockProvider } from "./types.js";

interface PixabayVideoFile { url: string; width: number; height: number; size: number }
interface PixabayVideo {
  id: number; pageURL: string; duration: number; user: string; user_id: number;
  videos: Partial<Record<"large" | "medium" | "small" | "tiny", PixabayVideoFile>>;
}
interface PixabayImage {
  id: number; pageURL: string; user: string; user_id: number; imageWidth: number; imageHeight: number;
  largeImageURL: string; webformatURL: string; fullHDURL?: string;
}

const LICENSE = "Pixabay Content License (https://pixabay.com/service/license-summary/)";

export const pixabay: StockProvider = {
  slug: "pixabay",
  name: "Pixabay",
  authEnv: ["PIXABAY_API_KEY"],
  supports: ["video", "image"],
  configured: () => Boolean(env.pixabay()),

  async search(query, opts): Promise<StockHit[]> {
    const key = env.pixabay();
    if (!key) return [];
    const q = encodeURIComponent(cleanQuery(query, 100));
    // Pixabay requires per_page in 3..200.
    const per = Math.min(200, Math.max(3, opts.perPage ?? 10));
    if (opts.kind === "video") {
      const data = await getJson<{ hits: PixabayVideo[] }>(
        `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${q}&per_page=${per}&safesearch=true`,
        {}, opts.timeoutMs,
      );
      const hits: StockHit[] = [];
      for (const v of data.hits ?? []) {
        const files = Object.values(v.videos).filter((f): f is PixabayVideoFile => Boolean(f?.url));
        const file = closestRendition(files, opts.width);
        if (!file) continue;
        const profile = `https://pixabay.com/users/${encodeURIComponent(v.user)}-${v.user_id}/`;
        hits.push({
          provider: "pixabay", id: String(v.id), kind: "video", downloadUrl: file.url, pageUrl: v.pageURL,
          width: file.width, height: file.height, durationSeconds: v.duration,
          author: v.user, authorUrl: profile, license: LICENSE,
          attribution: `Video by ${v.user} on Pixabay (${v.pageURL})`, ext: "mp4",
        });
      }
      return hits;
    }
    const orientation = orientationFor(opts.width, opts.height);
    const o = orientation === "landscape" ? "horizontal" : orientation === "portrait" ? "vertical" : "all";
    const data = await getJson<{ hits: PixabayImage[] }>(
      `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${q}&image_type=photo&orientation=${o}&per_page=${per}&safesearch=true`,
      {}, opts.timeoutMs,
    );
    return (data.hits ?? []).map((p) => {
      // largeImageURL is scaled to max 1280px on the long edge.
      const scale = Math.min(1, 1280 / Math.max(p.imageWidth, p.imageHeight));
      return {
        provider: "pixabay", id: String(p.id), kind: "image" as const, downloadUrl: p.largeImageURL, pageUrl: p.pageURL,
        width: Math.round(p.imageWidth * scale), height: Math.round(p.imageHeight * scale),
        author: p.user, authorUrl: `https://pixabay.com/users/${encodeURIComponent(p.user)}-${p.user_id}/`,
        license: LICENSE, attribution: `Image by ${p.user} on Pixabay (${p.pageURL})`, ext: "jpg",
      };
    });
  },

  download: (hit, dest, timeoutMs) => downloadTo(hit.downloadUrl, dest, {}, timeoutMs),
};
