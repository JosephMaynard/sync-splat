import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./socket";
import { LIMITS } from "../shared/types";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the configured limit within a window and denies the next", () => {
    const allow = createRateLimiter();

    for (let i = 0; i < LIMITS.rateLimitEvents; i += 1) {
      expect(allow()).toBe(true);
    }
    expect(allow()).toBe(false);
  });

  it("allows events again once the window slides past the oldest event", () => {
    const allow = createRateLimiter();

    for (let i = 0; i < LIMITS.rateLimitEvents; i += 1) {
      expect(allow()).toBe(true);
    }
    expect(allow()).toBe(false);

    // Advance past the window so the earliest events fall off.
    vi.setSystemTime(LIMITS.rateLimitWindowMs + 1);
    expect(allow()).toBe(true);
  });

  it("keeps denying while still inside the window", () => {
    const allow = createRateLimiter();

    for (let i = 0; i < LIMITS.rateLimitEvents; i += 1) {
      allow();
    }
    vi.setSystemTime(LIMITS.rateLimitWindowMs - 1);
    expect(allow()).toBe(false);
  });

  it("tracks each limiter instance independently", () => {
    const allowA = createRateLimiter();
    const allowB = createRateLimiter();

    for (let i = 0; i < LIMITS.rateLimitEvents; i += 1) {
      expect(allowA()).toBe(true);
    }
    expect(allowA()).toBe(false);
    // A fresh limiter (as if for a different socket) is unaffected.
    expect(allowB()).toBe(true);
  });
});
