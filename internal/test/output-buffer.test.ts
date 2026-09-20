import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "../src/output-buffer.js";

test("OutputBuffer uses cursors for incremental reads", () => {
  const buffer = new OutputBuffer(10_000);
  buffer.push("stdout", "first");
  buffer.push("stderr", "second");

  const first = buffer.read(0, 10_000);
  assert.equal(first.events.length, 2);
  assert.equal(first.nextCursor, 2);
  assert.equal(first.truncated, false);

  buffer.push("stdout", "third");
  const second = buffer.read(first.nextCursor, 10_000);
  assert.deepEqual(second.events.map((event) => event.text), ["third"]);
  assert.equal(second.nextCursor, 3);
});

test("OutputBuffer reports when old output was discarded", () => {
  const buffer = new OutputBuffer(20);
  buffer.push("stdout", "1234567890123456");
  buffer.push("stdout", "abcdefghijklmnop");
  const read = buffer.read(0, 100);
  assert.equal(read.truncated, true);
  assert.ok(read.oldestCursor > 0);
});
