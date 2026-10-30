import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CandidateQueue,
  RTC_CONFIG,
  awaitAck,
  canShareScreen,
  isPickerCancel,
} from "./rtc";
import {
  messageForAck,
  messageForScreenJoin,
  messageForScreenStart,
} from "./messages";
import { LIMITS, type ActionAck } from "../shared/types";

describe("canShareScreen", () => {
  const gdm = () => Promise.resolve();

  it("needs both a secure context and getDisplayMedia", () => {
    expect(
      canShareScreen({
        isSecureContext: true,
        mediaDevices: { getDisplayMedia: gdm },
      }),
    ).toBe(true);
  });

  it("is false on plain-http LAN (insecure context)", () => {
    expect(
      canShareScreen({
        isSecureContext: false,
        mediaDevices: { getDisplayMedia: gdm },
      }),
    ).toBe(false);
  });

  it("is false without getDisplayMedia (iOS) or mediaDevices at all", () => {
    expect(canShareScreen({ isSecureContext: true, mediaDevices: {} })).toBe(
      false,
    );
    expect(canShareScreen({ isSecureContext: true })).toBe(false);
  });

  it("is false in a non-browser environment", () => {
    // Default args read window/navigator; node has neither.
    expect(canShareScreen()).toBe(false);
  });
});

describe("isPickerCancel", () => {
  it("recognizes a dismissed picker / denied permission", () => {
    expect(isPickerCancel({ name: "NotAllowedError" })).toBe(true);
    expect(isPickerCancel({ name: "AbortError" })).toBe(true);
  });

  it("treats anything else as a real failure", () => {
    expect(isPickerCancel({ name: "NotReadableError" })).toBe(false);
    expect(isPickerCancel(new Error("boom"))).toBe(false);
    expect(isPickerCancel(null)).toBe(false);
    expect(isPickerCancel("NotAllowedError")).toBe(false);
  });
});

describe("CandidateQueue", () => {
  it("drains in arrival order, keeping the end-of-candidates marker", () => {
    const q = new CandidateQueue();
    q.push({ candidate: "a", sdpMid: "0" });
    q.push({ candidate: "b", sdpMid: "0" });
    q.push(null);
    expect(q.size).toBe(3);
    expect(q.drain()).toEqual([
      { candidate: "a", sdpMid: "0" },
      { candidate: "b", sdpMid: "0" },
      null,
    ]);
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("clear drops everything (a new offer starts a new session)", () => {
    const q = new CandidateQueue();
    q.push({ candidate: "stale" });
    q.clear();
    q.push({ candidate: "fresh" });
    expect(q.drain()).toEqual([{ candidate: "fresh" }]);
  });
});

describe("awaitAck", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the server's ack", async () => {
    const ok: ActionAck = { ok: true, id: "sharer-1" };
    await expect(awaitAck((ack) => ack(ok))).resolves.toEqual(ok);
    const busy: ActionAck = { ok: false, error: "busy" };
    await expect(awaitAck((ack) => ack(busy))).resolves.toEqual(busy);
  });

  it("times out when no ack arrives, and ignores a late one", async () => {
    vi.useFakeTimers();
    let late: ((r: ActionAck) => void) | undefined;
    const p = awaitAck((ack) => {
      late = ack;
    }, 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBe("timeout");
    // Settle-once: a straggling ack must not throw or re-resolve.
    expect(() => late?.({ ok: true, id: "x" })).not.toThrow();
  });

  it("maps a malformed ack to invalid", async () => {
    await expect(
      awaitAck((ack) => ack(undefined as unknown as ActionAck)),
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });
});

describe("RTC_CONFIG", () => {
  it("uses no STUN/TURN servers (LAN only)", () => {
    expect(RTC_CONFIG.iceServers).toEqual([]);
  });
});

describe("ack messages", () => {
  it("covers the screen-share errors in the generic mapping", () => {
    expect(messageForAck("busy")).toMatch(/already sharing/i);
    expect(messageForAck("full")).toContain(String(LIMITS.maxScreenViewers));
  });

  it("keeps the existing text/delete wording", () => {
    expect(messageForAck("too-big")).toMatch(/too big/i);
    expect(messageForAck("rate-limited")).toMatch(/too fast/i);
    expect(messageForAck("not-found")).toMatch(/no longer exists/i);
    expect(messageForAck("invalid")).toMatch(/rejected/i);
  });

  it("uses screen-specific wording for join failures", () => {
    expect(messageForScreenJoin("not-found")).toMatch(/already ended/i);
    expect(messageForScreenJoin("full")).toMatch(/too many/i);
    expect(messageForScreenJoin("rate-limited")).toMatch(/too fast/i);
    expect(messageForScreenJoin("timeout")).toMatch(/didn't answer/i);
    // Never the misleading item wording.
    expect(messageForScreenJoin("not-found")).not.toMatch(/item/i);
  });

  it("uses screen-specific wording for start failures", () => {
    expect(messageForScreenStart("busy")).toMatch(/started sharing first/i);
    expect(messageForScreenStart("timeout")).toMatch(/didn't answer/i);
    expect(messageForScreenStart("rate-limited")).toMatch(/too fast/i);
  });
});
