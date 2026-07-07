/**
 * Discovery safety-gate tests. These exercise the human-in-the-loop boundary
 * WITHOUT network access and without mutating the tracked tools-registry.json:
 * approval must be explicit, and promoting a nonexistent suggestion is a no-op.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { approveSuggestion, listSuggestions } from "../src/discovery/discover.js";

test("approve_suggestion does nothing without the approve flag", () => {
  const r = approveSuggestion("some/model", false);
  assert.equal(r.ok, false);
  assert.match(r.message, /approve flag/i);
});

test("approving a nonexistent suggestion is a safe no-op (no registry mutation)", () => {
  const r = approveSuggestion("definitely-not-a-real-suggestion-xyz-123", true);
  assert.equal(r.ok, false);
  assert.match(r.message, /not found/i);
});

test("listSuggestions returns an array", () => {
  assert.ok(Array.isArray(listSuggestions()));
});
