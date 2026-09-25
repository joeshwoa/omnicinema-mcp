/**
 * MCP surface: every tool is registered with a usable description, and tool
 * results end with files/next steps. Uses the SDK's in-memory transport (the
 * stdio path is exercised by the manual verification client).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { paths } from "../src/config.js";

async function connect(): Promise<Client> {
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  return (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

test("all 15 tools are registered with when-to-use descriptions", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "approve_suggestion", "check_limits", "compile_montage", "consult_personas", "discover_providers",
    "generate_image", "generate_sfx", "generate_soundtrack", "generate_voiceover", "install_dependencies",
    "ipc_start", "ipc_status", "ipc_stop", "list_providers", "run_cinema_pipeline",
  ]);
  for (const t of tools) assert.match(t.description ?? "", /^Use /, `${t.name} says when to use it`);
  const run = tools.find((t) => t.name === "run_cinema_pipeline")!;
  assert.ok("dry_run" in (run.inputSchema.properties ?? {}), "dry_run is exposed");
  await client.close();
});

test("run_cinema_pipeline dry_run returns a plan and writes nothing", async () => {
  const client = await connect();
  const before = fs.existsSync(paths.projects) ? fs.readdirSync(paths.projects).length : 0;
  const r = await client.callTool({ name: "run_cinema_pipeline", arguments: { prompt: "a fox crossing a snowy forest at dawn", dry_run: true, sceneCount: 2, shotsPerScene: 2, generative: true } });
  const t = text(r);
  assert.ok(!r.isError, t);
  assert.match(t, /DRY RUN/);
  assert.match(t, /Spend:/);
  assert.match(t, /Next steps:/);
  assert.match(t, /requested but not configured/, "reports that generative is not configured");
  const after = fs.existsSync(paths.projects) ? fs.readdirSync(paths.projects).length : 0;
  assert.equal(after, before, "no project directory created");
  await client.close();
});

test("generate_image result lists files and next steps; errors are structured", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "generate_image", arguments: { assetKind: "logo", subject: "Server Test", style: "mono" } });
  const t = text(r);
  assert.match(t, /Files:\n- .*server-test_logo\.svg/);
  assert.match(t, /-reversed\.svg/);
  assert.match(t, /Next steps:/);
  const bad = await client.callTool({ name: "compile_montage", arguments: { projectId: "nope" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Next steps:/);
  const esc = await client.callTool({ name: "compile_montage", arguments: { projectId: "../../etc" } });
  assert.equal(esc.isError, true, "path traversal in projectId is rejected");
  await client.close();
});

test("install_dependencies without consent installs nothing and says so", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "install_dependencies", arguments: { consent: false } });
  assert.match(text(r), /Nothing installed \(consent:false\)/);
  await client.close();
});
