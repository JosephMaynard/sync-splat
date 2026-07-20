import os from "node:os";

/** Package version. Hardcoded because esbuild bundling makes reading
 *  package.json at runtime unreliable. Keep in sync with package.json. */
export const VERSION = "0.1.1";

/**
 * Hostnames a browser Origin may legitimately carry when talking to this
 * machine: localhost variants plus every interface address, enumerated fresh
 * on each call so DHCP/Wi-Fi changes are picked up. The request's Host
 * header is deliberately NOT used as a trust anchor — DNS rebinding lets an
 * attacker make Origin and Host agree on a hostname they control, but it can
 * never make the Origin's hostname be one of this machine's own addresses.
 */
export function getAllowedHostnames(): Set<string> {
  const allowed = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      allowed.add(iface.address.toLowerCase());
    }
  }
  return allowed;
}

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
