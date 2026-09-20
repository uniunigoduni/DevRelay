import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadImageContents } from "../src/image-content.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKx8AAAAASUVORK5CYII=";

test("loadImageContents returns MCP image content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devrelay-image-"));
  try {
    const file = path.join(dir, "pixel.png");
    await writeFile(file, Buffer.from(ONE_PIXEL_PNG, "base64"));
    const images = await loadImageContents(["pixel.png"], dir);
    assert.equal(images.length, 1);
    assert.equal(images[0]?.type, "image");
    assert.equal(images[0]?.mimeType, "image/png");
    assert.equal(images[0]?.data, ONE_PIXEL_PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
