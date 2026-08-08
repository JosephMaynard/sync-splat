import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  checkKey,
  checkSocketKey,
  extractKey,
  keyFromCookieHeader,
  keysMatch,
} from "./auth";

/** Minimal IncomingMessage stand-in carrying just what the auth code reads. */
function fakeReq(
  headers: Record<string, string | string[] | undefined>,
  reqUrl = "/",
): IncomingMessage {
  return { headers, url: reqUrl } as unknown as IncomingMessage;
}

describe("keysMatch (constant-time compare)", () => {
  it("is true only for an exact match", () => {
    expect(keysMatch("hunter2", "hunter2")).toBe(true);
    expect(keysMatch("hunter2", "hunter3")).toBe(false);
  });

  it("returns false for a matching prefix (no early-out leak)", () => {
    expect(keysMatch("abc", "abcdef")).toBe(false);
    expect(keysMatch("abcdef", "abc")).toBe(false);
  });

  it("handles differing lengths without throwing (hashed to fixed width)", () => {
    expect(() => keysMatch("", "a".repeat(1000))).not.toThrow();
    expect(keysMatch("", "x")).toBe(false);
  });

  it("is unicode-safe", () => {
    expect(keysMatch("splat✨", "splat✨")).toBe(true);
    expect(keysMatch("splat✨", "splat")).toBe(false);
  });
});

describe("keyFromCookieHeader", () => {
  it("extracts the splat-key cookie among others", () => {
    expect(keyFromCookieHeader("a=1; splat-key=tok; b=2")).toBe("tok");
  });

  it("URL-decodes the value", () => {
    expect(keyFromCookieHeader("splat-key=a%20b")).toBe("a b");
  });

  it("returns null when absent or empty", () => {
    expect(keyFromCookieHeader(undefined)).toBeNull();
    expect(keyFromCookieHeader("other=1")).toBeNull();
  });
});

describe("extractKey (priority: header > query > cookie)", () => {
  it("prefers the X-Splat-Key header", () => {
    const req = fakeReq(
      { "x-splat-key": "fromHeader", cookie: "splat-key=fromCookie" },
      "/api/file/x?k=fromQuery",
    );
    expect(extractKey(req)).toBe("fromHeader");
  });

  it("falls back to the k/key query param", () => {
    expect(extractKey(fakeReq({}, "/api/file/x?k=q1"))).toBe("q1");
    expect(extractKey(fakeReq({}, "/api/file/x?key=q2"))).toBe("q2");
  });

  it("falls back to the cookie last", () => {
    expect(extractKey(fakeReq({ cookie: "splat-key=c1" }, "/"))).toBe("c1");
  });

  it("returns null when no key is present anywhere", () => {
    expect(extractKey(fakeReq({}, "/api/history"))).toBeNull();
  });
});

describe("checkKey", () => {
  it("always passes when no passcode is set", () => {
    expect(checkKey(fakeReq({}, "/"), null)).toBe(true);
  });

  it("passes with a matching key, fails otherwise", () => {
    expect(checkKey(fakeReq({ "x-splat-key": "tok" }), "tok")).toBe(true);
    expect(checkKey(fakeReq({ "x-splat-key": "nope" }), "tok")).toBe(false);
    expect(checkKey(fakeReq({}), "tok")).toBe(false);
  });
});

describe("checkSocketKey", () => {
  it("always passes when no passcode is set", () => {
    expect(checkSocketKey({ headers: {} }, null)).toBe(true);
  });

  it("reads auth.token first, then the cookie", () => {
    expect(checkSocketKey({ auth: { token: "tok" }, headers: {} }, "tok")).toBe(
      true,
    );
    expect(
      checkSocketKey({ headers: { cookie: "splat-key=tok" } }, "tok"),
    ).toBe(true);
    expect(checkSocketKey({ auth: { token: "no" }, headers: {} }, "tok")).toBe(
      false,
    );
    expect(checkSocketKey({ headers: {} }, "tok")).toBe(false);
  });
});
