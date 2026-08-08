import { encodeQR, renderQRToTerminal } from "../qr/src";
import { AUTH } from "../shared/types";
import { VERSION } from "./net";

export interface BannerInfo {
  port: number;
  urls: string[];
  /** Stable mDNS URL (http://<hostname>.local:<port>), or null if unavailable. */
  mdnsUrl: string | null;
  hasClient: boolean;
  /** Absolute path of the shared folder, or null when sharing is disabled. */
  shareDir: string | null;
  /** Passcode, or null when none is set. When set, the printed URLs and the QR
   *  carry it as a `#k=<token>` fragment so a phone scan authenticates on open,
   *  and a "Passcode:" line is printed. The fragment never reaches the server. */
  token: string | null;
}

/** Append the `#k=<token>` auth fragment to a URL when a passcode is set. The
 *  fragment stays client-side (browsers never send it to the server). */
export function withAuthFragment(url: string, token: string | null): string {
  if (!token) return url;
  return `${url}/#${AUTH.fragmentParam}=${token}`;
}

/**
 * Wrap a URL in an OSC 8 terminal hyperlink so supporting terminals (iTerm2,
 * Terminal.app, VS Code, Windows Terminal, …) make it clickable, with an
 * underline for affordance. Only when stdout is an interactive terminal —
 * piped output, files, and CI logs get the plain URL.
 */
export function clickable(url: string): string {
  if (!process.stdout.isTTY || process.env.TERM === "dumb") return url;
  const ESC = "\u001b";
  const BEL = "\u0007";
  const linkOpen = `${ESC}]8;;${url}${BEL}`;
  const linkClose = `${ESC}]8;;${BEL}`;
  return `${linkOpen}${ESC}[4m${url}${ESC}[24m${linkClose}`;
}

/**
 * Print the startup banner: title, localhost + LAN URLs, an optional client
 * build warning, and a terminal QR code for the first LAN URL. QR encoding is
 * wrapped in try/catch because encodeQR throws on payloads over its capacity.
 */
export function printBanner(info: BannerInfo): void {
  const { port, urls, mdnsUrl, hasClient, shareDir, token } = info;
  const frag = (url: string) => withAuthFragment(url, token);
  const lines: string[] = [
    "",
    `  sync-splat v${VERSION}`,
    "  Share text and files across your local network.",
    "",
    `  Local:    ${clickable(frag(`http://localhost:${port}`))}`,
  ];
  for (const url of urls) {
    lines.push(`  Network:  ${clickable(frag(url))}`);
  }
  if (urls.length === 0) {
    lines.push("  Network:  (no LAN interface detected)");
  }
  if (mdnsUrl) {
    lines.push(`  Stable:   ${clickable(frag(mdnsUrl))}`);
  }
  if (token) {
    lines.push("");
    lines.push(`  Passcode: ${token}`);
    lines.push(
      "            Required to connect. The URLs and QR above embed it, so a",
    );
    lines.push("            phone scan authenticates automatically.");
  }
  if (shareDir) {
    lines.push(
      `  Sharing:  ${shareDir}   ` +
        "(browse/upload from any device — disable with --no-share)",
    );
  }
  lines.push("");
  if (!hasClient) {
    lines.push("  ! Client build not found — run `pnpm build` to serve the UI.");
    lines.push("    The API and sockets are running in the meantime.");
    lines.push("");
  }
  console.log(lines.join("\n"));

  const primary = urls[0];
  if (!primary) return;
  const scanUrl = frag(primary);
  try {
    const matrix = encodeQR(scanUrl);
    console.log(renderQRToTerminal(matrix, { quietZone: 2 }));
    console.log(`  Scan to open on your phone:  ${clickable(scanUrl)}`);
    console.log("");
  } catch {
    console.log(`  (QR skipped — URL exceeds encoder capacity: ${scanUrl})`);
    console.log("");
  }
}
