/**
 * Consultation orchestrator — the "prompt pre-compiler".
 *
 * Given an asset request, it selects the lead persona for that asset kind, adds
 * any advisors, runs each persona's contribution (a deterministic "debate"), and
 * compiles a single PromptBrief: a rigid positive prompt, a negative prompt, and
 * merged technical parameters (the lead wins on conflicts). The transcript
 * records who said what so the strategy is auditable before anything is generated.
 */
import type {
  AssetKind,
  ConsultationInput,
  DebateTurn,
  Persona,
  PersonaContribution,
  PromptBrief,
} from "./types.js";
import { directorOfPhotography } from "./photographer.js";
import { graphicDesigner } from "./graphic-designer.js";
import { voiceDirector } from "./voice-director.js";
import { musicProducer } from "./music-producer.js";

export const PERSONAS: Persona[] = [
  directorOfPhotography,
  graphicDesigner,
  voiceDirector,
  musicProducer,
];

export function leadFor(assetKind: AssetKind): Persona {
  const lead = PERSONAS.find((p) => p.leads.includes(assetKind));
  if (!lead) throw new Error(`No lead persona defined for asset kind "${assetKind}".`);
  return lead;
}

export function advisorsFor(assetKind: AssetKind, leadId: string): Persona[] {
  return PERSONAS.filter((p) => p.id !== leadId && p.advises.includes(assetKind));
}

/** Run the consultation and compile the brief. Pure + deterministic. */
export function consult(input: ConsultationInput): PromptBrief {
  const style = input.style?.trim() || defaultStyle(input.assetKind);
  const normalized: ConsultationInput = { ...input, style };

  const lead = leadFor(input.assetKind);
  const advisors = advisorsFor(input.assetKind, lead.id);

  const leadContribution = lead.contribute(normalized, "lead");
  const advisorContributions = advisors.map((a) => a.contribute(normalized, "advisor"));
  const all = [leadContribution, ...advisorContributions];

  const positive = dedupe(all.flatMap((c) => c.positive));
  const negative = dedupe(all.flatMap((c) => c.negative));

  // Merge params: advisors first, lead last so the lead overrides conflicts.
  const params: Record<string, unknown> = {};
  for (const c of advisorContributions) Object.assign(params, c.params);
  Object.assign(params, leadContribution.params);

  const transcript: DebateTurn[] = all.flatMap((c) =>
    c.directives.map((statement) => ({ persona: c.persona, role: c.role, statement })),
  );

  return {
    assetKind: input.assetKind,
    subject: input.subject.trim(),
    style,
    leadPersona: lead.id,
    advisors: advisors.map((a) => a.id),
    positivePrompt: compilePositive(input.subject, style, positive),
    negativePrompt: negative.join(", "),
    params,
    transcript,
    compiledAt: new Date().toISOString(),
  };
}

function compilePositive(subject: string, style: string, positive: string[]): string {
  const head = `${subject.trim()}, ${style} style`;
  return positive.length ? `${head} — ${positive.join(", ")}` : head;
}

function defaultStyle(kind: AssetKind): string {
  switch (kind) {
    case "logo":
    case "vector-art":
    case "ui-mockup":
      return "clean minimal";
    case "voiceover":
      return "natural";
    case "soundtrack":
      return "cinematic";
    case "sfx":
      return "high fidelity";
    default:
      return "naturalistic cinematic";
  }
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** Convenience: summarize the transcript as readable lines for tool output. */
export function transcriptLines(brief: PromptBrief): string[] {
  const title: Record<string, string> = {
    "director-of-photography": "DoP",
    "graphic-designer": "Designer",
    "voice-director": "Voice Dir",
    "music-producer": "Producer",
  };
  return brief.transcript.map(
    (t) => `[${title[t.persona] ?? t.persona}${t.role === "lead" ? "*" : ""}] ${t.statement}`,
  );
}
