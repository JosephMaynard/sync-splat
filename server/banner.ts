import { encodeQR, renderQRToTerminal } from "../qr/src";
import { VERSION } from "./net";

export interface BannerInfo {
  port: number;
  urls: string[];
  hasClient: boolean;
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
  const { port, urls, hasClient } = info;
  const lines: string[] = [
    "",
    `  sync-splat v${VERSION}`,
    "  Share text and files across your local network.",
    "",
    `  Local:    ${clickable(`http://localhost:${port}`)}`,
  ];
  for (const url of urls) {
    lines.push(`  Network:  ${clickable(url)}`);
  }
  if (urls.length === 0) {
    lines.push("  Network:  (no LAN interface detected)");
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
  try {
    const matrix = encodeQR(primary);
    console.log(renderQRToTerminal(matrix, { quietZone: 2 }));
    console.log(`  Scan to open on your phone:  ${clickable(primary)}`);
    console.log("");
  } catch {
    console.log(`  (QR skipped — URL exceeds encoder capacity: ${primary})`);
    console.log("");
  }
}
