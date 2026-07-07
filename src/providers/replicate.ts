/**
 * Replicate generative provider — official API (https://replicate.com/docs).
 * Requires REPLICATE_API_TOKEN and REPLICATE_VIDEO_MODEL (e.g. "owner/model").
 * The model id is user-supplied so this stays current without code changes.
 */
import { downloadTo, USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import type { GenOptions, GenResult, GenerativeProvider } from "./types.js";

const API = "https://api.replicate.com/v1";

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
}

function token(): string {
  return process.env.REPLICATE_API_TOKEN?.trim() || "";
}
function model(): string {
  return process.env.REPLICATE_VIDEO_MODEL?.trim() || "";
}

export const replicate: GenerativeProvider = {
  slug: "replicate",
  description: "Replicate — run open text-to-video models via your own API token.",
  authEnv: ["REPLICATE_API_TOKEN", "REPLICATE_VIDEO_MODEL"],
  configured: () => Boolean(token() && model()),

  async generate(prompt: string, destAbsPath: string, opts: GenOptions): Promise<GenResult> {
    if (!this.configured()) {
      return { ok: false, provider: "replicate", license: "", attribution: "", note: "not configured" };
    }
    const headers = {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    };
    try {
      const createRes = await fetch(`${API}/models/${model()}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: {
            prompt,
            width: opts.width,
            height: opts.height,
            num_frames: Math.round(opts.durationSeconds * opts.fps),
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!createRes.ok) {
        return fail("replicate", `create HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
      }
      let pred = (await createRes.json()) as Prediction;
      const getUrl = pred.urls?.get ?? `${API}/predictions/${pred.id}`;

      const deadline = Date.now() + 8 * 60_000; // up to 8 minutes
      while (pred.status === "starting" || pred.status === "processing") {
        if (Date.now() > deadline) return fail("replicate", "timed out polling prediction");
        await sleep(3000);
        const pollRes = await fetch(getUrl, { headers, signal: AbortSignal.timeout(30_000) });
        if (!pollRes.ok) return fail("replicate", `poll HTTP ${pollRes.status}`);
        pred = (await pollRes.json()) as Prediction;
      }
      if (pred.status !== "succeeded") {
        return fail("replicate", `status ${pred.status}: ${pred.error ?? "unknown"}`);
      }
      const url = pickVideoUrl(pred.output);
      if (!url) return fail("replicate", "no video URL in output");
      await downloadTo(url, destAbsPath);
      log.info(`Replicate generated clip -> ${destAbsPath}`);
      return {
        ok: true,
        provider: "replicate",
        license: `per Replicate model terms (${model()})`,
        attribution: `Generated via Replicate model ${model()}`,
      };
    } catch (err) {
      return fail("replicate", String(err));
    }
  },
};

function pickVideoUrl(output: Prediction["output"]): string | null {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.find((u) => typeof u === "string") ?? null;
  return null;
}

function fail(provider: string, note: string): GenResult {
  log.warn(`${provider} generation failed: ${note}`);
  return { ok: false, provider, license: "", attribution: "", note };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
