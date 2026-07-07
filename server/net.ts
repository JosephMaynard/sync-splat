import os from "node:os";

/** Package version. Hardcoded because esbuild bundling makes reading
 *  package.json at runtime unreliable. Keep in sync with package.json. */
export const VERSION = "0.1.0";

/** All non-internal IPv4 URLs the server is reachable on for a given port. */
export function getLanUrls(port: number): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      // Node <18 reported family as a number (4); >=18 uses the string "IPv4".
      const isIPv4 = iface.family === "IPv4" || (iface.family as unknown) === 4;
      if (isIPv4 && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  }
  return urls;
}
