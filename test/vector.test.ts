/**
 * Offline SVG designer: valid, deterministic, brief-driven output for logos,
 * vector art, UI mockups, photo placeholders and storyboard frames.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  brandName, generateLogoSvg, generateStoryboardFrameSvg, generateUiMockupSvg, generateVectorArtSvg,
  generatePhotoPlaceholderSvg, logoSvgs, vectorArtSvg,
} from "../src/assets/vector.js";
import { appName, chooseScreen, uiMockupSvg } from "../src/assets/ui-mockup.js";
import { contrast, designPalette, fitFontSize, textWidth, wrapText } from "../src/assets/svg-kit.js";
import { generateImageAsset } from "../src/pipeline/image-engine.js";
import { isHalt } from "../src/pipeline/asset-results.js";
import { assertWellFormedXml, rsvgRender } from "./helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-vector-"));
const VIBRANT = ["#7c3aed", "#ec4899", "#22d3ee"];

test("brand names are extracted from free text", () => {
  assert.deepEqual(brandName("Nova Labs"), { name: "Nova Labs", tagline: "" });
  assert.equal(brandName("Bean There: specialty coffee roasters").tagline, "Specialty Coffee Roasters");
  assert.equal(brandName('a logo for a bakery called "Crumb & Co"').name, "Crumb & Co");
  assert.equal(brandName("logo for a startup named Orbitly").name, "Orbitly");
});

test("logo: main + reversed + icon variants, transparent, well-formed, deterministic", () => {
  const dest = path.join(tmp, "nova_logo.svg");
  const res = generateLogoSvg("Nova Labs", VIBRANT, dest, { style: "vibrant" });
  for (const f of [dest, res.variants!.reversed!, res.variants!.icon!]) {
    const svg = fs.readFileSync(f, "utf8");
    assertWellFormedXml(svg, path.basename(f));
    assert.match(svg, /<title>/, "accessible title");
    // Transparent: no full-canvas background rect.
    assert.ok(!/<rect width="\d+" height="\d+" fill=/.test(svg), `${path.basename(f)} must not paint a background`);
  }
  const again = logoSvgs("Nova Labs", VIBRANT, { style: "vibrant" });
  assert.equal(again.main, fs.readFileSync(dest, "utf8"), "same input → identical SVG");
  assert.ok(res.notes!.some((x) => x === "mark=orbit"), "space-y name picks the orbit mark");
});

test("logo layout follows style words and the brand name fits the safe area", () => {
  const cases: [string, string, string][] = [
    ["Greenleaf", "monogram", "layout=monogram"],
    ["Pixel Forge", "wordmark", "layout=wordmark"],
    ["Voltline", "horizontal", "layout=horizontal"],
    ["Summit Capital", "luxury emblem", "layout=emblem"],
  ];
  for (const [name, style, expected] of cases) {
    const out = logoSvgs(name, undefined, { style });
    assert.ok(out.notes.includes(expected), `${name}/${style} → ${out.notes.join(",")}`);
    assertWellFormedXml(out.main, name);
    // Every text element's estimated width stays within the canvas margins.
    for (const m of out.main.matchAll(/<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)</g)) {
      const w = textWidth(m[4]!.replace(/&amp;/g, "&"), Number(m[2]), { bold: true, safety: 1.0 });
      assert.ok(w <= out.width * 0.95, `${name}: "${m[4]}" too wide (${w.toFixed(0)} of ${out.width})`);
    }
  }
  assert.ok(logoSvgs("Voltline", undefined, {}).notes.includes("mark=bolt"), "compound names match keyword stems");
});

test("vector art picks a template from the subject and renders layered shapes", () => {
  const expect: [string, string][] = [
    ["a lighthouse on a stormy coast", "sea"], ["mountain sunset", "landscape"], ["neon city at night", "city"],
    ["rocket to a distant planet", "space"], ["pine forest camp", "forest"], ["control center", "network"], ["harmony", "abstract"],
  ];
  for (const [subject, template] of expect) {
    const out = vectorArtSvg(subject, VIBRANT, { style: "vibrant" });
    assert.equal(out.template, template, subject);
    assertWellFormedXml(out.svg, subject);
    assert.ok((out.svg.match(/<(path|rect|circle|polygon|ellipse)\b/g) ?? []).length > 12, `${subject}: layered composition`);
  }
  const dest = path.join(tmp, "art.svg");
  const r = generateVectorArtSvg("mountain sunset", VIBRANT, dest, { aspectRatio: "16:9" });
  assert.equal(r.width / r.height > 1.7, true, "honors aspect ratio");
});

test("UI mockups: screen routing, app names, device frames", () => {
  assert.equal(chooseScreen("control center"), "dashboard");
  assert.equal(chooseScreen("SaaS landing page for Orbit"), "landing");
  assert.equal(chooseScreen("login screen for Acme"), "auth");
  assert.equal(chooseScreen("fashion store"), "store");
  assert.equal(chooseScreen("team chat app"), "chat");
  assert.equal(chooseScreen("fitness mobile app"), "mobile");
  assert.equal(chooseScreen("fitness dashboard"), "dashboard");
  assert.equal(appName("SaaS landing page for Orbit"), "Orbit");
  assert.equal(appName("team chat app for Relay"), "Relay");
  for (const s of ["control center", "SaaS landing page for Orbit", "login screen for Acme", "fashion store", "team chat app", "music player app"]) {
    const ui = uiMockupSvg(s, VIBRANT, { style: "vibrant" });
    assertWellFormedXml(ui.svg, s);
    assert.ok(ui.svg.includes(ui.device === "phone" ? "9:41" : "#ff5f57"), `${s}: has a ${ui.device} frame`);
  }
  const r = generateUiMockupSvg("control center", undefined, path.join(tmp, "ui.svg"));
  assert.equal(r.width, 1600);
  assert.equal(r.height, 1000);
});

test("photo placeholder and storyboard frame are labelled and well-formed", () => {
  const p = path.join(tmp, "photo.svg");
  generatePhotoPlaceholderSvg("A wolf & a ridge <night>", undefined, p, 1280, 720);
  const svg = fs.readFileSync(p, "utf8");
  assertWellFormedXml(svg, "photo");
  assert.match(svg, /PHOTO PLACEHOLDER/);
  assert.match(svg, /Wolf &amp; A Ridge/, "subject is escaped");
  const sb = path.join(tmp, "sb.svg");
  generateStoryboardFrameSvg({
    filmTitle: "Test", sceneHeading: "EXT. SEA — DUSK", shotId: "scene-1-shot-1", shotNumber: 1, shotCount: 4,
    action: "Wide on the sea; the keeper is a small figure.", framing: "wide establishing", cameraMovement: "slow push-in",
    lighting: "dusk", subjectPosition: "on the left third", palette: ["#0b1f3a", "#1e6091", "#e0fbfc"], durationSeconds: 4,
    keywords: ["lighthouse", "sea"],
  }, sb, 1920, 1080);
  const sbs = fs.readFileSync(sb, "utf8");
  assertWellFormedXml(sbs, "storyboard");
  assert.match(sbs, /SHOT 1\/4/);
});

test("rendered SVGs are valid for librsvg (skips if rsvg-convert is absent)", (t) => {
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".svg"));
  let rendered = 0;
  for (const f of files) {
    const size = rsvgRender(path.join(tmp, f), path.join(tmp, `${f}.png`));
    if (size === null) return t.skip("rsvg-convert not installed");
    assert.ok(size > 500, `${f} rendered to a non-trivial PNG`);
    rendered++;
  }
  assert.ok(rendered >= 5);
});

test("image engine passes the brief's style and exports PNG when a rasterizer exists", async () => {
  const r = await generateImageAsset({ assetKind: "logo", subject: "Pixel Forge", style: "wordmark playful", outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  const meta = r.meta as { design: string[]; variants: Record<string, string>; pngPath?: string };
  assert.ok(meta.design.includes("layout=wordmark"));
  assert.ok(fs.existsSync(meta.variants.reversed!) && fs.existsSync(meta.variants.icon!));
  if (meta.pngPath) assert.equal(fs.readFileSync(meta.pngPath).subarray(1, 4).toString(), "PNG");
  else assert.ok(r.warnings.some((w) => /rasterizer/.test(w)), "missing rasterizer is reported");
});

test("palette roles respect persona order and text helpers behave", () => {
  const p = designPalette(VIBRANT);
  assert.equal(p.primary, "#7c3aed", "first brand color leads");
  assert.ok(contrast(p.ink, "#ffffff") > 7, "ink is readable on white");
  const mono = designPalette(["#111827", "#6b7280", "#f9fafb"]);
  assert.equal(mono.mono, true);
  assert.ok(fitFontSize("A very long brand name indeed", 300, 120, { bold: true }) < 120);
  const lines = wrapText("one two three four five six seven eight nine ten", 20, 120, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /…$/);
});
