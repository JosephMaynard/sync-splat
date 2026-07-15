import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { encodeQR, renderQRToSvg } from "../qr/src";
import type { ServerInfo } from "../shared/types";

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

export default function QrModal({ onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/info");
        if (!res.ok) throw new Error(`info ${res.status}`);
        const info: ServerInfo = await res.json();
        const chosen = pickUrl(info.urls);
        if (cancelled) return;
        setUrl(chosen);
        if (!chosen) {
          setError("No LAN address available.");
          return;
        }
        try {
          const matrix = encodeQR(chosen);
          const rawSvg = renderQRToSvg(matrix, { dark: "#111827", light: "#ffffff" });
          const clean = DOMPurify.sanitize(rawSvg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          if (!cancelled) setSvg(clean);
        } catch {
          // encodeQR throws when the URL exceeds QR capacity — show text only.
          if (!cancelled) setSvg(null);
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-800 dark:bg-gray-900"
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
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
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
              <a
                href={url}
                className="break-all text-center text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                {url}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
