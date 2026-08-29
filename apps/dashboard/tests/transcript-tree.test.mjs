import assert from "node:assert/strict";
import test from "node:test";
import { groupByThread } from "../src/transcript-tree.js";

const item = (seq, kind, threadId, extra = {}) => ({
  id: `i${seq}`,
  seq,
  kind,
  threadId,
  status: "ok",
  at: "2026-08-29T12:00:00.000Z",
  title: kind,
  ...extra,
});

const container = (seq, threadId, parentThreadId = "main") => item(seq, "subagent", parentThreadId, {
  id: `sub-${threadId}`,
  subAgent: { threadId, parentThreadId, name: "vision-recovery", input: "look", status: "done" },
});

test("a sub-agent's items nest under its container, not the main line", () => {
  const roots = groupByThread([
    item(1, "user", "main"),
    container(2, "t1"),
    item(3, "tool", "t1"),
    item(4, "reasoning", "t1"),
    item(5, "tool", "main"),
  ], "all");

  assert.deepEqual(roots.map((entry) => entry.id), ["i1", "sub-t1", "i5"]);
  assert.deepEqual(roots[1].nested.map((entry) => entry.id), ["i3", "i4"]);
});

test("a sub-agent spawned by a sub-agent nests inside it", () => {
  const roots = groupByThread([
    container(1, "t1"),
    item(2, "tool", "t1"),
    container(3, "t2", "t1"),
    item(4, "tool", "t2"),
  ], "all");

  assert.deepEqual(roots.map((entry) => entry.id), ["sub-t1"]);
  const inner = roots[0].nested.find((entry) => entry.kind === "subagent");
  assert.ok(inner);
  assert.deepEqual(inner.nested.map((entry) => entry.id), ["i4"]);
});

test("items on an unknown thread stay on the main line rather than vanishing", () => {
  // Happens when a viewer attaches mid-run and misses the thread.created.
  const roots = groupByThread([item(1, "tool", "orphan-thread")], "all");
  assert.deepEqual(roots.map((entry) => entry.id), ["i1"]);
});

test("nested items are ordered by seq even when they arrive out of order", () => {
  const roots = groupByThread([
    container(1, "t1"),
    item(9, "tool", "t1"),
    item(4, "tool", "t1"),
  ], "all");
  assert.deepEqual(roots[0].nested.map((entry) => entry.seq), [4, 9]);
});

test("a filter applies inside a container and drops the ones left empty", () => {
  const roots = groupByThread([
    container(1, "t1"),
    item(2, "reasoning", "t1"),
    container(3, "t2"),
    item(4, "tool", "t2"),
    item(5, "tool", "main"),
  ], "tools");

  // t1 held only thinking, so its container goes with it; t2 keeps its tool.
  assert.deepEqual(roots.map((entry) => entry.id), ["sub-t2", "i5"]);
  assert.deepEqual(roots[0].nested.map((entry) => entry.id), ["i4"]);
});

test("the problems filter keeps a failed sub-agent container", () => {
  const failed = container(1, "t1");
  failed.status = "error";
  const roots = groupByThread([failed, item(2, "tool", "t1")], "problems");
  assert.deepEqual(roots.map((entry) => entry.id), ["sub-t1"]);
});

test("filters recursively remove empty nested sub-agent containers", () => {
  const roots = groupByThread([
    container(1, "outer"),
    container(2, "inner", "outer"),
    item(3, "reasoning", "inner"),
    item(4, "tool", "outer"),
  ], "tools");

  assert.deepEqual(roots.map((entry) => entry.id), ["sub-outer"]);
  assert.deepEqual(roots[0].nested.map((entry) => entry.id), ["i4"]);
});
