import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime } from "./relativeTime";

const NOW = 1_750_000_000_000;

test("under 5s reads as 'just now'", () => {
  assert.equal(formatRelativeTime(NOW - 2_000, NOW), "just now");
});

test("seconds / minutes / hours / days each pick the coarsest unit", () => {
  assert.equal(formatRelativeTime(NOW - 12_000, NOW), "12s ago");
  assert.equal(formatRelativeTime(NOW - 3 * 60_000, NOW), "3m ago");
  assert.equal(formatRelativeTime(NOW - 5 * 3_600_000, NOW), "5h ago");
  assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), "2d ago");
});

test("a future timestamp (clock skew) never shows a negative age", () => {
  assert.equal(formatRelativeTime(NOW + 5_000, NOW), "just now");
});
