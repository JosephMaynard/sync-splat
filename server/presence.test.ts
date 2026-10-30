import { describe, expect, it, vi } from "vitest";
import {
  createPresenceRegistry,
  isLoopbackAddress,
  sanitizeDeviceLabel,
} from "./presence";
import { LIMITS, type Device } from "../shared/types";

describe("sanitizeDeviceLabel", () => {
  it("passes an ordinary label through", () => {
    expect(sanitizeDeviceLabel("iPhone · Safari", "x")).toBe("iPhone · Safari");
  });

  it("falls back for non-strings", () => {
    for (const raw of [undefined, null, 42, {}, ["a"], true]) {
      expect(sanitizeDeviceLabel(raw, "Unknown device")).toBe("Unknown device");
    }
  });

  it("falls back when nothing visible remains", () => {
    expect(sanitizeDeviceLabel("", "Terminal")).toBe("Terminal");
    expect(sanitizeDeviceLabel("   \t\n ", "Terminal")).toBe("Terminal");
    expect(sanitizeDeviceLabel("​‮⁦\u0000", "Terminal")).toBe(
      "Terminal",
    );
  });

  it("strips C0/C1 controls and DEL", () => {
    expect(sanitizeDeviceLabel("a\u0000b\u0007c\u001bd\u007fe", "x")).toBe("abcde");
    // C1: 8-bit CSI (U+009B) could start a terminal escape sequence.
    expect(sanitizeDeviceLabel("a\u009b31mb\u0080c", "x")).toBe("a31mbc");
  });

  it("strips bidi overrides and isolates", () => {
    // "evil‮gnp.exe" would render reversed as "evilexe.png".
    expect(sanitizeDeviceLabel("evil‮gnp.exe", "x")).toBe("evilgnp.exe");
    expect(
      sanitizeDeviceLabel("‪a‫b‬c‭d⁦e⁧f⁨g⁩", "x"),
    ).toBe("abcdefg");
    expect(sanitizeDeviceLabel("a‎b‏c؜d", "x")).toBe("abcd");
  });

  it("strips zero-width characters", () => {
    expect(sanitizeDeviceLabel("Ma​c‌B‍o⁠o﻿k", "x")).toBe(
      "MacBook",
    );
  });

  it("turns whitespace controls into spaces and collapses runs", () => {
    expect(sanitizeDeviceLabel("  Joseph's\t\tMac \n\r Book  ", "x")).toBe(
      "Joseph's Mac Book",
    );
    // Invisible chars between spaces must not leave a double space behind.
    expect(sanitizeDeviceLabel("a ​ b", "x")).toBe("a b");
    expect(sanitizeDeviceLabel("a 　b", "x")).toBe("a b");
  });

  it("truncates to maxDeviceLabelChars code points, never splitting an emoji", () => {
    const max = LIMITS.maxDeviceLabelChars;
    expect(sanitizeDeviceLabel("x".repeat(max + 10), "f")).toBe("x".repeat(max));
    // Each 😀 is 2 UTF-16 units but one code point.
    const emoji = "😀".repeat(max + 5);
    const out = sanitizeDeviceLabel(emoji, "f");
    expect(Array.from(out)).toHaveLength(max);
    expect(out).toBe("😀".repeat(max));
    // No lone surrogate at the cut.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
  });

  it("does not leave a trailing space when the cut lands on one", () => {
    const max = LIMITS.maxDeviceLabelChars;
    const raw = "a".repeat(max - 1) + " bcd";
    expect(sanitizeDeviceLabel(raw, "f")).toBe("a".repeat(max - 1));
  });
});

describe("isLoopbackAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.254",
    "::1",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.9",
  ])("accepts %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  it.each([
    "192.168.1.10",
    "10.0.0.1",
    "::ffff:192.168.1.10",
    "fe80::1",
    "::",
    "0.0.0.0",
    "128.0.0.1",
    "1127.0.0.1",
    "127.0.0.1.evil",
    "",
  ])("rejects %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });

  it("rejects missing addresses", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("createPresenceRegistry", () => {
  const dev = (id: string): Device => ({
    id,
    label: id,
    kind: "browser",
    host: false,
  });

  it("notifies with the full list on add and remove, in connection order", () => {
    const onChange = vi.fn();
    const reg = createPresenceRegistry(onChange);
    reg.add(dev("a"));
    reg.add(dev("b"));
    expect(onChange).toHaveBeenLastCalledWith([dev("a"), dev("b")]);
    expect(reg.remove("a")).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith([dev("b")]);
    expect(reg.get("b")).toEqual(dev("b"));
    expect(reg.get("a")).toBeUndefined();
  });

  it("does not notify when removing an unknown id", () => {
    const onChange = vi.fn();
    const reg = createPresenceRegistry(onChange);
    expect(reg.remove("nope")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps separate state per registry (no module-level state)", () => {
    const a = createPresenceRegistry(() => {});
    const b = createPresenceRegistry(() => {});
    a.add(dev("x"));
    expect(b.list()).toEqual([]);
  });
});
