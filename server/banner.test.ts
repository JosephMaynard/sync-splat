import { afterEach, describe, expect, it } from "vitest";
import { clickable } from "./banner";

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
