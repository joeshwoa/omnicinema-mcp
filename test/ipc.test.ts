/**
 * IPC protocol tests: localhost server, bearer-token auth, schema contract, and
 * an offline asset request over HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CinemaIpcServer } from "../src/api/ipc-protocol.js";

test("IPC server enforces auth, serves schema, and generates offline over HTTP", async () => {
  const srv = new CinemaIpcServer();
  const info = await srv.start(0); // ephemeral port
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const auth = { authorization: `Bearer ${info.token}` };

    // Health is unauthenticated.
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);

    // Schema requires auth.
    assert.equal((await fetch(`${base}/schema`)).status, 401, "no token → 401");
    assert.equal((await fetch(`${base}/schema`, { headers: { authorization: "Bearer nope" } })).status, 401, "bad token → 401");

    const schemaRes = await fetch(`${base}/schema`, { headers: auth });
    assert.equal(schemaRes.status, 200);
    const schema = await schemaRes.json();
    assert.ok(Array.isArray(schema.assetKinds) && schema.assetKinds.length >= 8);
    assert.ok(schema.personas.some((p: { id: string }) => p.id === "music-producer"));

    // Generate a logo via the API (offline, deterministic).
    const imgRes = await fetch(`${base}/assets/image`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ assetKind: "logo", subject: "IPC Test", style: "mono" }),
    });
    assert.equal(imgRes.status, 200);
    const asset = await imgRes.json();
    assert.equal(asset.format, "svg");
    assert.equal(asset.brief.leadPersona, "graphic-designer");

    // Unknown route → 404.
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
  } finally {
    await srv.stop();
  }
});

test("IPC /generate returns asset bytes for companion tools (devuniverse bridge)", async () => {
  const srv = new CinemaIpcServer();
  const info = await srv.start(0);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { authorization: `Bearer ${info.token}`, "content-type": "application/json" };
    const post = (body: unknown) => fetch(`${base}/generate`, { method: "POST", headers, body: JSON.stringify(body) });

    assert.equal((await fetch(`${base}/generate`, { method: "POST", body: "{}" })).status, 401, "needs the token");
    assert.equal((await post({ type: "image" })).status, 400, "prompt required");
    assert.equal((await post({ type: "video", prompt: "a storm" })).status, 501, "video is not served, honestly");
    assert.equal((await post({ type: "hologram", prompt: "x" })).status, 400);

    const img = await post({ type: "image", prompt: "calm mountain lake at dawn" });
    assert.equal(img.status, 200);
    const ct = img.headers.get("content-type") ?? "";
    assert.ok(ct === "image/png" || ct === "image/svg+xml", `image content-type, got ${ct}`);
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.ok(bytes.length > 500, "real bytes, not a JSON pointer");
    if (ct === "image/png") assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    else assert.match(bytes.toString("utf8", 0, 200), /<svg|<\?xml/);
    assert.equal(img.headers.get("x-omnicinema-source"), "offline");

    const sfx = await post({ type: "audio", audioType: "sfx", prompt: "soft click" });
    assert.equal(sfx.status, 200);
    assert.equal(sfx.headers.get("content-type"), "audio/wav");
    const wav = Buffer.from(await sfx.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  } finally {
    await srv.stop();
  }
});
