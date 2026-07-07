/**
 * Free Limit Manager & Budget Guard.
 *
 * Persists per-provider usage to data/usage-limits.json with daily / weekly /
 * monthly windows that roll over automatically. Before any generative call, the
 * engines consult `consume()`: if a request would exceed a free quota OR nearly
 * exhaust the daily allowance, the guard HALTS and returns an analytical cost
 * breakdown that requires explicit user approval to proceed.
 *
 * Quotas are conservative defaults meant purely as guard rails; override any of
 * them with env vars like LIMIT_HUGGINGFACE_DAILY=250.
 */
import fs from "node:fs";
import path from "node:path";
import { env, paths } from "../config.js";
import { log } from "../logger.js";

export type Period = "daily" | "weekly" | "monthly";

export interface UsageRecord {
  used: number;
  /** The window key this count belongs to; a change triggers a reset. */
  windowKey: string;
}

export interface ProviderUsage {
  daily: UsageRecord;
  weekly: UsageRecord;
  monthly: UsageRecord;
}

export interface UsageDb {
  version: number;
  updatedAt: string;
  providers: Record<string, ProviderUsage>;
}

export interface PeriodBreakdown {
  period: Period;
  limit: number;
  used: number;
  remaining: number;
  afterUsed: number;
  afterRemaining: number;
  windowKey: string;
  wouldExceed: boolean;
}

export interface BudgetDecision {
  provider: string;
  units: number;
  allowed: boolean;
  requiresApproval: boolean;
  tightestPeriod: Period;
  breakdown: PeriodBreakdown[];
  message: string;
}

export interface ConsumeResult {
  proceeded: boolean;
  decision: BudgetDecision;
  status?: ProviderStatus;
}

export interface ProviderStatus {
  provider: string;
  periods: Record<Period, { used: number; limit: number; remaining: number; windowKey: string }>;
}

const DEFAULT_QUOTAS: Record<string, Record<Period, number>> = {
  huggingface: { daily: 100, weekly: 500, monthly: 1500 },
  replicate: { daily: 50, weekly: 200, monthly: 500 },
  fal: { daily: 50, weekly: 200, monthly: 500 },
  pexels: { daily: 200, weekly: 1000, monthly: 4000 },
  pixabay: { daily: 500, weekly: 2500, monthly: 10000 },
  unsplash: { daily: 50, weekly: 300, monthly: 1000 },
  freesound: { daily: 60, weekly: 300, monthly: 1000 },
};
const GENERIC_QUOTA: Record<Period, number> = { daily: 50, weekly: 200, monthly: 500 };

/** Percentage of the daily quota that, if left or less, flags "near exhaustion". */
const NEAR_EXHAUSTION_FRACTION = 0.1;

export function periodKeys(now: Date = new Date()): Record<Period, string> {
  const iso = now.toISOString();
  return {
    daily: iso.slice(0, 10), // YYYY-MM-DD
    weekly: mondayKey(now), // YYYY-MM-DD of the week's Monday (UTC)
    monthly: iso.slice(0, 7), // YYYY-MM
  };
}

function mondayKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

export function quotaFor(provider: string, period: Period): number {
  const override = env.quota(provider, period.toUpperCase() as "DAILY" | "WEEKLY" | "MONTHLY");
  if (override !== null) return override;
  return DEFAULT_QUOTAS[provider]?.[period] ?? GENERIC_QUOTA[period];
}

export function loadDb(): UsageDb {
  try {
    return JSON.parse(fs.readFileSync(paths.usageLimits, "utf8")) as UsageDb;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), providers: {} };
  }
}

export function saveDb(db: UsageDb): void {
  db.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(paths.usageLimits), { recursive: true });
  fs.writeFileSync(paths.usageLimits, JSON.stringify(db, null, 2), "utf8");
}

function freshUsage(keys: Record<Period, string>): ProviderUsage {
  return {
    daily: { used: 0, windowKey: keys.daily },
    weekly: { used: 0, windowKey: keys.weekly },
    monthly: { used: 0, windowKey: keys.monthly },
  };
}

/** Roll a provider's records forward to the current windows (resetting expired). */
function rolled(usage: ProviderUsage | undefined, keys: Record<Period, string>): ProviderUsage {
  const base = usage ?? freshUsage(keys);
  const out = structuredClone(base);
  for (const period of ["daily", "weekly", "monthly"] as Period[]) {
    if (out[period].windowKey !== keys[period]) {
      out[period] = { used: 0, windowKey: keys[period] };
    }
  }
  return out;
}

export function getStatus(provider: string, now: Date = new Date()): ProviderStatus {
  const keys = periodKeys(now);
  const usage = rolled(loadDb().providers[provider], keys);
  const periods = {} as ProviderStatus["periods"];
  for (const period of ["daily", "weekly", "monthly"] as Period[]) {
    const limit = quotaFor(provider, period);
    periods[period] = {
      used: usage[period].used,
      limit,
      remaining: Math.max(0, limit - usage[period].used),
      windowKey: usage[period].windowKey,
    };
  }
  return { provider, periods };
}

/** Evaluate a prospective request without recording it. */
export function checkBudget(provider: string, units = 1, now: Date = new Date()): BudgetDecision {
  const keys = periodKeys(now);
  const usage = rolled(loadDb().providers[provider], keys);

  const breakdown: PeriodBreakdown[] = (["daily", "weekly", "monthly"] as Period[]).map((period) => {
    const limit = quotaFor(provider, period);
    const used = usage[period].used;
    const afterUsed = used + units;
    return {
      period,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      afterUsed,
      afterRemaining: Math.max(0, limit - afterUsed),
      windowKey: usage[period].windowKey,
      wouldExceed: afterUsed > limit,
    };
  });

  const daily = breakdown[0]!;
  const wouldExceed = breakdown.some((b) => b.wouldExceed);
  const nearExhaustion = daily.afterRemaining <= Math.ceil(daily.limit * NEAR_EXHAUSTION_FRACTION);
  const requiresApproval = wouldExceed || nearExhaustion;

  const tightest = [...breakdown].sort(
    (a, b) => a.afterRemaining / a.limit - b.afterRemaining / b.limit,
  )[0]!;

  const message = wouldExceed
    ? `Request of ${units} unit(s) would EXCEED the ${tightest.period} free quota for "${provider}" (${tightest.afterUsed}/${tightest.limit}).`
    : requiresApproval
      ? `Request of ${units} unit(s) would nearly exhaust the daily quota for "${provider}" (${daily.afterRemaining} left of ${daily.limit}).`
      : `Within budget for "${provider}" (${daily.afterUsed}/${daily.limit} daily).`;

  return {
    provider,
    units,
    allowed: !requiresApproval,
    requiresApproval,
    tightestPeriod: tightest.period,
    breakdown,
    message,
  };
}

/** Record usage against every period window. */
export function recordUsage(provider: string, units = 1, now: Date = new Date()): ProviderStatus {
  const keys = periodKeys(now);
  const db = loadDb();
  const usage = rolled(db.providers[provider], keys);
  for (const period of ["daily", "weekly", "monthly"] as Period[]) {
    usage[period].used += units;
  }
  db.providers[provider] = usage;
  saveDb(db);
  return getStatus(provider, now);
}

/**
 * The budget GATE. If the request needs approval and `approved` is false, HALTS
 * (records nothing) and returns the breakdown so the caller can ask the user.
 * Otherwise records the usage and reports the updated status.
 */
export function consume(
  provider: string,
  units: number,
  approved: boolean,
  now: Date = new Date(),
): ConsumeResult {
  const decision = checkBudget(provider, units, now);
  if (decision.requiresApproval && !approved) {
    log.warn(`Budget gate HALTED ${provider} (${units}u): ${decision.message}`);
    return { proceeded: false, decision };
  }
  const status = recordUsage(provider, units, now);
  return { proceeded: true, decision, status };
}

/** Render a decision's breakdown as human-readable lines. */
export function breakdownLines(decision: BudgetDecision): string[] {
  return decision.breakdown.map(
    (b) =>
      `${b.period.padEnd(7)} ${b.used}/${b.limit} used · after: ${b.afterUsed}/${b.limit}` +
      ` (${b.afterRemaining} left)${b.wouldExceed ? "  ⚠ EXCEEDS" : ""}`,
  );
}
