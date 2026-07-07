/**
 * Audio generative providers — official APIs, bring-your-own-key.
 *
 * - TTS via the Hugging Face Inference API (e.g. Kokoro/Bark via HF_TTS_MODEL).
 * - Music via MusicGen/AudioCraft on HF Inference (HF_MUSIC_MODEL) or Replicate
 *   (REPLICATE_MUSIC_MODEL).
 * - Stock SFX/ambience via the official Freesound API (public preview mp3s).
 *
 * First-party inference APIs with the user's own token only — no scraping of
 * hosted web sandboxes (Suno/Udio/etc.). The always-available fallback is local
 * synthesis (see src/audio/synth.ts).
 */
import fs from "node:fs";
import { downloadTo, getJson, USER_AGENT } from "../http.js";
import { log } from "../logger.js";
import { env } from "../config.js";
import type { GenResult } from "./types.js";

const hfToken = () => process.env.HUGGINGFACE_API_TOKEN?.trim() || "";

async function hfInferenceToFile(model: string, body: unknown, dest: string, label: string): Promise<GenResult> {
  const url = `https://api-inference.huggingface.co/models/${model}`;
  const headers = {
    authorization: `Bearer ${hfToken()}`,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    accept: "audio/wav, audio/mpeg, audio/flac, application/octet-stream, application/json",
  };
  const deadline = Date.now() + 6 * 60_000;
  try {
    while (Date.now() < deadline) {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && (ct.startsWith("audio/") || ct.includes("octet-stream"))) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength < 256) return fail(label, "audio too small");
        fs.writeFileSync(dest, buf);
        return ok(label, model);
      }
      if (res.status === 503) {
        const b = (await res.json().catch(() => ({}))) as { estimated_time?: number };
        await sleep(Math.min(Math.ceil((b.estimated_time ?? 15) * 1000), 30_000));
        continue;
      }
      return fail(label, `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    return fail(label, "timed out waiting for model");
  } catch (err) {
    return fail(label, String(err));
  }
}

export interface TtsProvider {
  slug: string;
  authEnv: string[];
  configured(): boolean;
  generate(text: string, dest: string): Promise<GenResult>;
}

export const hfTts: TtsProvider = {
  slug: "huggingface-tts",
  authEnv: ["HUGGINGFACE_API_TOKEN", "HF_TTS_MODEL"],
  configured: () => Boolean(hfToken() && env.hfTtsModel()),
  generate: (text, dest) => hfInferenceToFile(env.hfTtsModel(), { inputs: text, options: { wait_for_model: true } }, dest, "huggingface-tts"),
};

export interface MusicProvider {
  slug: string;
  authEnv: string[];
  configured(): boolean;
  generate(prompt: string, dest: string): Promise<GenResult>;
}

export const hfMusic: MusicProvider = {
  slug: "huggingface-music",
  authEnv: ["HUGGINGFACE_API_TOKEN", "HF_MUSIC_MODEL"],
  configured: () => Boolean(hfToken() && (process.env.HF_MUSIC_MODEL?.trim() || "")),
  generate: (prompt, dest) => hfInferenceToFile(process.env.HF_MUSIC_MODEL!.trim(), { inputs: prompt, options: { wait_for_model: true } }, dest, "huggingface-music"),
};

export const replicateMusic: MusicProvider = {
  slug: "replicate-music",
  authEnv: ["REPLICATE_API_TOKEN", "REPLICATE_MUSIC_MODEL"],
  configured: () => Boolean(env.replicate() && env.replicateMusicModel()),
  async generate(prompt, dest): Promise<GenResult> {
    const headers = { authorization: `Bearer ${env.replicate()}`, "content-type": "application/json", "user-agent": USER_AGENT };
    try {
      const create = await fetch(`https://api.replicate.com/v1/models/${env.replicateMusicModel()}/predictions`, {
        method: "POST", headers, body: JSON.stringify({ input: { prompt } }), signal: AbortSignal.timeout(30_000),
      });
      if (!create.ok) return fail("replicate-music", `create HTTP ${create.status}`);
      let pred = (await create.json()) as { id: string; status: string; output?: string | string[] | null; error?: string | null; urls?: { get?: string } };
      const getUrl = pred.urls?.get ?? `https://api.replicate.com/v1/predictions/${pred.id}`;
      const deadline = Date.now() + 6 * 60_000;
      while (pred.status === "starting" || pred.status === "processing") {
        if (Date.now() > deadline) return fail("replicate-music", "timed out");
        await sleep(3000);
        const p = await fetch(getUrl, { headers, signal: AbortSignal.timeout(30_000) });
        if (!p.ok) return fail("replicate-music", `poll HTTP ${p.status}`);
        pred = (await p.json()) as typeof pred;
      }
      if (pred.status !== "succeeded") return fail("replicate-music", `status ${pred.status}: ${pred.error ?? ""}`);
      const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (!out) return fail("replicate-music", "no audio url");
      await downloadTo(out, dest);
      return ok("replicate-music", env.replicateMusicModel());
    } catch (err) {
      return fail("replicate-music", String(err));
    }
  },
};

interface FreesoundResult {
  results: { id: number; name: string; username: string; license: string; previews: Record<string, string> }[];
}

export const freesound = {
  slug: "freesound",
  authEnv: ["FREESOUND_API_KEY"],
  configured: () => Boolean(env.freesound()),
  async fetch(query: string, dest: string): Promise<GenResult> {
    if (!env.freesound()) return fail("freesound", "not configured");
    try {
      const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}&fields=id,name,username,license,previews&page_size=5&token=${env.freesound()}`;
      const data = await getJson<FreesoundResult>(url);
      const hit = data.results.find((r) => r.previews?.["preview-hq-mp3"]);
      if (!hit) return fail("freesound", "no results");
      await downloadTo(hit.previews["preview-hq-mp3"]!, dest);
      log.info(`Freesound fetched "${hit.name}" by ${hit.username}`);
      return { ok: true, provider: "freesound", license: hit.license, attribution: `"${hit.name}" by ${hit.username} on Freesound` };
    } catch (err) {
      return fail("freesound", String(err));
    }
  },
};

export const TTS_PROVIDERS: TtsProvider[] = [hfTts];
export const MUSIC_PROVIDERS: MusicProvider[] = [replicateMusic, hfMusic];

function ok(provider: string, model: string): GenResult {
  log.info(`${provider} produced audio via ${model}`);
  return { ok: true, provider, license: `per model terms (${model})`, attribution: `Generated via ${provider} model ${model}` };
}
function fail(provider: string, note: string): GenResult {
  if (note !== "not configured") log.warn(`${provider} failed: ${note}`);
  return { ok: false, provider, license: "", attribution: "", note };
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
