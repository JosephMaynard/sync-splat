import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import {
  ClipboardDocumentIcon,
  CheckIcon,
  EyeIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  DocumentIcon,
} from "@heroicons/react/24/outline";
import type { Item } from "../shared/types";
import { INLINE_IMAGE_MIMES } from "../shared/types";
import {
  humanSize,
  middleTruncate,
  htmlToPlainText,
  isPreviewable,
} from "./util";
import { withKey } from "./auth";
import PreviewModal, { type PreviewTarget } from "./PreviewModal";

interface Props {
  item: Item;
  onDelete: (id: string) => void;
}

function isInlineImage(mime: string): boolean {
  return (INLINE_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** Copy rich text with a robust fallback chain that works on http:// phones. */
async function copyHtml(html: string): Promise<boolean> {
  const plain = htmlToPlainText(html);

  // 1) Rich clipboard (html + plain).
  try {
    if (navigator.clipboard && "write" in navigator.clipboard) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
  } catch {
    /* fall through */
  }

  // 2) Plain-text clipboard.
  try {
    if (navigator.clipboard && "writeText" in navigator.clipboard) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
  } catch {
    /* fall through */
  }

  // 3) Legacy hidden-textarea + execCommand — the only path that works over
  //    http:// from many phones (clipboard API needs a secure context).
  const ta = document.createElement("textarea");
  try {
    ta.value = plain;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Remove in finally so a throwing execCommand can't leak the node.
    ta.remove();
  }
}

const iconButton =
  "relative inline-flex items-center bg-white px-2.5 py-2 text-gray-500 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-gray-700";

export default function HistoryItem({ item, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const cleanHtml = item.kind === "text" ? DOMPurify.sanitize(item.html) : "";
  const canPreview =
    item.kind === "text" || isPreviewable(item.name, item.mime);

  const handleCopy = async () => {
    if (item.kind !== "text") return;
    // Copy the sanitized HTML — what we render, not the raw payload.
    const ok = await copyHtml(cleanHtml);
    if (ok) setCopied(true);
  };

  const previewTarget: PreviewTarget =
    item.kind === "text"
      ? { type: "text", html: cleanHtml, title: "Splat" }
      : {
          type: "file",
          name: item.name,
          mime: item.mime,
          url: `/api/file/${item.id}`,
        };

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        {item.kind === "text" ? (
          <div
            className="prose-sm max-h-16 min-w-0 flex-1 overflow-hidden text-sm text-gray-700 [&_*]:!my-0 dark:text-gray-200"
            dangerouslySetInnerHTML={{ __html: cleanHtml }}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isInlineImage(item.mime) ? (
              <img
                src={withKey(`/api/file/${item.id}`)}
                alt={item.name}
                loading="lazy"
                className="max-h-14 w-14 shrink-0 rounded object-cover"
              />
            ) : (
              <span className="grid size-11 shrink-0 place-items-center rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <DocumentIcon className="size-6" aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                {middleTruncate(item.name)}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {humanSize(item.size)}
              </p>
            </div>
          </div>
        )}

        <span className="isolate inline-flex shrink-0 rounded-md shadow-sm">
          {item.kind === "text" ? (
            <>
              <button
                type="button"
                className={`${iconButton} rounded-l-md`}
                title={copied ? "Copied!" : "Copy to clipboard"}
                onClick={handleCopy}
              >
                <span className="sr-only">Copy to clipboard</span>
                {copied ? (
                  <CheckIcon className="size-5 text-green-600" aria-hidden="true" />
                ) : (
                  <ClipboardDocumentIcon className="size-5" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className={`${iconButton} -ml-px`}
                title="Preview"
                onClick={() => setOpen(true)}
              >
                <span className="sr-only">Preview</span>
                <EyeIcon className="size-5" aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              {canPreview && (
                <button
                  type="button"
                  className={`${iconButton} rounded-l-md`}
                  title="Preview"
                  onClick={() => setOpen(true)}
                >
                  <span className="sr-only">Preview</span>
                  <EyeIcon className="size-5" aria-hidden="true" />
                </button>
              )}
              <a
                href={withKey(`/api/file/${item.id}`)}
                download={item.name}
                className={`${iconButton} ${canPreview ? "-ml-px" : "rounded-l-md"}`}
                title="Download"
              >
                <span className="sr-only">Download</span>
                <ArrowDownTrayIcon className="size-5" aria-hidden="true" />
              </a>
            </>
          )}
          <button
            type="button"
            className={`${iconButton} -ml-px rounded-r-md hover:text-red-600 dark:hover:text-red-400`}
            title="Delete"
            onClick={() => onDelete(item.id)}
          >
            <span className="sr-only">Delete</span>
            <TrashIcon className="size-5" aria-hidden="true" />
          </button>
        </span>
      </div>

      {open && (
        <PreviewModal target={previewTarget} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
