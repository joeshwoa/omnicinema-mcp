/**
 * Budget guard tests: window keys, automatic rollover, quota overrides, and the
 * halt/approve gate. Uses a dedicated provider slug so it never collides with
 * real usage, and injected dates so rollover is deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { paths } from "../src/config.js";
import { checkBudget, consume, getStatus, periodKeys, recordUsage } from "../src/limits/limit-manager.js";

// Start from a clean usage database (runtime data, safe to reset in tests).
try { fs.rmSync(paths.usageLimits); } catch { /* none */ }

const P = "limtest";
process.env.LIMIT_LIMTEST_DAILY = "5";
process.env.LIMIT_LIMTEST_WEEKLY = "20";
process.env.LIMIT_LIMTEST_MONTHLY = "42";

test("period keys are well-formed and weekly is a Monday", () => {
  const keys = periodKeys(new Date("2026-03-11T10:00:00Z")); // a Wednesday
  assert.match(keys.daily, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(keys.monthly, "2026-03");
  assert.equal(keys.weekly, "2026-03-09"); // Monday of that week
});

test("quota overrides are honored", () => {
  const s = getStatus(P);
  assert.equal(s.periods.daily.limit, 5);
  assert.equal(s.periods.weekly.limit, 20);
  assert.equal(s.periods.monthly.limit, 42);
});

test("daily window rolls over while monthly persists", () => {
  const dayA = new Date("2026-03-10T12:00:00Z");
  const dayB = new Date("2026-03-11T12:00:00Z"); // next day, same week + month
  recordUsage(P, 3, dayA);
  const status = getStatus(P, dayB);
  assert.equal(status.periods.daily.used, 0, "daily should reset next day");
  assert.equal(status.periods.weekly.used, 3, "weekly persists within the week");
  assert.equal(status.periods.monthly.used, 3, "monthly persists within the month");
});

test("checkBudget flags an over-quota request", () => {
  const decision = checkBudget(P, 100, new Date("2026-03-10T12:00:00Z"));
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresApproval, true);
  assert.ok(decision.breakdown.some((b) => b.wouldExceed), "some period should exceed");
  assert.match(decision.message, /EXCEED/);
});

test("consume gate halts without approval and proceeds with it", () => {
  const now = new Date("2026-05-01T12:00:00Z"); // fresh month/day/week
  // Fill the daily quota to the brink.
  recordUsage(P, 4, now); // 4/5 daily
  const halted = consume(P, 5, false, now); // would exceed 5 daily
  assert.equal(halted.proceeded, false, "must halt without approval");
  assert.ok(halted.decision.requiresApproval);

  const approved = consume(P, 5, true, now);
  assert.equal(approved.proceeded, true, "must proceed with approval");
  assert.ok(approved.status!.periods.daily.used >= 9);
});
