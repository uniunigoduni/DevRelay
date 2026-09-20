import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export async function loadImageContents(paths: string[] | undefined, baseDir: string): Promise<ImageContent[]> {
  if (!paths?.length) return [];
  if (paths.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images can be returned per call.`);

  const output: ImageContent[] = [];
  for (const requested of paths) {
    const resolved = path.isAbsolute(requested) ? requested : path.resolve(baseDir, requested);
    const mimeType = MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type: ${requested}`);

    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`Image path is not a file: ${requested}`);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes: ${requested}`);
    }

    const data = await readFile(resolved);
    output.push({ type: "image", data: data.toString("base64"), mimeType });
  }
  return output;
}
