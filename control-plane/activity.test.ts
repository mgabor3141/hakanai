import { test, expect } from "bun:test";
import { serializeActivity, parseActivity, reconcileActivity } from "./activity";

// These pin the deletion-clock decisions from ADR-0003. They are the spec for
// what the persisted index means; if someone changes the policy, they change
// these on purpose.

test("serialize/parse round-trips an index", () => {
  const m = new Map([
    ["a", 1000],
    ["b", 2000],
  ]);
  expect(parseActivity(serializeActivity(m))).toEqual(m);
});

test("parse tolerates a corrupt file so the control plane still boots", () => {
  expect(parseActivity("not json{")).toEqual(new Map());
  expect(parseActivity("")).toEqual(new Map());
  expect(parseActivity("null")).toEqual(new Map());
  expect(parseActivity("[1,2,3]")).toEqual(new Map());
});

test("parse drops non-finite timestamps (no junk entries from a hand-edited file)", () => {
  const m = parseActivity(JSON.stringify({ a: 1000, b: "x", c: null, d: 2000 }));
  expect(m).toEqual(
    new Map([
      ["a", 1000],
      ["d", 2000],
    ]),
  );
});

test("reconcile leases a conversation we have no record for", () => {
  const idx = new Map<string, number>();
  reconcileActivity(idx, ["fresh"], 5000);
  expect(idx.get("fresh")).toBe(5000); // full lease from boot, never deleted unrecorded
});

test("reconcile prunes an index entry whose conversation is gone", () => {
  const idx = new Map([
    ["gone", 1000],
    ["here", 2000],
  ]);
  reconcileActivity(idx, ["here"], 9999);
  expect(idx.has("gone")).toBe(false);
  expect(idx.get("here")).toBe(2000); // a present conversation is left untouched
});

test("reconcile keeps a known stale entry so the reaper deletes it", () => {
  const stale = 1; // ~1970, far past any TTL
  const idx = new Map([["old", stale]]);
  reconcileActivity(idx, ["old"], 1_000_000);
  expect(idx.get("old")).toBe(stale); // NOT renewed to now -- this is what makes outages safe
});
