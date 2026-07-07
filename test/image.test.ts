/**
 * Image engine tests: offline vector/design generation (logo/vector/ui) and the
 * photoreal placeholder fallback, each carrying its compiled persona brief.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateImageAsset } from "../src/pipeline/image-engine.js";
import { isHalt } from "../src/pipeline/asset-results.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-image-"));

test("logo renders a real, valid SVG offline led by the graphic designer", async () => {
  const r = await generateImageAsset({ assetKind: "logo", subject: "Nova Labs", style: "vibrant", outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  assert.equal(r.provider, "offline-svg");
  assert.equal(r.format, "svg");
  assert.equal(r.brief.leadPersona, "graphic-designer");
  const svg = fs.readFileSync(r.path, "utf8");
  assert.match(svg, /<svg[\s>]/, "is an SVG");
  assert.match(svg, /<\/svg>/, "well-formed");
});

test("vector-art and ui-mockup also produce valid SVGs", async () => {
  for (const kind of ["vector-art", "ui-mockup"] as const) {
    const r = await generateImageAsset({ assetKind: kind, subject: "control center", style: "mono", outDir: tmp });
    assert.ok(!isHalt(r));
    if (isHalt(r)) continue;
    assert.equal(r.format, "svg");
    assert.ok(fs.existsSync(r.path));
    assert.match(fs.readFileSync(r.path, "utf8"), /<svg[\s>]/);
  }
});

test("cinematic photo without a provider falls back to a local placeholder", async () => {
  // Ensure no image provider is configured.
  delete process.env.HF_IMAGE_MODEL;
  delete process.env.REPLICATE_IMAGE_MODEL;
  const r = await generateImageAsset({ assetKind: "cinematic-photo", subject: "a lighthouse in a storm", style: "noir", generative: true, outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  assert.equal(r.source, "offline");
  assert.equal(r.brief.leadPersona, "director-of-photography");
  assert.ok(r.warnings.some((w) => /no image provider/i.test(w)));
});
