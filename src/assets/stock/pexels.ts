/**
 * Pexels — official API (https://www.pexels.com/api/documentation/).
 * Key: PEXELS_API_KEY, sent as the `Authorization` header.
 * License: Pexels License (free to use; attribution appreciated — we record it).
 */
import { env } from "../../config.js";
import { downloadTo, getJson } from "../../http.js";
import { cleanQuery, closestRendition, orientationFor, type StockHit, type StockProvider } from "./types.js";

interface PexelsVideo {
  id: number; width: number; height: number; duration: number; url: string;
  user: { name: string; url: string };
  video_files: { id: number; quality: string | null; file_type: string; width: number | null; height: number | null; link: string }[];
}
interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer: string; photographer_url: string; alt?: string;
  src: { original: string; large2x: string; large: string; landscape: string; portrait: string };
}

const LICENSE = "Pexels License (https://www.pexels.com/license/)";

export const pexels: StockProvider = {
  slug: "pexels",
  name: "Pexels",
  authEnv: ["PEXELS_API_KEY"],
  supports: ["video", "image"],
  configured: () => Boolean(env.pexels()),

  async search(query, opts): Promise<StockHit[]> {
    const key = env.pexels();
    if (!key) return [];
    const q = encodeURIComponent(cleanQuery(query));
    const orientation = orientationFor(opts.width, opts.height);
    const per = Math.min(80, Math.max(1, opts.perPage ?? 10));
    const headers = { authorization: key };
    if (opts.kind === "video") {
      const size = opts.width > 1920 ? "large" : "medium";
      const data = await getJson<{ videos: PexelsVideo[] }>(
        `https://api.pexels.com/videos/search?query=${q}&orientation=${orientation}&size=${size}&per_page=${per}`,
        headers, opts.timeoutMs,
      );
      const hits: StockHit[] = [];
      for (const v of data.videos ?? []) {
        const files = v.video_files
          .filter((f) => f.file_type === "video/mp4" && f.width && f.height)
          .map((f) => ({ ...f, width: f.width!, height: f.height! }));
        const file = closestRendition(files, opts.width);
        if (!file) continue;
        hits.push({
          provider: "pexels", id: String(v.id), kind: "video", downloadUrl: file.link, pageUrl: v.url,
          width: file.width, height: file.height, durationSeconds: v.duration,
          author: v.user.name, authorUrl: v.user.url, license: LICENSE,
          attribution: `Video by ${v.user.name} on Pexels (${v.url})`, ext: "mp4",
        });
      }
      return hits;
    }
    const data = await getJson<{ photos: PexelsPhoto[] }>(
      `https://api.pexels.com/v1/search?query=${q}&orientation=${orientation}&per_page=${per}`,
      headers, opts.timeoutMs,
    );
    return (data.photos ?? []).map((p) => {
      // `original` accepts imgix-style sizing params; request ~target width.
      const w = Math.min(p.width, Math.max(opts.width, 640));
      const h = Math.round((p.height * w) / p.width);
      return {
        provider: "pexels", id: String(p.id), kind: "image" as const,
        downloadUrl: `${p.src.original}?auto=compress&cs=tinysrgb&w=${w}`, pageUrl: p.url,
        width: w, height: h, author: p.photographer, authorUrl: p.photographer_url, license: LICENSE,
        attribution: `Photo by ${p.photographer} on Pexels (${p.url})`, ext: "jpg",
      };
    });
  },

  download: (hit, dest, timeoutMs) => downloadTo(hit.downloadUrl, dest, {}, timeoutMs),
};
