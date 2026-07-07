/**
 * Hugging Face generative provider — official Inference API.
 * Requires HUGGINGFACE_API_TOKEN and HF_VIDEO_MODEL (a text-to-video model id).
 *
 * The serverless Inference API returns raw media bytes for many generative
 * models. Availability varies by model; this provider fails safe when a model is
 * unavailable, cold-loading, or returns a non-media payload.
 */
import fs from "node:fs";
import { USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import type { GenOptions, GenResult, GenerativeProvider } from "./types.js";

function token(): string {
  return process.env.HUGGINGFACE_API_TOKEN?.trim() || "";
}
function model(): string {
  return process.env.HF_VIDEO_MODEL?.trim() || "";
}

export const huggingface: GenerativeProvider = {
  slug: "huggingface",
  description: "Hugging Face Inference API — text-to-video models via your own token.",
  authEnv: ["HUGGINGFACE_API_TOKEN", "HF_VIDEO_MODEL"],
  configured: () => Boolean(token() && model()),

  async generate(prompt: string, destAbsPath: string, _opts: GenOptions): Promise<GenResult> {
    if (!this.configured()) {
      return { ok: false, provider: "huggingface", license: "", attribution: "", note: "not configured" };
    }
    const url = `https://api-inference.huggingface.co/models/${model()}`;
    const headers = {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      accept: "video/mp4, application/octet-stream, application/json",
    };

    const deadline = Date.now() + 8 * 60_000;
    let attempt = 0;
    try {
      while (Date.now() < deadline) {
        attempt++;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }),
          signal: AbortSignal.timeout(120_000),
        });
        const ct = res.headers.get("content-type") ?? "";

        if (res.ok && (ct.startsWith("video/") || ct.includes("octet-stream"))) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength < 1024) return fail("huggingface", "response too small to be a video");
          fs.writeFileSync(destAbsPath, buf);
          log.info(`Hugging Face generated clip -> ${destAbsPath}`);
          return {
            ok: true,
            provider: "huggingface",
            license: `per model card terms (${model()})`,
            attribution: `Generated via Hugging Face model ${model()}`,
          };
        }

        // Model still loading → wait and retry.
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as { estimated_time?: number };
          const wait = Math.min(Math.ceil((body.estimated_time ?? 15) * 1000), 30_000);
          log.info(`HF model loading; retry in ${wait}ms (attempt ${attempt})`);
          await sleep(wait);
          continue;
        }

        return fail("huggingface", `HTTP ${res.status} ct=${ct}: ${(await res.text()).slice(0, 160)}`);
      }
      return fail("huggingface", "timed out waiting for model");
    } catch (err) {
      return fail("huggingface", String(err));
    }
  },
};

function fail(provider: string, note: string): GenResult {
  log.warn(`${provider} generation failed: ${note}`);
  return { ok: false, provider, license: "", attribution: "", note };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
