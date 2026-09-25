// Hand-rolled, streaming parser for the Server-Sent Events wire format used
// by GET /api/events (see the "Terminal event stream" contract block in
// shared/types.ts). Kept as a small, pure, separately-tested unit consumed by
// `sync-splat watch`: feed it raw bytes as they arrive off the socket — which
// may split a chunk anywhere (mid-line, mid-UTF-8 sequence, mid-"\r\n", since
// TCP/HTTP chunking knows nothing about our framing) — and it returns
// whatever complete events that chunk completed.
//
// Follows the parsing model from the WHATWG HTML "Server-sent events" spec,
// trimmed to what sync-splat's server actually emits: `event:`, `data:`
// (possibly repeated, joined with "\n"), comment lines starting with ":",
// and dispatch on a blank line. Any other field (id, retry, ...) is parsed
// but ignored, matching "ignores unknown fields" — this server never sends
// them and the client has no use for them.

/** One dispatched SSE event. `event` defaults to "message" per spec when a
 *  block never had an explicit `event:` line (sync-splat's server always
 *  sends one, but this keeps the parser spec-faithful). `data` is the
 *  joined value of all `data:` lines in the block, without a trailing
 *  newline. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Streaming SSE parser. Feed raw bytes via `push()` in arrival order; each
 * call returns the events that chunk completed (often none). Internally
 * buffers two things across calls:
 *  1. Any pending multi-byte UTF-8 sequence — via a streaming `TextDecoder`,
 *     which already handles a codepoint split across chunk boundaries.
 *  2. Any decoded text not yet resolved into complete lines, including a
 *     trailing lone "\r" that might turn out to be the first half of a
 *     "\r\n" split across the chunk boundary — decided only once more text
 *     (or none, ever) arrives.
 */
export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private eventType = "";
  private dataLines: string[] = [];

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];

    let start = 0; // start of the line currently being scanned
    let i = 0;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      let lineEnd: number; // index just past the line's content
      let next: number; // index of the following line's start
      if (ch === "\n") {
        lineEnd = i;
        next = i + 1;
      } else if (ch === "\r") {
        if (i + 1 >= this.buffer.length) {
          // A lone "\r" at the very end of the buffered text: it may be the
          // first half of a "\r\n" split across chunks. Stop scanning and
          // leave everything from `start` onward (including this "\r") for
          // the next push to resolve.
          break;
        }
        lineEnd = i;
        next = this.buffer[i + 1] === "\n" ? i + 2 : i + 1;
      } else {
        i += 1;
        continue;
      }
      const event = this.consumeLine(this.buffer.slice(start, lineEnd));
      if (event) events.push(event);
      start = next;
      i = next;
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /** Parse one complete line (terminator already stripped) and update the
   *  in-progress event's state. Returns the dispatched event when the line
   *  was blank (the event terminator) and there was data to dispatch. */
  private consumeLine(line: string): SseEvent | null {
    if (line === "") {
      // Per spec: a blank line with an empty data buffer just resets state
      // without dispatching (covers stray blank lines / keep-alives that
      // never set `data:`).
      if (this.dataLines.length === 0) {
        this.eventType = "";
        return null;
      }
      const event: SseEvent = {
        event: this.eventType || "message",
        data: this.dataLines.join("\n"),
      };
      this.eventType = "";
      this.dataLines = [];
      return event;
    }
    if (line.startsWith(":")) return null; // comment (e.g. the ": ping" keep-alive)

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // one optional leading space

    if (field === "event") this.eventType = value;
    else if (field === "data") this.dataLines.push(value);
    // Unknown fields (id, retry, ...) are parsed but ignored.
    return null;
  }
}
