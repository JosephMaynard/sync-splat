import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
// The "common" subset (~40 languages) covers our preview extensions at a
// fraction of the full package's bundle size; unknown types fall back to
// highlightAuto over that same set.
import hljs from "highlight.js/lib/common";
import { XMarkIcon, ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { LIMITS } from "../shared/types";
import { authHeaders, withKey } from "./auth";
import { useModalA11y } from "./useModalA11y";
import {
  classifyPreview,
  fileExtension,
  hljsLanguageForExtension,
  humanSize,
} from "./util";

/** What the modal is showing. Text splats arrive already sanitized. */
export type PreviewTarget =
  | { type: "text"; html: string; title?: string }
  | { type: "file"; name: string; mime: string; url: string };

interface Props {
  target: PreviewTarget;
  onClose: () => void;
}

type Loaded =
  | { state: "loading" }
  | { state: "html"; html: string }
  | { state: "code"; html: string }
  | { state: "fallback"; reason: string };

/**
 * Fetch a text file for markdown/code rendering, capped at maxPreviewBytes.
 * Streams the body and aborts as soon as the cap is exceeded, so a server that
 * sends no Content-Length (or a wrong one) can't make us buffer a huge file.
 */
async function fetchCappedText(url: string): Promise<string> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.maxPreviewBytes) {
    throw new Error("too-big");
  }
  if (!res.body) {
    // No stream (unusual) — fall back to buffered read with a post-check.
    const text = await res.text();
    if (new TextEncoder().encode(text).length > LIMITS.maxPreviewBytes) {
      throw new Error("too-big");
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.maxPreviewBytes) {
        await reader.cancel();
        throw new Error("too-big");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export default function PreviewModal({ target, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y(containerRef, onClose);

  const [loaded, setLoaded] = useState<Loaded>(() =>
    target.type === "text"
      ? { state: "html", html: target.html }
      : { state: "loading" },
  );

  const kind =
    target.type === "file"
      ? classifyPreview(target.name, target.mime)
      : "text";

  // Stable primitives for the fetch effect's deps, so a parent passing a fresh
  // target object (same values) doesn't retrigger a refetch.
  const fileUrl = target.type === "file" ? target.url : null;
  const fileName = target.type === "file" ? target.name : null;

  useEffect(() => {
    // Only file targets fetch; images render natively via <img>.
    if (fileUrl === null || fileName === null) return;
    if (kind === "image" || kind === "none") return;

    // `loaded` already initializes to "loading" for file targets, and this
    // modal is mounted fresh per open, so no synchronous reset is needed here.
    let cancelled = false;
    (async () => {
      try {
        // fetchCappedText sends the X-Splat-Key header, so no ?k= needed here;
        // withKey stays for <img>/<a> URLs that can't set headers.
        const text = await fetchCappedText(fileUrl);
        if (cancelled) return;
        if (kind === "markdown") {
          const rendered = marked.parse(text, { async: false }) as string;
          setLoaded({
            state: "html",
            html: DOMPurify.sanitize(rendered),
          });
        } else {
          const ext = fileExtension(fileName);
          const lang = hljsLanguageForExtension(ext);
          const highlighted =
            lang && hljs.getLanguage(lang)
              ? hljs.highlight(text, { language: lang }).value
              : hljs.highlightAuto(text).value;
          setLoaded({
            state: "code",
            html: DOMPurify.sanitize(highlighted),
          });
        }
      } catch (err) {
        if (cancelled) return;
        const reason =
          err instanceof Error && err.message === "too-big"
            ? `This file is larger than ${humanSize(LIMITS.maxPreviewBytes)} — download it to view.`
            : "Couldn't load a preview for this file — download it instead.";
        setLoaded({ state: "fallback", reason });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Stable primitives, not the target object identity, so a parent re-render
    // that passes a fresh object doesn't refetch.
  }, [
    fileUrl,
    fileName,
    kind,
  ]);

  const title =
    target.type === "file" ? target.name : (target.title ?? "Preview");
  const downloadUrl = target.type === "file" ? withKey(target.url) : null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl outline-hidden dark:border dark:border-gray-800 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-800">
          <h2 className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {downloadUrl && (
              <a
                href={downloadUrl}
                download={target.type === "file" ? target.name : undefined}
                className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                title="Download"
              >
                <span className="sr-only">Download</span>
                <ArrowDownTrayIcon className="size-5" aria-hidden="true" />
              </a>
            )}
            <button
              type="button"
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              onClick={onClose}
              aria-label="Close"
            >
              <XMarkIcon className="size-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {target.type === "file" && kind === "image" ? (
            <img
              src={withKey(target.url)}
              alt={target.name}
              className="mx-auto max-h-full max-w-full rounded-lg object-contain"
            />
          ) : loaded.state === "loading" ? (
            <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
              Loading preview…
            </p>
          ) : loaded.state === "fallback" ? (
            <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {loaded.reason}
            </p>
          ) : loaded.state === "code" ? (
            <pre className="overflow-auto rounded-lg bg-gray-50 p-4 text-xs leading-relaxed dark:bg-gray-950/60">
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: loaded.html }}
              />
            </pre>
          ) : (
            <div
              className={
                target.type === "text"
                  ? "text-gray-800 dark:text-gray-200"
                  : "md-preview text-gray-800 dark:text-gray-200"
              }
              dangerouslySetInnerHTML={{ __html: loaded.html }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
