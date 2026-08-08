import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { XMarkIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { encodeQR, renderQRToSvg } from "../qr/src";
import type { ServerInfo } from "../shared/types";
import { AUTH } from "../shared/types";
import { authHeaders, getToken } from "./auth";
import { useModalA11y } from "./useModalA11y";

interface Props {
  onClose: () => void;
}

/** Pick the URL whose host matches the current page host, else the first. */
function pickUrl(urls: string[]): string | null {
  if (urls.length === 0) return null;
  const match = urls.find((u) => {
    try {
      return new URL(u).hostname === location.hostname;
    } catch {
      return false;
    }
  });
  return match ?? urls[0];
}

/** Embed the passcode in the URL fragment so a scan authenticates automatically.
 *  No-op when there's no passcode. */
function withKeyFragment(url: string): string {
  const token = getToken();
  return token
    ? `${url}#${AUTH.fragmentParam}=${encodeURIComponent(token)}`
    : url;
}

export default function QrModal({ onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [mdnsUrl, setMdnsUrl] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Monotonic request version: the initial /api/info fetch and any number of
  // refresh clicks may race; only the most recently started request may
  // update state, so a slow stale response can't overwrite a fresh one.
  const requestVersion = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dialog focus trap + Escape + focus restore.
  useModalA11y(containerRef, onClose);

  /* Render the QR + URLs from a fresh ServerInfo payload. */
  const applyInfo = useCallback((info: ServerInfo) => {
    // No LAN address (Wi-Fi off, cable unplugged)? The mDNS URL still works
    // for local mDNS-capable devices — promote it to primary rather than
    // showing an error, and don't repeat it as the secondary line.
    const lan = pickUrl(info.urls);
    const chosen = lan ?? info.mdnsUrl;
    setUrl(chosen);
    setMdnsUrl(lan ? info.mdnsUrl : null);
    if (!chosen) {
      setError("No LAN address available.");
      setSvg(null);
      return;
    }
    setError(null);
    try {
      const matrix = encodeQR(withKeyFragment(chosen));
      const rawSvg = renderQRToSvg(matrix, { dark: "#111827", light: "#ffffff" });
      const clean = DOMPurify.sanitize(rawSvg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      setSvg(clean);
    } catch {
      // encodeQR throws when the URL exceeds QR capacity — show text only.
      setSvg(null);
    }
  }, []);

  useEffect(() => {
    const version = ++requestVersion.current;
    (async () => {
      try {
        const res = await fetch("/api/info", { headers: authHeaders() });
        if (!res.ok) throw new Error(`info ${res.status}`);
        const info: ServerInfo = await res.json();
        if (requestVersion.current === version) applyInfo(info);
      } catch {
        if (requestVersion.current === version) {
          setError("Could not reach the server.");
        }
      }
    })();
    return () => {
      // Invalidate in-flight work on unmount.
      requestVersion.current += 1;
    };
  }, [applyInfo]);

  /* Re-enumerate the network after a Wi-Fi change and re-render from the
   * response (also reprints the banner + QR in the terminal server-side). */
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/network/refresh", {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      const info: ServerInfo = await res.json();
      if (requestVersion.current === version) applyInfo(info);
    } catch {
      if (requestVersion.current === version) {
        setRefreshError("Couldn't refresh — is the server still running?");
      }
    } finally {
      if (requestVersion.current === version) setRefreshing(false);
    }
  }, [applyInfo]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Scan to open on another device"
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-xl bg-white p-6 shadow-xl outline-hidden dark:border dark:border-gray-800 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="absolute right-3 top-3 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          onClick={onClose}
          aria-label="Close"
        >
          <XMarkIcon className="size-5" aria-hidden="true" />
        </button>

        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
          Scan to open on another device
        </h2>

        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-4">
            {svg ? (
              /* Keep the QR on a white tile even in dark mode so scanners
                 retain the contrast they need. */
              <div
                className="w-56 rounded-lg bg-white p-3 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {url ? "QR unavailable — use the address below." : "Loading…"}
              </p>
            )}
            {url && (
              <div className="flex flex-col items-center gap-1">
                <a
                  href={url}
                  className="break-all text-center text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {url}
                </a>
                {mdnsUrl && (
                  <a
                    href={mdnsUrl}
                    className="break-all text-center text-xs text-gray-500 hover:underline dark:text-gray-400"
                  >
                    {mdnsUrl}
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex flex-col items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <ArrowPathIcon
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {refreshing ? "Refreshing…" : "Wi-Fi changed? Refresh"}
          </button>
          {refreshError && (
            <p
              role="alert"
              className="text-center text-xs text-red-600 dark:text-red-400"
            >
              {refreshError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
