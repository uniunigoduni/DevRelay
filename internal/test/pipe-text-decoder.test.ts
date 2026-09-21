import assert from "node:assert/strict";
import test from "node:test";
import { PipeTextDecoder } from "../src/pipe-text-decoder.js";

test("PipeTextDecoder preserves UTF-8 across chunk boundaries", () => {
  const decoder = new PipeTextDecoder("utf8");
  const bytes = Buffer.from("日本語テスト", "utf8");
  let text = "";
  text += decoder.push(bytes.subarray(0, 1));
  text += decoder.push(bytes.subarray(1, 5));
  text += decoder.push(bytes.subarray(5));
  text += decoder.end();
  assert.equal(text, "日本語テスト");
});

test("PipeTextDecoder preserves CP932 across chunk boundaries", () => {
  const decoder = new PipeTextDecoder("cp932");
  const bytes = Buffer.from("93fa967b8cea836583588367", "hex");
  let text = decoder.push(bytes.subarray(0, 1));
  text += decoder.push(bytes.subarray(1, 4));
  text += decoder.push(bytes.subarray(4));
  text += decoder.end();
  assert.equal(text, "日本語テスト");
});

test("PipeTextDecoder does not misclassify valid-looking CP932 as UTF-8", () => {
  const decoder = new PipeTextDecoder("cp932");
  const bytes = Buffer.from("e0a08140", "hex");
  assert.equal(decoder.push(bytes) + decoder.end(), "燿　");
});

test("PipeTextDecoder supports OEM code pages through iconv-lite", () => {
  const decoder = new PipeTextDecoder("cp437");
  assert.equal(decoder.push(Buffer.from([0x82])) + decoder.end(), "é");
});
