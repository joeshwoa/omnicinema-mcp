/**
 * Shared child-process helpers. Never runs a shell string; always argv arrays,
 * so there is no shell-injection surface.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: stderr + "\n[timed out]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err) });
    });
  });
}

/** Resolve whether a command exists on PATH (via `which`/`where`). */
export async function which(bin: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await run(finder, [bin], process.cwd(), 10_000);
  if (res.code === 0) {
    const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first ?? null;
  }
  return null;
}
