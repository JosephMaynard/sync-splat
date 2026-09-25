import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "./sse-parser";

/** Feed `text` through a fresh parser one byte at a time — the harshest
 *  possible chunk-boundary split, including mid-UTF-8-codepoint and mid-line
 *  ending — and return every event dispatched across the whole stream. */
function parseByteByByte(text: string): SseEvent[] {
  const parser = new SseParser();
  const bytes = new TextEncoder().encode(text);
  const events: SseEvent[] = [];
  for (const byte of bytes) {
    events.push(...parser.push(new Uint8Array([byte])));
  }
  return events;
}

/** Same stream, fed as one single chunk, for a baseline comparison. */
function parseWhole(text: string): SseEvent[] {
  const parser = new SseParser();
  return parser.push(new TextEncoder().encode(text));
}

describe("SseParser", () => {
  it("parses a simple event: + data: block terminated by a blank line", () => {
    const events = parseWhole("event: hello\ndata: {\"a\":1}\n\n");
    expect(events).toEqual([{ event: "hello", data: '{"a":1}' }]);
  });

  it("defaults the event name to \"message\" when none is given", () => {
    const events = parseWhole("data: just data\n\n");
    expect(events).toEqual([{ event: "message", data: "just data" }]);
  });

  it("joins multiple data: lines with \\n", () => {
    const events = parseWhole("event: item:new\ndata: line one\ndata: line two\n\n");
    expect(events).toEqual([{ event: "item:new", data: "line one\nline two" }]);
  });

  it("ignores comment lines starting with :", () => {
    const events = parseWhole(": ping\nevent: hello\ndata: 1\n\n");
    expect(events).toEqual([{ event: "hello", data: "1" }]);
  });

  it("a comment-only block (e.g. a keep-alive ping) dispatches nothing", () => {
    const events = parseWhole(": ping\n\n");
    expect(events).toEqual([]);
  });

  it("ignores unknown fields", () => {
    const events = parseWhole("id: 42\nretry: 3000\nevent: hello\ndata: x\n\n");
    expect(events).toEqual([{ event: "hello", data: "x" }]);
  });

  it("strips at most one leading space after the colon", () => {
    const events = parseWhole("data:  two spaces\n\n");
    expect(events).toEqual([{ event: "message", data: " two spaces" }]);
  });

  it("handles \\n, \\r\\n, and \\r line endings, including mixed within one stream", () => {
    const events = parseWhole(
      "event: a\r\ndata: one\r\n\r\nevent: b\rdata: two\r\revent: c\ndata: three\n\n",
    );
    expect(events).toEqual([
      { event: "a", data: "one" },
      { event: "b", data: "two" },
      { event: "c", data: "three" },
    ]);
  });

  it("malformed/incomplete trailing block without a terminating blank line is never dispatched", () => {
    const events = parseWhole("event: hello\ndata: x");
    expect(events).toEqual([]);
  });

  describe("split across every byte boundary", () => {
    const stream =
      ": keep-alive\n" +
      "event: hello\r\n" +
      'data: {"version":"1.2.3"}\r\n' +
      "\r\n" +
      "event: item:new\n" +
      "data: {\"kind\":\"text\",\n" +
      'data: "html":"a & b éèê 😀"}\n' +
      "\n" +
      "id: ignored\r" +
      "event: item:deleted\r" +
      'data: {"id":"xyz"}\r' +
      // Terminate with "\r\n" (not a bare trailing "\r") so this last blank
      // line resolves within the stream itself: a lone "\r" as the very
      // last byte is *correctly* held back by the parser pending a possible
      // following "\n" that would combine into one "\r\n" — it can only be
      // resolved by a later push, which a real connection always provides
      // (more data, or at minimum the next keep-alive ping).
      "\r\n";

    it("reproduces the same events as parsing the whole stream in one chunk", () => {
      expect(parseByteByByte(stream)).toEqual(parseWhole(stream));
    });

    it("dispatches the expected three events, UTF-8 (incl. a surrogate-pair emoji) intact", () => {
      const events = parseByteByByte(stream);
      expect(events).toEqual([
        { event: "hello", data: '{"version":"1.2.3"}' },
        {
          event: "item:new",
          data: '{"kind":"text",\n"html":"a & b éèê 😀"}',
        },
        { event: "item:deleted", data: '{"id":"xyz"}' },
      ]);
    });
  });

  it("splits a \\r\\n line ending exactly at the chunk boundary (CR then LF)", () => {
    const parser = new SseParser();
    const first = parser.push(new TextEncoder().encode("data: hello\r"));
    expect(first).toEqual([]);
    const second = parser.push(new TextEncoder().encode("\n\n"));
    expect(second).toEqual([{ event: "message", data: "hello" }]);
  });

  it("splits a multi-byte UTF-8 codepoint exactly at the chunk boundary", () => {
    // "é" is 0xC3 0xA9 in UTF-8; split the two bytes across two pushes.
    const full = new TextEncoder().encode('data: café\n\n');
    const parser = new SseParser();
    const events: SseEvent[] = [];
    events.push(...parser.push(full.slice(0, full.length - 3))); // up to + including 0xC3
    events.push(...parser.push(full.slice(full.length - 3))); // 0xA9 + "\n\n"
    expect(events).toEqual([{ event: "message", data: "café" }]);
  });

  it("splits a 4-byte emoji codepoint across a chunk boundary", () => {
    const full = new TextEncoder().encode("data: 😀\n\n"); // 😀, 4 UTF-8 bytes
    const parser = new SseParser();
    const events: SseEvent[] = [];
    // Split in the middle of the 4-byte sequence.
    events.push(...parser.push(full.slice(0, full.length - 5)));
    events.push(...parser.push(full.slice(full.length - 5)));
    expect(events).toEqual([{ event: "message", data: "😀" }]);
  });

  it("processes multiple events delivered in one chunk, in order", () => {
    const events = parseWhole(
      "event: item:new\ndata: 1\n\nevent: item:new\ndata: 2\n\nevent: item:new\ndata: 3\n\n",
    );
    expect(events.map((e) => e.data)).toEqual(["1", "2", "3"]);
  });
});
