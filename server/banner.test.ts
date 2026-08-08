import { afterEach, describe, expect, it } from "vitest";
import { clickable, withAuthFragment } from "./banner";

/** Mirror of how the client parses `#k=<token>` (URLSearchParams decodes
 *  percent-encoding). Kept inline so this server test doesn't import DOM code. */
function parseTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw).get("k");
}

const URL = "http://192.168.1.5:3011";
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalTerm = process.env.TERM;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  }
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
});

describe("clickable", () => {
  it("returns the plain URL when stdout is not a TTY", () => {
    setTTY(false);
    expect(clickable(URL)).toBe(URL);
  });

  it("returns the plain URL on dumb terminals", () => {
    setTTY(true);
    process.env.TERM = "dumb";
    expect(clickable(URL)).toBe(URL);
  });

  it("wraps the URL in an OSC 8 hyperlink on a TTY", () => {
    setTTY(true);
    process.env.TERM = "xterm-256color";
    const out = clickable(URL);
    expect(out).toContain(`]8;;${URL}`); // link open
    expect(out).toContain("]8;;"); // link close
    expect(out).toContain(URL); // visible text intact
  });
});

describe("withAuthFragment", () => {
  const URL = "http://192.168.1.5:3011";

  it("returns the URL unchanged when there is no passcode", () => {
    expect(withAuthFragment(URL, null)).toBe(URL);
  });

  it("appends a #k= fragment for a simple token", () => {
    expect(withAuthFragment(URL, "abc123")).toBe(`${URL}/#k=abc123`);
  });

  it("percent-encodes special characters and round-trips via the client parser", () => {
    for (const token of ["a&b", "a b", "50%off", "a#b", "a=b", "π"]) {
      const url = withAuthFragment(URL, token);
      const hash = url.slice(url.indexOf("#"));
      // The client's parseTokenFromHash must recover exactly what we embedded.
      expect(parseTokenFromHash(hash)).toBe(token);
    }
  });
});
