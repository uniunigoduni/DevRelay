import { execFileSync } from "node:child_process";
import iconv, { type DecoderStream } from "iconv-lite";

export function detectWindowsPipeEncoding(): string {
  if (process.platform !== "win32") return "utf8";
  try {
    const output = execFileSync("chcp.com", [], {
      encoding: "ascii",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const codePage = output.match(/\d+/)?.[0];
    if (codePage) {
      const encoding = `cp${codePage}`;
      if (iconv.encodingExists(encoding)) return encoding;
      throw new Error(`Unsupported Windows code page ${codePage}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported Windows code page")) throw error;
  }
  throw new Error("Could not determine the active Windows code page. Set outputEncoding explicitly.");
}

export function resolveOutputEncoding(requested: string | undefined, fallback: string): string {
  const encoding = requested?.trim() || fallback;
  const resolved = encoding.toLowerCase() === "system" ? detectWindowsPipeEncoding() : encoding;
  if (!iconv.encodingExists(resolved)) throw new Error(`Unsupported output encoding: ${encoding}`);
  return resolved;
}
export class PipeTextDecoder {
  private readonly decoder: DecoderStream;

  constructor(readonly encoding: string) {
    if (!iconv.encodingExists(encoding)) throw new Error(`Unsupported output encoding: ${encoding}`);
    this.decoder = iconv.getDecoder(encoding);
  }

  push(chunk: Buffer): string {
    return chunk.length ? this.decoder.write(chunk) : "";
  }

  end(): string {
    return this.decoder.end() ?? "";
  }
}
