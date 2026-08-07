import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderIcon,
  DocumentIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import type { ShareListing } from "../shared/types";
import { humanSize, middleTruncate } from "./util";

interface Props {
  /** Root folder name (from /api/info share.name) — the first breadcrumb. */
  shareName: string;
  /** Server's max upload size in bytes (from /api/info) for the pre-check. */
  maxFileBytes: number;
}

/** Join the current path segments into the relative query value ("" = root). */
function relPath(segments: string[]): string {
  return segments.join("/");
}

export default function ShareBrowser({ shareName, maxFileBytes }: Props) {
  const [path, setPath] = useState<string[]>([]);
  const [listing, setListing] = useState<ShareListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Bumped to force a re-fetch after an upload or a retry.
  const [reloadNonce, setReloadNonce] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rel = relPath(path);

  /* Fetch the current directory listing on mount, navigation, and reload.
   * `loading`/`error` are primed by the navigation handlers below, so the
   * effect body only writes state asynchronously (once the fetch settles). */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/ls?path=${encodeURIComponent(rel)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`ls ${r.status}`);
        return r.json();
      })
      .then((data: ShareListing) => {
        if (cancelled) return;
        setListing(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load this folder.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rel, reloadNonce]);

  /* auto-dismiss upload errors, matching the compose column's behaviour */
  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(null), 5000);
    return () => clearTimeout(t);
  }, [uploadError]);

  const openDir = useCallback((name: string) => {
    setLoading(true);
    setError(null);
    setPath((prev) => [...prev, name]);
  }, []);

  const jumpTo = useCallback((depth: number) => {
    // depth 0 = root; depth n = keep the first n segments.
    setLoading(true);
    setError(null);
    setPath((prev) => prev.slice(0, depth));
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  /* Upload staged files straight into the current directory. Same fetch shape
   * as the clipboard uploads; re-fetch the listing when done. */
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      setUploadError(null);
      const list = Array.from(files);
      for (const f of list) {
        if (f.size > maxFileBytes) {
          setUploadError(
            `"${f.name}" is too big (${humanSize(f.size)}). Max is ${humanSize(maxFileBytes)}.`,
          );
          return;
        }
      }
      setUploading(true);
      // One failure must not silently drop the rest of the batch: keep
      // uploading and report every failed name at the end.
      const failed: string[] = [];
      try {
        for (const f of list) {
          try {
            const res = await fetch(
              `/api/share/upload?dir=${encodeURIComponent(rel)}&name=${encodeURIComponent(f.name)}`,
              {
                method: "POST",
                body: f,
                headers: {
                  "Content-Type": f.type || "application/octet-stream",
                },
              },
            );
            if (!res.ok) {
              failed.push(
                res.status === 413 ? `"${f.name}" (too big)` : `"${f.name}" (${res.status})`,
              );
            }
          } catch {
            failed.push(`"${f.name}" (network error)`);
          }
        }
        if (failed.length > 0) {
          setUploadError(
            failed.length === list.length
              ? `Upload failed: ${failed.join(", ")}`
              : `Some uploads failed: ${failed.join(", ")}`,
          );
        }
      } finally {
        setUploading(false);
        reload();
      }
    },
    [rel, maxFileBytes, reload],
  );

  const entries = listing?.entries ?? [];

  return (
    <div className="flex min-h-0 flex-col">
      {/* breadcrumbs + upload */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <nav
          aria-label="Folder path"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm text-gray-500 dark:text-gray-400"
        >
          {path.length === 0 ? (
            <span className="font-medium text-gray-700 dark:text-gray-200">
              {shareName}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => jumpTo(0)}
              className="rounded font-medium text-blue-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-blue-400"
            >
              {shareName}
            </button>
          )}
          {path.map((seg, i) => {
            const isLast = i === path.length - 1;
            return (
              <span key={i} className="flex min-w-0 items-center gap-0.5">
                <ChevronRightIcon
                  className="size-4 shrink-0 text-gray-300 dark:text-gray-600"
                  aria-hidden="true"
                />
                {isLast ? (
                  <span className="truncate font-medium text-gray-700 dark:text-gray-200">
                    {seg}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => jumpTo(i + 1)}
                    className="truncate rounded text-blue-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-blue-400"
                  >
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <ArrowUpTrayIcon className="size-5" aria-hidden="true" />
          {uploading ? "Uploading…" : "Upload here"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploadError && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
        >
          {uploadError}
        </p>
      )}

      {loading ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500">
          Loading…
        </p>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center dark:border-gray-700 dark:bg-gray-900">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500">
          This folder is empty.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) =>
            entry.kind === "dir" ? (
              <li key={`d/${entry.name}`}>
                <button
                  type="button"
                  onClick={() => openDir(entry.name)}
                  className="flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm hover:border-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-500"
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    <FolderIcon className="size-6" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                      {middleTruncate(entry.name)}
                    </span>
                    <span className="block text-xs text-gray-400 dark:text-gray-500">
                      Folder
                    </span>
                  </span>
                  <ChevronRightIcon
                    className="size-5 shrink-0 text-gray-300 dark:text-gray-600"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ) : (
              <li
                key={`f/${entry.name}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    <DocumentIcon className="size-6" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                      {middleTruncate(entry.name)}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {humanSize(entry.size)}
                    </p>
                  </div>
                </div>
                <a
                  href={`/api/share/dl?path=${encodeURIComponent(
                    relPath([...path, entry.name]),
                  )}`}
                  download={entry.name}
                  className="inline-flex shrink-0 items-center rounded-md bg-white px-2.5 py-2 text-gray-500 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-gray-700"
                  title="Download"
                >
                  <span className="sr-only">Download {entry.name}</span>
                  <ArrowDownTrayIcon className="size-5" aria-hidden="true" />
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
