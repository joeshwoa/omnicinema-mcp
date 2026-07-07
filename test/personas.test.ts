/**
 * Persona consultation tests: lead selection, conflict resolution, determinism,
 * and music arrangement planning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { consult, leadFor } from "../src/personas/consultation.js";
import { planMusic, detectGenre } from "../src/personas/music-producer.js";

test("logo is led by the graphic designer with vector positives and photo negatives", () => {
  const brief = consult({ assetKind: "logo", subject: "Nova Labs", style: "vibrant" });
  assert.equal(brief.leadPersona, "graphic-designer");
  assert.ok(brief.positivePrompt.toLowerCase().includes("flat vector"), "logo prompt should be vector");
  assert.ok(brief.negativePrompt.toLowerCase().includes("photorealistic"), "logo should exclude photorealism");
  assert.equal(brief.params.transparentBackground, true);
});

test("cinematic photo is led by the DoP with a lens + volumetric lighting", () => {
  const brief = consult({ assetKind: "cinematic-photo", subject: "a wolf on a ridge", style: "noir" });
  assert.equal(brief.leadPersona, "director-of-photography");
  assert.match(brief.positivePrompt, /lens/i);
  assert.match(brief.positivePrompt, /volumetric lighting/i);
});

test("soundtrack is led by the music producer with the voice director advising", () => {
  const brief = consult({ assetKind: "soundtrack", subject: "rainy city", style: "hip hop" });
  assert.equal(brief.leadPersona, "music-producer");
  assert.ok(brief.advisors.includes("voice-director"), "voice director should advise on ducking");
  // Advisor ducking directive should appear in the transcript.
  assert.ok(brief.transcript.some((t) => /duck/i.test(t.statement)), "transcript should mention ducking");
});

test("every asset kind resolves a lead persona", () => {
  for (const kind of ["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup", "voiceover", "soundtrack", "sfx"] as const) {
    assert.doesNotThrow(() => leadFor(kind), `lead missing for ${kind}`);
  }
});

test("consultation is deterministic", () => {
  const a = consult({ assetKind: "texture", subject: "cracked desert clay", style: "golden" });
  const b = consult({ assetKind: "texture", subject: "cracked desert clay", style: "golden" });
  assert.equal(a.positivePrompt, b.positivePrompt);
  assert.equal(a.negativePrompt, b.negativePrompt);
});

test("music genre routing picks sane BPM/key per genre", () => {
  assert.equal(detectGenre({ assetKind: "soundtrack", subject: "x", style: "hip hop" }).genre, "hip-hop");
  const edm = planMusic({ assetKind: "soundtrack", subject: "club night", style: "edm" });
  assert.equal(edm.genre, "electronic");
  assert.ok(edm.bpm >= 120 && edm.bpm <= 130, "EDM tempo range");
  assert.ok(edm.structure.some((s) => s.name === "drop"), "EDM should have a drop");
  const orch = planMusic({ assetKind: "soundtrack", subject: "epic trailer", style: "cinematic orchestral" });
  assert.equal(orch.genre, "cinematic-orchestral");
  assert.ok(orch.instruments.some((i) => /strings/i.test(i)));
});
