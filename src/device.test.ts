import { describe, it, expect } from "vitest";
import { deviceLabel } from "./device";
import { LIMITS } from "../shared/types";

// Real-world UA strings (trimmed of nothing — the matching must survive the
// full noise of compatibility tokens).
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/125.2535.60 Mobile/15E148 Safari/605.1.15",
  iphoneWebview:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ipadLegacy:
    "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ desktop-mode UA: identical to Mac Safari.
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macFirefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidFirefox:
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.2592.61",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.61",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsOpera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linuxFirefox:
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  chromeos:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("deviceLabel", () => {
  it("names iPhone browsers, including Chrome/Firefox/Edge on iOS", () => {
    expect(deviceLabel(UA.iphoneSafari, 5)).toBe("iPhone · Safari");
    expect(deviceLabel(UA.iphoneChrome, 5)).toBe("iPhone · Chrome");
    expect(deviceLabel(UA.iphoneFirefox, 5)).toBe("iPhone · Firefox");
    expect(deviceLabel(UA.iphoneEdge, 5)).toBe("iPhone · Edge");
  });

  it("treats an unbranded iOS webview as Safari", () => {
    expect(deviceLabel(UA.iphoneWebview, 5)).toBe("iPhone · Safari");
  });

  it("detects iPads, including iPadOS's desktop-class Mac UA", () => {
    expect(deviceLabel(UA.ipadLegacy, 5)).toBe("iPad · Safari");
    expect(deviceLabel(UA.macSafari, 5)).toBe("iPad · Safari");
    // Same UA with no touch points is a real Mac.
    expect(deviceLabel(UA.macSafari, 0)).toBe("Mac · Safari");
  });

  it("names Mac browsers", () => {
    expect(deviceLabel(UA.macFirefox, 0)).toBe("Mac · Firefox");
    expect(deviceLabel(UA.macChrome, 0)).toBe("Mac · Chrome");
  });

  it("names Android browsers, with Samsung/Edge before Chrome", () => {
    expect(deviceLabel(UA.androidChrome, 5)).toBe("Android · Chrome");
    expect(deviceLabel(UA.androidSamsung, 5)).toBe(
      "Android · Samsung Internet",
    );
    expect(deviceLabel(UA.androidFirefox, 5)).toBe("Android · Firefox");
    expect(deviceLabel(UA.androidEdge, 5)).toBe("Android · Edge");
  });

  it("names Windows browsers, with Edge/Opera before Chrome", () => {
    expect(deviceLabel(UA.windowsEdge, 0)).toBe("Windows · Edge");
    expect(deviceLabel(UA.windowsChrome, 0)).toBe("Windows · Chrome");
    expect(deviceLabel(UA.windowsOpera, 0)).toBe("Windows · Opera");
    expect(deviceLabel(UA.windowsFirefox, 0)).toBe("Windows · Firefox");
    // A Windows touch laptop is still Windows, not an iPad.
    expect(deviceLabel(UA.windowsEdge, 10)).toBe("Windows · Edge");
  });

  it("names Linux and ChromeOS", () => {
    expect(deviceLabel(UA.linuxChrome, 0)).toBe("Linux · Chrome");
    expect(deviceLabel(UA.linuxFirefox, 0)).toBe("Linux · Firefox");
    expect(deviceLabel(UA.chromeos, 0)).toBe("ChromeOS · Chrome");
  });

  it("falls back sensibly on unknown or empty UAs", () => {
    expect(deviceLabel("", 0)).toBe("Web browser");
    expect(deviceLabel("curl/8.4.0", 0)).toBe("Web browser");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Gecko", 0)).toBe(
      "Windows",
    );
    expect(deviceLabel("SomeBot Chrome/120.0", 0)).toBe("Chrome");
  });

  it("always fits the server's label cap", () => {
    for (const ua of Object.values(UA)) {
      for (const touch of [0, 5]) {
        expect(deviceLabel(ua, touch).length).toBeLessThanOrEqual(
          LIMITS.maxDeviceLabelChars,
        );
      }
    }
  });
});
