/**
 * Unsplash — official API (https://unsplash.com/documentation).
 * Key: UNSPLASH_ACCESS_KEY, sent as `Authorization: Client-ID <key>`.
 * Stills only. API guidelines honored: attribution with UTM-tagged links, and
 * the `download_location` endpoint is triggered whenever a photo is downloaded.
 */
import { env } from "../../config.js";
import { downloadTo, getJson, ping } from "../../http.js";
import { cleanQuery, orientationFor, type StockHit, type StockProvider } from "./types.js";

interface UnsplashPhoto {
  id: string; width: number; height: number;
  urls: { raw: string; full: string; regular: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

const UTM = "utm_source=omnicinema-mcp&utm_medium=referral";
const LICENSE = "Unsplash License (https://unsplash.com/license)";

function authHeaders(): Record<string, string> {
  return { authorization: `Client-ID ${env.unsplash()}`, "accept-version": "v1" };
}

export const unsplash: StockProvider = {
  slug: "unsplash",
  name: "Unsplash",
  authEnv: ["UNSPLASH_ACCESS_KEY"],
  supports: ["image"],
  configured: () => Boolean(env.unsplash()),

  async search(query, opts): Promise<StockHit[]> {
    if (!env.unsplash() || opts.kind !== "image") return [];
    const o = orientationFor(opts.width, opts.height);
    const orientation = o === "square" ? "squarish" : o;
    const per = Math.min(30, Math.max(1, opts.perPage ?? 10));
    const data = await getJson<{ results: UnsplashPhoto[] }>(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(cleanQuery(query))}&per_page=${per}&orientation=${orientation}&content_filter=high`,
      authHeaders(), opts.timeoutMs,
    );
    return (data.results ?? []).map((p) => {
      const w = Math.min(p.width, Math.max(opts.width, 640));
      const h = Math.round((p.height * w) / p.width);
      const sep = p.urls.raw.includes("?") ? "&" : "?";
      return {
        provider: "unsplash", id: p.id, kind: "image" as const,
        downloadUrl: `${p.urls.raw}${sep}w=${w}&fm=jpg&q=82&fit=max`,
        pageUrl: `${p.links.html}?${UTM}`, width: w, height: h,
        author: p.user.name, authorUrl: `${p.user.links.html}?${UTM}`, license: LICENSE,
        attribution: `Photo by ${p.user.name} (${p.user.links.html}?${UTM}) on Unsplash (https://unsplash.com/?${UTM})`,
        ext: "jpg", trackDownloadUrl: p.links.download_location,
      };
    });
  },

  async download(hit, dest, timeoutMs): Promise<number> {
    // Required by the Unsplash API guidelines: register the download.
    if (hit.trackDownloadUrl) await ping(hit.trackDownloadUrl, authHeaders());
    return downloadTo(hit.downloadUrl, dest, {}, timeoutMs);
  },
};
