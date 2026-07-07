import { encodeQR, renderQRToTerminal } from "../qr/src";
import { VERSION } from "./net";

export interface BannerInfo {
  port: number;
  urls: string[];
  hasClient: boolean;
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
    `  Local:    http://localhost:${port}`,
  ];
  for (const url of urls) {
    lines.push(`  Network:  ${url}`);
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
    console.log(`  Scan to open on your phone:  ${primary}`);
    console.log("");
  } catch {
    console.log(`  (QR skipped — URL exceeds encoder capacity: ${primary})`);
    console.log("");
  }
}
