// DOM-free tests for the pure parts of auth.ts. happy-dom is not an installed
// dep, so instead of a DOM environment we stub the two globals auth.ts touches
// (localStorage + document.cookie) with minimal plain objects. Storage/cookie
// persistence semantics themselves are NOT under test here — only the pure
// query/header/token logic built on top of them.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  clearToken,
  parseTokenFromHash,
  setToken,
  withKey,
} from "./auth";

beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
  vi.stubGlobal("document", { cookie: "" });
});

afterEach(() => {
  clearToken();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("withKey", () => {
  it("returns the url unchanged when there is no token", () => {
    expect(withKey("/api/file/abc")).toBe("/api/file/abc");
    expect(withKey("/api/share/dl?path=x")).toBe("/api/share/dl?path=x");
  });

  it("appends ?k=<token> to a url without a query", () => {
    setToken("tok123");
    expect(withKey("/api/file/abc")).toBe("/api/file/abc?k=tok123");
  });

  it("appends with & (never a second ?) when a query already exists", () => {
    setToken("tok123");
    const out = withKey("/api/share/dl?path=a%2Fb");
    expect(out).toBe("/api/share/dl?path=a%2Fb&k=tok123");
    // No double-? however many params are present.
    expect(out.split("?").length).toBe(2);
    expect(withKey("/x?a=1&b=2")).toBe("/x?a=1&b=2&k=tok123");
  });

  it("percent-encodes the token", () => {
    setToken("a b/c&d");
    expect(withKey("/dl")).toBe("/dl?k=a%20b%2Fc%26d");
  });
});

describe("authHeaders", () => {
  it("is empty without a token and carries x-splat-key with one", () => {
    expect(authHeaders()).toEqual({});
    setToken("secret");
    expect(authHeaders()).toEqual({ "x-splat-key": "secret" });
  });
});

// Core parseTokenFromHash cases live in util.test.ts; these cover edges not
// exercised there.
describe("parseTokenFromHash (additional edges)", () => {
  it("takes the first k when the fragment repeats it", () => {
    expect(parseTokenFromHash("#k=first&k=second")).toBe("first");
  });

  it("decodes + as a space (URLSearchParams semantics) and trims", () => {
    expect(parseTokenFromHash("#k=+abc+")).toBe("abc");
  });

  it("ignores a k that is only a prefix/suffix of another param name", () => {
    expect(parseTokenFromHash("#ok=1")).toBeNull();
    expect(parseTokenFromHash("#kk=1")).toBeNull();
  });

  it("handles a fragment with percent-encoded separators in the token", () => {
    expect(parseTokenFromHash("#k=a%26b%3Dc")).toBe("a&b=c");
  });
});
