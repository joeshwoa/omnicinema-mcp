/**
 * Screenplay engine quality: concept parsing, one coherent lighting look, story
 * arc, film grammar, camera moves that match the framing change, and headings
 * built from real places (not random prompt words).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildScreenplay, chooseLook, parseConcept, verifyContinuity } from "../src/pipeline/script-engine.js";

const base = { fps: 24, width: 1280, height: 720 };

test("concept parsing finds subject, action, setting and element", () => {
  const c = parseConcept("a lone lighthouse keeper watching a storm roll in over a cold northern sea");
  assert.equal(c.subject, "lone lighthouse keeper");
  assert.equal(c.head, "keeper");
  assert.equal(c.setting, "cold northern sea");
  assert.equal(c.element, "storm");
  assert.equal(c.place, "lighthouse");
  assert.equal(c.isPerson, true);
  const shop = parseConcept("a barista opening a tiny coffee shop at dawn");
  assert.equal(shop.setting, "tiny coffee shop", "place-like object becomes the setting");
  const city = parseConcept("Make a short film about a neon city at night");
  assert.equal(city.subject, "neon city");
  assert.equal(city.isPerson, false);
  assert.ok(!city.keywords.includes("film"), "filler words are stripped");
});

test("one lighting look per film, chosen from the prompt", () => {
  assert.equal(chooseLook("a storm over the sea", ""), "storm");
  assert.equal(chooseLook("neon city", ""), "neon");
  assert.equal(chooseLook("coffee shop at dawn", ""), "dawn");
  assert.equal(chooseLook("detective story", "noir"), "noir");
  assert.equal(chooseLook("a product demo", ""), "cinematic");
});

test("storm film: dusk → storm night → dawn; EXT sea / INT lighthouse; arc beats", () => {
  const sp = buildScreenplay({ ...base, prompt: "a lone lighthouse keeper watching a storm roll in over a cold northern sea", sceneCount: 3, shotsPerScene: 3 });
  assert.equal(verifyContinuity(sp).length, 0);
  assert.deepEqual(sp.scenes.map((s) => s.beat), ["setup", "climax", "resolution"]);
  assert.match(sp.scenes[0]!.heading, /^EXT\. COLD NORTHERN SEA — DUSK$/);
  assert.match(sp.scenes[1]!.heading, /^INT\. LIGHTHOUSE — NIGHT$/);
  assert.match(sp.scenes[2]!.heading, /DAWN$/);
  const all = sp.scenes.flatMap((s) => s.shots);
  assert.ok(all.every((s) => !/magenta|neon/i.test(s.closingFrame.lighting)), "no off-look lighting");
  assert.ok(all.some((s) => /storm/i.test(s.action)), "the story element drives the action");
});

test("film grammar: establishing → … → close, and camera moves match the framing change", () => {
  const sp = buildScreenplay({ ...base, prompt: "a detective walking through a rainy city at night", sceneCount: 4, shotsPerScene: 3 });
  for (const scene of sp.scenes) {
    const types = scene.shots.map((s) => s.shotType);
    assert.ok(types[0] === "establishing" || types[0] === "wide", `${scene.id} opens wide`);
    assert.ok(["close", "detail"].includes(types[types.length - 1]!), `${scene.id} ends close`);
  }
  const order = ["extreme wide", "wide establishing", "medium wide", "medium", "over-the-shoulder", "medium close-up", "close-up", "extreme close-up"];
  for (const shot of sp.scenes.flatMap((s) => s.shots)) {
    const d = order.indexOf(shot.closingFrame.framing) - order.indexOf(shot.openingFrame.framing);
    if (d > 0) assert.match(shot.cameraMovement, /push/, `${shot.id}: tighter framing needs a push-in`);
    if (d < 0) assert.match(shot.cameraMovement, /pull|crane/, `${shot.id}: looser framing needs a pull/crane`);
  }
});

test("screen direction is held for the whole film (180° rule)", () => {
  const sp = buildScreenplay({ ...base, prompt: "a runner crossing a desert at sunset", sceneCount: 3, shotsPerScene: 3 });
  const sides = new Set(sp.scenes.flatMap((s) => s.shots).map((s) => /left third/.test(s.closingFrame.subjectPosition) ? "L" : /right third/.test(s.closingFrame.subjectPosition) ? "R" : "C"));
  sides.delete("C");
  assert.equal(sides.size, 1);
});

test("non-person subjects get object phrasing (no 'small figure', no 'breath')", () => {
  const sp = buildScreenplay({ ...base, prompt: "neon city at night", sceneCount: 3, shotsPerScene: 3 });
  const text = sp.scenes.flatMap((s) => s.shots).map((s) => s.action).join(" ");
  assert.ok(!/small figure|long breath|holds their ground/.test(text), text);
});

test("asset queries are short and specific", () => {
  const sp = buildScreenplay({ ...base, prompt: "a lone lighthouse keeper watching a storm roll in over a cold northern sea", sceneCount: 3, shotsPerScene: 2 });
  for (const s of sp.scenes.flatMap((x) => x.shots)) {
    const words = s.assetQuery.split(" ");
    assert.ok(words.length >= 1 && words.length <= 4, s.assetQuery);
    assert.ok(!/\b(lone|watching|roll)\b/.test(s.assetQuery), `query should not contain filler: ${s.assetQuery}`);
  }
});

test("setting stops at the next verb: a location mid-sentence is not swallowed", () => {
  const c = parseConcept("a street food vendor in Cairo opening his cart at dawn");
  assert.equal(c.subject, "street food vendor");
  assert.equal(c.setting, "Cairo", "proper noun keeps its casing");
  const sp = buildScreenplay({ prompt: "a street food vendor in Cairo opening his cart at dawn", sceneCount: 3 });
  for (const sc of sp.scenes) assert.doesNotMatch(sc.heading, /OPENING HIS CART/, sc.heading);
});

test("proper-noun settings read naturally in shot lines", () => {
  const sp = buildScreenplay({ prompt: "a street food vendor in Cairo opening his cart at dawn", sceneCount: 3 });
  const text = sp.scenes.flatMap((s) => s.shots.map((x) => x.action)).join(" ");
  assert.match(text, /Cairo/, "the setting appears in the shot lines");
  assert.doesNotMatch(text, /the cairo/i);
});
