/**
 * Result types returned by the image and audio engines. Comprehensive on
 * purpose: every generated asset carries the compiled persona brief, provenance,
 * licensing, and (for audio) precise millisecond duration so the master sequencer
 * can lock tracks together.
 */
import type { PromptBrief } from "../personas/types.js";
import type { BudgetDecision } from "../limits/limit-manager.js";

export interface GeneratedAsset {
  /** The persona asset kind (e.g. "cinematic-photo", "soundtrack"). */
  kind: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the output/assets root. */
  relPath: string;
  /** File format, e.g. "png", "svg", "wav", "mid". */
  format: string;
  /** Which provider produced it, e.g. "replicate-image", "offline-svg". */
  provider: string;
  source: "generative" | "offline";
  license: string;
  attribution: string;
  /** The compiled prompt strategy (for transparency / reproducibility). */
  brief: PromptBrief;
  width?: number;
  height?: number;
  /** Precise audio duration in milliseconds (audio assets only). */
  durationMs?: number;
  warnings: string[];
  meta?: Record<string, unknown>;
}

/**
 * Returned when the budget guard halts a request. The caller (or the user) must
 * re-issue the request with approval to proceed.
 */
export interface BudgetHalt {
  halted: true;
  reason: string;
  decision: BudgetDecision;
  /** Human-readable cost breakdown lines. */
  breakdown: string[];
  /** The compiled brief, so no work is lost if the user approves. */
  brief: PromptBrief;
}

export type EngineResult = GeneratedAsset | BudgetHalt;

export function isHalt(r: EngineResult): r is BudgetHalt {
  return (r as BudgetHalt).halted === true;
}
