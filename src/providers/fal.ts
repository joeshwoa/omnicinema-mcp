/**
 * fal.ai generative provider — official queue API (https://fal.ai/docs).
 * Requires FAL_API_KEY and FAL_VIDEO_MODEL (e.g. "fal-ai/ltx-video").
 * Model id is user-supplied to stay current without code changes.
 */
import { downloadTo, USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import type { GenOptions, GenResult, GenerativeProvider } from "./types.js";

interface Enqueued {
  request_id: string;
  status_url: string;
  response_url: string;
}
interface StatusBody {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

function key(): string {
  return process.env.FAL_API_KEY?.trim() || "";
}
function model(): string {
  return process.env.FAL_VIDEO_MODEL?.trim() || "";
}

export const fal: GenerativeProvider = {
  slug: "fal",
  description: "fal.ai — run hosted text-to-video models via your own API key.",
  authEnv: ["FAL_API_KEY", "FAL_VIDEO_MODEL"],
  configured: () => Boolean(key() && model()),

  async generate(prompt: string, destAbsPath: string, opts: GenOptions): Promise<GenResult> {
    if (!this.configured()) {
      return { ok: false, provider: "fal", license: "", attribution: "", note: "not configured" };
    }
    const headers = {
      authorization: `Key ${key()}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    };
    try {
      const enqRes = await fetch(`https://queue.fal.run/${model()}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt,
          image_size: { width: opts.width, height: opts.height },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!enqRes.ok) {
        return fail("fal", `enqueue HTTP ${enqRes.status}: ${(await enqRes.text()).slice(0, 200)}`);
      }
      const enq = (await enqRes.json()) as Enqueued;

      const deadline = Date.now() + 8 * 60_000;
      let status: StatusBody["status"] = "IN_QUEUE";
      while (status === "IN_QUEUE" || status === "IN_PROGRESS") {
        if (Date.now() > deadline) return fail("fal", "timed out polling queue");
        await sleep(3000);
        const stRes = await fetch(enq.status_url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!stRes.ok) return fail("fal", `status HTTP ${stRes.status}`);
        status = ((await stRes.json()) as StatusBody).status;
      }
      if (status !== "COMPLETED") return fail("fal", `status ${status}`);

      const resRes = await fetch(enq.response_url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!resRes.ok) return fail("fal", `response HTTP ${resRes.status}`);
      const payload = (await resRes.json()) as unknown;
      const url = findVideoUrl(payload);
      if (!url) return fail("fal", "no video URL in response");
      await downloadTo(url, destAbsPath);
      log.info(`fal generated clip -> ${destAbsPath}`);
      return {
        ok: true,
        provider: "fal",
        license: `per fal.ai model terms (${model()})`,
        attribution: `Generated via fal.ai model ${model()}`,
      };
    } catch (err) {
      return fail("fal", String(err));
    }
  },
};

/** Depth-first search for a plausible video URL in an arbitrary JSON payload. */
function findVideoUrl(node: unknown): string | null {
  if (!node) return null;
  if (typeof node === "string") {
    return /^https?:\/\/.*\.(mp4|webm|mov)(\?|$)/i.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findVideoUrl(value);
      if (found) return found;
    }
  }
  return null;
}

function fail(provider: string, note: string): GenResult {
  log.warn(`${provider} generation failed: ${note}`);
  return { ok: false, provider, license: "", attribution: "", note };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
