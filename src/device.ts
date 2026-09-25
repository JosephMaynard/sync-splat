/**
 * Human-readable label for this browser in the presence list, e.g.
 * "iPhone · Safari" or "Windows · Edge". Sent in the socket handshake; the
 * server sanitizes and length-caps it, so this is cosmetic, not identity.
 *
 * Pure: the UA string and touch-point count are injectable so tests can feed
 * real user agents. Order matters throughout — most browsers carry every
 * older browser's token ("Chrome", "Safari", "Mozilla") for compatibility, so
 * the more specific brands are checked first.
 */
export function deviceLabel(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
  maxTouchPoints: number = typeof navigator !== "undefined"
    ? (navigator.maxTouchPoints ?? 0)
    : 0,
): string {
  const platform = detectPlatform(ua, maxTouchPoints);
  const browser = detectBrowser(ua, platform);
  if (platform && browser) return `${platform} · ${browser}`;
  return platform ?? browser ?? "Web browser";
}

type Platform =
  | "iPhone"
  | "iPad"
  | "Android"
  | "ChromeOS"
  | "Windows"
  | "Mac"
  | "Linux";

function detectPlatform(ua: string, maxTouchPoints: number): Platform | null {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  // iPadOS 13+ Safari requests the desktop site with a Macintosh UA. Macs
  // report 0 touch points; iPads report 5 — the only reliable tell.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Linux|X11/.test(ua)) return "Linux";
  return null;
}

function detectBrowser(ua: string, platform: Platform | null): string | null {
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  // OPR = Opera desktop/Android, OPT/OPiOS = Opera on iOS, "Opera" = Presto.
  if (/OPR\/|OPT\/|OPiOS\/|\bOpera\b/.test(ua)) return "Opera";
  // Edg/ (Chromium Edge), EdgA/ (Android), EdgiOS/, Edge/ (legacy EdgeHTML).
  // Must precede Chrome: Edge's UA also says "Chrome".
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  // FxiOS = Firefox on iOS (WebKit underneath, but users know it as Firefox).
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  // CriOS = Chrome on iOS.
  if (/CriOS\/|Chrome\/|Chromium\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) || platform === "iPhone" || platform === "iPad") {
    // Every other iOS browser is WebKit; an unrecognized one (in-app webview)
    // is closest to Safari from the user's point of view.
    return "Safari";
  }
  return null;
}
