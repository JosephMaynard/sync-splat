import os from "node:os";

/** Injected at build time from package.json by scripts/build-server.mjs, so
 *  the version lives in exactly one place. "dev" under vitest/tsc, which run
 *  the TypeScript directly with no define step. */
declare const __VERSION__: string | undefined;
export const VERSION =
  typeof __VERSION__ === "string" ? __VERSION__ : "dev";

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
  // The banner and QR modal advertise the mDNS name — browsers reaching us
  // through it send it as their Origin hostname, so it must be allowed too.
  const mdns = mdnsHostname();
  if (mdns) {
    allowed.add(mdns);
    allowed.add(mdns.replace(/\.local$/, ""));
  }
  return allowed;
}

/** This machine's mDNS hostname, lowercased, always ending in ".local".
 *  Null when the OS reports no hostname. */
function mdnsHostname(): string | null {
  let host = os.hostname().toLowerCase();
  if (!host) return null;
  if (!host.endsWith(".local")) host += ".local";
  return host;
}

/**
 * Stable mDNS URL for this machine: `http://<hostname>.local:<port>`. On
 * networks with an mDNS responder (macOS/iOS and most modern systems) this
 * name resolves regardless of the current DHCP-assigned IP, so it survives
 * Wi-Fi changes. Returns null when the hostname is empty.
 */
export function getMdnsUrl(port: number): string | null {
  const host = mdnsHostname();
  if (!host) return null;
  return `http://${host}:${port}`;
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
