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
