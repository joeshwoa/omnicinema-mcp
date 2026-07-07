/**
 * Image generative providers — official APIs, bring-your-own-key.
 *
 * Text-to-image via the Hugging Face Inference API and Replicate. Model ids are
 * user-supplied (HF_IMAGE_MODEL / REPLICATE_IMAGE_MODEL) so the tool tracks new
 * models (FLUX, SDXL, …) without code changes. Both fail safe when unconfigured.
 *
 * These call first-party inference APIs with the user's own token — NOT arbitrary
 * hosted Spaces / web UIs.
 */
import fs from "node:fs";
import { downloadTo, USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import type { GenResult } from "./types.js";

export interface ImageGenOptions {
  width: number;
  height: number;
  steps?: number;
  guidanceScale?: number;
  negativePrompt?: string;
}

export interface ImageProvider {
  slug: string;
  description: string;
  authEnv: string[];
  configured(): boolean;
  generate(prompt: string, destAbsPath: string, opts: ImageGenOptions): Promise<GenResult>;
}

const hfToken = () => process.env.HUGGINGFACE_API_TOKEN?.trim() || "";
const hfModel = () => process.env.HF_IMAGE_MODEL?.trim() || "";
const repToken = () => process.env.REPLICATE_API_TOKEN?.trim() || "";
const repModel = () => process.env.REPLICATE_IMAGE_MODEL?.trim() || "";

export const hfImage: ImageProvider = {
  slug: "huggingface-image",
  description: "Hugging Face Inference API text-to-image (FLUX/SDXL/etc via HF_IMAGE_MODEL).",
  authEnv: ["HUGGINGFACE_API_TOKEN", "HF_IMAGE_MODEL"],
  configured: () => Boolean(hfToken() && hfModel()),

  async generate(prompt, destAbsPath, opts): Promise<GenResult> {
    if (!this.configured()) return fail("huggingface-image", "not configured");
    const url = `https://api-inference.huggingface.co/models/${hfModel()}`;
    const headers = {
      authorization: `Bearer ${hfToken()}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      accept: "image/png, image/jpeg, application/json",
    };
    const body = JSON.stringify({
      inputs: prompt,
      parameters: {
        negative_prompt: opts.negativePrompt,
        width: opts.width,
        height: opts.height,
        num_inference_steps: opts.steps,
        guidance_scale: opts.guidanceScale,
      },
      options: { wait_for_model: true },
    });

    const deadline = Date.now() + 5 * 60_000;
    try {
      while (Date.now() < deadline) {
        const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
        const ct = res.headers.get("content-type") ?? "";
        if (res.ok && ct.startsWith("image/")) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength < 512) return fail("huggingface-image", "image too small");
          fs.writeFileSync(destAbsPath, buf);
          return okResult("huggingface-image", hfModel());
        }
        if (res.status === 503) {
          const b = (await res.json().catch(() => ({}))) as { estimated_time?: number };
          await sleep(Math.min(Math.ceil((b.estimated_time ?? 15) * 1000), 30_000));
          continue;
        }
        return fail("huggingface-image", `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      return fail("huggingface-image", "timed out waiting for model");
    } catch (err) {
      return fail("huggingface-image", String(err));
    }
  },
};

export const replicateImage: ImageProvider = {
  slug: "replicate-image",
  description: "Replicate text-to-image (via REPLICATE_IMAGE_MODEL, e.g. black-forest-labs/flux-schnell).",
  authEnv: ["REPLICATE_API_TOKEN", "REPLICATE_IMAGE_MODEL"],
  configured: () => Boolean(repToken() && repModel()),

  async generate(prompt, destAbsPath, opts): Promise<GenResult> {
    if (!this.configured()) return fail("replicate-image", "not configured");
    const headers = {
      authorization: `Bearer ${repToken()}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    };
    try {
      const createRes = await fetch(`https://api.replicate.com/v1/models/${repModel()}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: { prompt, negative_prompt: opts.negativePrompt, width: opts.width, height: opts.height },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!createRes.ok) return fail("replicate-image", `create HTTP ${createRes.status}`);
      let pred = (await createRes.json()) as {
        id: string; status: string; output?: string | string[] | null; error?: string | null; urls?: { get?: string };
      };
      const getUrl = pred.urls?.get ?? `https://api.replicate.com/v1/predictions/${pred.id}`;
      const deadline = Date.now() + 5 * 60_000;
      while (pred.status === "starting" || pred.status === "processing") {
        if (Date.now() > deadline) return fail("replicate-image", "timed out");
        await sleep(2500);
        const p = await fetch(getUrl, { headers, signal: AbortSignal.timeout(30_000) });
        if (!p.ok) return fail("replicate-image", `poll HTTP ${p.status}`);
        pred = (await p.json()) as typeof pred;
      }
      if (pred.status !== "succeeded") return fail("replicate-image", `status ${pred.status}: ${pred.error ?? ""}`);
      const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (!out) return fail("replicate-image", "no image url in output");
      await downloadTo(out, destAbsPath);
      return okResult("replicate-image", repModel());
    } catch (err) {
      return fail("replicate-image", String(err));
    }
  },
};

export const IMAGE_PROVIDERS: ImageProvider[] = [replicateImage, hfImage];

function okResult(provider: string, model: string): GenResult {
  log.info(`${provider} generated image via ${model}`);
  return { ok: true, provider, license: `per model terms (${model})`, attribution: `Generated via ${provider} model ${model}` };
}
function fail(provider: string, note: string): GenResult {
  if (note !== "not configured") log.warn(`${provider} failed: ${note}`);
  return { ok: false, provider, license: "", attribution: "", note };
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
