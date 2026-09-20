import type { OutputEvent } from "./types.js";

const MAX_EVENT_CHARS = 16_384;

export interface OutputReadResult {
  events: OutputEvent[];
  nextCursor: number;
  oldestCursor: number;
  truncated: boolean;
}

export class OutputBuffer {
  private readonly events: OutputEvent[] = [];
  private totalChars = 0;
  private nextCursor = 0;

  constructor(private readonly maxChars: number) {}

  push(stream: OutputEvent["stream"], text: string): void {
    for (let offset = 0; offset < text.length; offset += MAX_EVENT_CHARS) {
      const chunk = text.slice(offset, offset + MAX_EVENT_CHARS);
      this.events.push({
        cursor: this.nextCursor++,
        stream,
        text: chunk,
        timestamp: new Date().toISOString()
      });
      this.totalChars += chunk.length;
      this.trim();
    }
  }

  read(cursor = 0, maxChars = 65_536): OutputReadResult {
    const oldestCursor = this.events[0]?.cursor ?? this.nextCursor;
    const effectiveCursor = Math.max(cursor, oldestCursor);
    const selected: OutputEvent[] = [];
    let usedChars = 0;

    for (const event of this.events) {
      if (event.cursor < effectiveCursor) continue;
      if (selected.length > 0 && usedChars + event.text.length > maxChars) break;

      // A single buffered event is at most 16 KiB. If maxChars is smaller,
      // return the whole event so advancing the cursor never loses bytes.
      selected.push(event);
      usedChars += event.text.length;
      if (usedChars >= maxChars) break;
    }

    const nextCursor = selected.length > 0
      ? selected[selected.length - 1]!.cursor + 1
      : effectiveCursor;

    return {
      events: selected,
      nextCursor,
      oldestCursor,
      truncated: cursor < oldestCursor
    };
  }

  private trim(): void {
    while (this.totalChars > this.maxChars && this.events.length > 1) {
      const removed = this.events.shift();
      if (removed) this.totalChars -= removed.text.length;
    }
  }
}
