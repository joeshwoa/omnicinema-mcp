/**
 * Local System Dependency Installer.
 *
 * Detects the host OS and which multimedia tools are present, then — ONLY after
 * explicit consent — installs what's missing (Remotion packages, ffmpeg, Blender)
 * using the platform's own package manager. Nothing is installed silently:
 *   - consent=false  → returns the exact commands it WOULD run plus the required
 *                      permission prompt, and executes nothing.
 *   - consent=true   → runs those commands and reports each result.
 *
 * Caches are pointed at the external volume via an `.npmrc` and dedicated cache
 * directories under CINEMA_ROOT/.cache, so nothing bloats the system drive.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { paths } from "../config.js";
import { run, which } from "../exec.js";
import { log } from "../logger.js";

export const CONSENT_PROMPT =
  "This tool needs to install local video processing dependencies (Remotion CLI, " +
  "Node.js packages, and Blender). Do you grant permission to run the required " +
  "installation commands? [y/N]";

export type Target = "remotion" | "ffmpeg" | "blender";

export interface DetectedSystem {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  managers: Record<string, string | null>;
  tools: Record<string, string | null>;
}

export interface PlannedStep {
  target: Target;
  reason: string;
  cmd: string;
  args: string[];
  note?: string;
}

export async function detectSystem(): Promise<DetectedSystem> {
  const [node, npm, git, ffmpeg, blender, brew, apt, dnf, winget, choco] = await Promise.all([
    which("node"), which("npm"), which("git"), which("ffmpeg"), which("blender"),
    which("brew"), which("apt-get"), which("dnf"), which("winget"), which("choco"),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    managers: { brew, apt, dnf, winget, choco },
    tools: { node, npm, git, ffmpeg, blender },
  };
}

/** The npm cache path + .npmrc location this tool would use (no side effects). */
export function plannedCacheMapping(): { npmrc: string; cacheDir: string } {
  return { npmrc: path.join(paths.repoRoot, ".npmrc"), cacheDir: path.join(paths.cache, "npm") };
}

/** Point npm's cache at the external volume so installs don't fill the system drive. */
export function mapCachesToSsd(): { npmrc: string; cacheDir: string } {
  const npmCache = path.join(paths.cache, "npm");
  const remotionCache = path.join(paths.cache, "remotion");
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(remotionCache, { recursive: true });
  const npmrcPath = path.join(paths.repoRoot, ".npmrc");
  const line = `cache=${npmCache}\n`;
  let existing = "";
  try {
    existing = fs.readFileSync(npmrcPath, "utf8");
  } catch {
    /* none */
  }
  if (!existing.includes("cache=")) {
    fs.writeFileSync(npmrcPath, existing + line, "utf8");
  }
  return { npmrc: npmrcPath, cacheDir: npmCache };
}

export function planInstall(system: DetectedSystem, targets: Target[]): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const target of targets) {
    if (target === "remotion") {
      if (!fs.existsSync(path.join(paths.repoRoot, "node_modules", "remotion"))) {
        steps.push({
          target,
          reason: "Remotion + React render toolchain (optional dependencies).",
          cmd: "npm",
          args: ["install", "--include=optional", "remotion", "react", "react-dom", "@remotion/cli", "@remotion/bundler", "@remotion/renderer"],
        });
      }
      continue;
    }
    if (system.tools[target]) continue; // already installed

    const step = packageManagerStep(system, target);
    if (step) steps.push(step);
    else {
      steps.push({
        target,
        reason: `${target} is missing and no supported package manager was found.`,
        cmd: "echo",
        args: [`Please install ${target} manually for your platform.`],
        note: "manual install required",
      });
    }
  }
  return steps;
}

function packageManagerStep(system: DetectedSystem, target: "ffmpeg" | "blender"): PlannedStep | null {
  const { platform, managers } = system;
  if (platform === "darwin" && managers.brew) {
    return target === "blender"
      ? { target, reason: "Install Blender via Homebrew cask.", cmd: "brew", args: ["install", "--cask", "blender"] }
      : { target, reason: "Install ffmpeg via Homebrew.", cmd: "brew", args: ["install", "ffmpeg"] };
  }
  if (platform === "linux" && managers.apt) {
    return { target, reason: `Install ${target} via apt-get (may require sudo).`, cmd: "sudo", args: ["apt-get", "install", "-y", target], note: "requires sudo privileges" };
  }
  if (platform === "linux" && managers.dnf) {
    return { target, reason: `Install ${target} via dnf (may require sudo).`, cmd: "sudo", args: ["dnf", "install", "-y", target], note: "requires sudo privileges" };
  }
  if (platform === "win32" && managers.winget) {
    const id = target === "blender" ? "BlenderFoundation.Blender" : "Gyan.FFmpeg";
    return { target, reason: `Install ${target} via winget.`, cmd: "winget", args: ["install", "-e", "--id", id] };
  }
  if (platform === "win32" && managers.choco) {
    return { target, reason: `Install ${target} via Chocolatey.`, cmd: "choco", args: ["install", "-y", target] };
  }
  return null;
}

export interface InstallReport {
  executed: boolean;
  consentPrompt: string;
  system: DetectedSystem;
  cacheMapping: { npmrc: string; cacheDir: string };
  plannedCommands: string[];
  results?: { step: string; code: number | null; ok: boolean; tail: string }[];
}

export async function installDependencies(opts: {
  consent: boolean;
  targets?: Target[];
}): Promise<InstallReport> {
  const targets = opts.targets?.length ? opts.targets : (["remotion", "ffmpeg", "blender"] as Target[]);
  const system = await detectSystem();
  const plan = planInstall(system, targets);
  const plannedCommands = plan.map((s) => `${s.cmd} ${s.args.join(" ")}${s.note ? `   # ${s.note}` : ""}`);

  if (!opts.consent) {
    // Preview only — do not touch the filesystem.
    return { executed: false, consentPrompt: CONSENT_PROMPT, system, cacheMapping: plannedCacheMapping(), plannedCommands };
  }

  // Consent granted: now it is safe to write the cache mapping and install.
  const cacheMapping = mapCachesToSsd();

  const results: NonNullable<InstallReport["results"]> = [];
  for (const step of plan) {
    if (step.note === "manual install required") {
      results.push({ step: `${step.cmd} ${step.args.join(" ")}`, code: null, ok: false, tail: step.note });
      continue;
    }
    log.info(`Installing ${step.target}: ${step.cmd} ${step.args.join(" ")}`);
    const res = await run(step.cmd, step.args, paths.repoRoot, 30 * 60_000);
    results.push({
      step: `${step.cmd} ${step.args.join(" ")}`,
      code: res.code,
      ok: res.code === 0,
      tail: (res.stderr || res.stdout).split("\n").slice(-8).join("\n"),
    });
  }
  return { executed: true, consentPrompt: CONSENT_PROMPT, system, cacheMapping, plannedCommands, results };
}
