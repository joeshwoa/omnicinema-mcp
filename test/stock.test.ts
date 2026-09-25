/**
 * Stock providers + stock manager, fully offline: global fetch is mocked, so
 * these verify request shape, parsing, license/attribution capture, the
 * "no key → no network" rule, ranking/dedupe, budget gating and the offline
 * storyboard fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pexels } from "../src/assets/stock/pexels.js";
import { pixabay } from "../src/assets/stock/pixabay.js";
import { unsplash } from "../src/assets/stock/unsplash.js";
import type { StockHit, StockProvider } from "../src/assets/stock/types.js";
import { closestRendition, orientationFor } from "../src/assets/stock/types.js";
import { acquireAssets, configuredStockProviders, rank } from "../src/assets/stockManager.js";
import { buildScreenplay } from "../src/pipeline/script-engine.js";
import { recordUsage } from "../src/limits/limit-manager.js";

type Call = { url: string; headers: Record<string, string> };
const realFetch = globalThis.fetch;

function mockFetch(routes: [RegExp, unknown][]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });
    for (const [re, body] of routes) {
      if (re.test(url)) {
        if (body instanceof Uint8Array) return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
});

const opts = { kind: "video" as const, width: 1920, height: 1080 };

test("no key → configured() is false and search makes zero network calls", async () => {
  const calls = mockFetch([]);
  for (const p of [pexels, pixabay, unsplash]) {
    assert.equal(p.configured(), false, p.slug);
    assert.deepEqual(await p.search("sea", opts), []);
    assert.deepEqual(await p.search("sea", { ...opts, kind: "image" }), []);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(configuredStockProviders(), []);
});

test("pexels: auth header, orientation, best mp4 rendition, attribution", async () => {
  process.env.PEXELS_API_KEY = "pk-test";
  const calls = mockFetch([[/videos\/search/, {
    videos: [{
      id: 42, width: 3840, height: 2160, duration: 9, url: "https://www.pexels.com/video/42/",
      user: { name: "Ana", url: "https://www.pexels.com/@ana" },
      video_files: [
        { id: 1, quality: "sd", file_type: "video/mp4", width: 960, height: 540, link: "https://v/sd.mp4" },
        { id: 2, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: "https://v/hd.mp4" },
        { id: 3, quality: "uhd", file_type: "video/mp4", width: 3840, height: 2160, link: "https://v/4k.mp4" },
      ],
    }],
  }]]);
  const hits = await pexels.search("stormy sea", opts);
  assert.equal(calls[0]!.headers.authorization, "pk-test");
  assert.match(calls[0]!.url, /orientation=landscape/);
  assert.equal(hits[0]!.downloadUrl, "https://v/hd.mp4", "closest rendition ≥ target, not 4K");
  assert.equal(hits[0]!.durationSeconds, 9);
  assert.match(hits[0]!.license, /Pexels License/);
  assert.match(hits[0]!.attribution, /Ana on Pexels/);
});

test("pixabay: key in query (per_page ≥ 3), photo + video parsing", async () => {
  process.env.PIXABAY_API_KEY = "px-test";
  const calls = mockFetch([
    [/api\/videos/, { hits: [{ id: 7, pageURL: "https://pixabay.com/videos/7", duration: 12, user: "bo", user_id: 9, videos: { large: { url: "https://p/l.mp4", width: 1920, height: 1080, size: 1 }, small: { url: "https://p/s.mp4", width: 960, height: 540, size: 1 } } }] }],
    [/pixabay\.com\/api\/\?/, { hits: [{ id: 8, pageURL: "https://pixabay.com/photos/8", user: "cy", user_id: 3, imageWidth: 4000, imageHeight: 2000, largeImageURL: "https://p/large.jpg", webformatURL: "https://p/web.jpg" }] }],
  ]);
  const v = await pixabay.search("sea", { ...opts, perPage: 1 });
  assert.match(calls[0]!.url, /key=px-test/);
  assert.match(calls[0]!.url, /per_page=3/, "Pixabay requires per_page ≥ 3");
  assert.equal(v[0]!.downloadUrl, "https://p/l.mp4");
  const img = await pixabay.search("sea", { ...opts, kind: "image" });
  assert.equal(img[0]!.width, 1280, "largeImageURL is capped at 1280px");
  assert.match(img[0]!.attribution, /cy on Pixabay/);
});

test("unsplash: Client-ID auth, stills only, download tracking ping", async () => {
  process.env.UNSPLASH_ACCESS_KEY = "us-test";
  const calls = mockFetch([
    [/search\/photos/, { results: [{ id: "abc", width: 6000, height: 4000, urls: { raw: "https://images.unsplash.com/photo?ixid=1", full: "", regular: "" }, links: { html: "https://unsplash.com/photos/abc", download_location: "https://api.unsplash.com/photos/abc/download" }, user: { name: "Dee", links: { html: "https://unsplash.com/@dee" } } }] }],
    [/photos\/abc\/download/, {}],
    [/images\.unsplash\.com/, new Uint8Array(4096)],
  ]);
  assert.deepEqual(await unsplash.search("sea", opts), [], "no video on Unsplash");
  const hits = await unsplash.search("sea", { ...opts, kind: "image" });
  assert.equal(calls[0]!.headers.authorization, "Client-ID us-test");
  assert.match(hits[0]!.downloadUrl, /ixid=1&w=1920&fm=jpg/);
  assert.match(hits[0]!.attribution, /utm_source=omnicinema-mcp/);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-us-")), "x.jpg");
  await unsplash.download(hits[0]!, dest);
  assert.ok(calls.some((c) => c.url.includes("/photos/abc/download")), "download_location was triggered");
  assert.equal(fs.statSync(dest).size, 4096);
});

test("helpers: orientation and rendition choice", () => {
  assert.equal(orientationFor(1920, 1080), "landscape");
  assert.equal(orientationFor(1080, 1920), "portrait");
  assert.equal(orientationFor(1000, 1000), "square");
  assert.equal(closestRendition([{ width: 640, height: 360 }, { width: 1280, height: 720 }], 1920)!.width, 1280, "largest when none reaches target");
});

function fakeProvider(hits: StockHit[], opts: { fail?: boolean } = {}): StockProvider & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    slug: "fake", name: "Fake", authEnv: [], supports: ["video", "image"], configured: () => true, downloads,
    async search(q, o) {
      if (opts.fail) throw new Error("HTTP 500");
      return hits.filter((h) => h.kind === o.kind);
    },
    async download(hit, dest) {
      downloads.push(hit.id);
      fs.writeFileSync(dest, Buffer.alloc(4096));
      return 4096;
    },
  };
}

function hit(id: string, kind: "video" | "image", w: number, h: number, dur?: number): StockHit {
  return { provider: "fake", id, kind, downloadUrl: `https://x/${id}`, pageUrl: `https://x/p/${id}`, width: w, height: h, durationSeconds: dur, author: "A", authorUrl: "", license: "Fake License", attribution: `by A (${id})`, ext: kind === "video" ? "mp4" : "jpg" };
}

const SP = buildScreenplay({ prompt: "a lighthouse keeper watching a storm over the sea", sceneCount: 2, shotsPerScene: 2, fps: 24, width: 1920, height: 1080 });

test("rank prefers matching orientation and clips long enough for the shot", () => {
  const shot = SP.scenes[0]!.shots[0]!;
  const ranked = rank([hit("portrait", "video", 1080, 1920, 10), hit("short", "video", 1920, 1080, 2), hit("good", "video", 1920, 1080, 8)], shot, SP);
  assert.equal(ranked[0]!.id, "good");
});

test("acquireAssets: one downloaded clip per shot, no reuse, licenses recorded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acq-"));
  const p = fakeProvider([hit("v1", "video", 1920, 1080, 9), hit("v2", "video", 1920, 1080, 9), hit("v3", "video", 1920, 1080, 9), hit("v4", "video", 1920, 1080, 9)]);
  const res = await acquireAssets(SP, { projectAbsDir: dir, prefer: "video", providers: [p], approveOverBudget: true });
  assert.equal(res.clips.length, 4);
  assert.equal(new Set(p.downloads).size, 4, "no clip reused across shots");
  for (const c of res.clips) {
    assert.equal(c.source, "stock");
    assert.equal(c.license, "Fake License");
    assert.ok(fs.existsSync(path.join(dir, c.localPath)));
  }
});

test("acquireAssets: provider errors fall back to storyboard frames with warnings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acq-"));
  const res = await acquireAssets(SP, { projectAbsDir: dir, prefer: "video", providers: [fakeProvider([], { fail: true })], approveOverBudget: true });
  assert.equal(res.clips.length, 4);
  assert.ok(res.clips.every((c) => c.source === "placeholder" && fs.existsSync(path.join(dir, c.localPath))));
  assert.ok(res.warnings.some((w) => /HTTP 500/.test(w)));
});

test("acquireAssets: the budget guard blocks a stock provider unless approved", async () => {
  process.env.LIMIT_FAKE_DAILY = "2";
  recordUsage("fake", 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acq-"));
  const p = fakeProvider([hit("v1", "video", 1920, 1080, 9)]);
  const res = await acquireAssets(SP, { projectAbsDir: dir, prefer: "video", providers: [p] });
  assert.equal(p.downloads.length, 0, "no request spent past the guard");
  assert.ok(res.warnings.some((w) => /budget guard/.test(w)));
  delete process.env.LIMIT_FAKE_DAILY;
});

test("acquireAssets offline: storyboard frames (PNG if rasterizer, else SVG) for every shot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acq-"));
  const skip = new Set([SP.scenes[0]!.shots[0]!.id]);
  const res = await acquireAssets(SP, { projectAbsDir: dir, prefer: "video", offline: true, skipShotIds: skip });
  assert.equal(res.clips.length, 3, "skipped shot is not filled");
  for (const c of res.clips) {
    assert.equal(c.provider, "offline-storyboard");
    assert.ok(c.kind === "image" ? c.localPath.endsWith(".png") : c.localPath.endsWith(".svg"));
    assert.ok(fs.existsSync(path.join(dir, c.localPath)));
  }
});
