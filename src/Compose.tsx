import { useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  PaperAirplaneIcon,
  DocumentIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { PendingAttachment } from "./App";
import { humanSize, middleTruncate } from "./util";

interface Props {
  connected: boolean;
  sending: boolean;
  attachments: PendingAttachment[];
  /** Server's max text broadcast size in UTF-8 bytes (from /api/info). */
  maxTextBytes: number;
  /** Emit text (null when the box is empty), then upload staged attachments. */
  onBroadcast: (html: string | null) => void | Promise<void>;
  onRemoveAttachment: (localId: string) => void;
}

export default function Compose({
  connected,
  sending,
  attachments,
  maxTextBytes,
  onBroadcast,
  onRemoveAttachment,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [tooBig, setTooBig] = useState<string | null>(null);

  const hasAttachments = attachments.length > 0;
  const disabled = sending || !connected || (empty && !hasAttachments);

  const syncEmpty = () => {
    const el = ref.current;
    setEmpty(!el || el.textContent?.trim() === "");
    setTooBig(null);
  };

  const broadcast = () => {
    const el = ref.current;
    if (!el || disabled) return;
    const hasText = el.textContent?.trim() !== "";
    const html = hasText ? el.innerHTML : null;
    // The server silently drops oversize text — check before clearing the
    // box so the user's content is never lost.
    if (html) {
      const bytes = new TextEncoder().encode(html).length;
      if (bytes > maxTextBytes) {
        setTooBig(
          `Too big to send (${humanSize(bytes)} — the limit is ${humanSize(maxTextBytes)}). Try attaching it as a file instead.`,
        );
        return;
      }
    }
    // Clear the box up front: the text is emitted synchronously, so a retry
    // after a failed attachment upload must not re-send it.
    if (hasText) {
      el.innerHTML = "";
      setEmpty(true);
    }
    setTooBig(null);
    void onBroadcast(html);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      broadcast();
    }
  };

  // Sanitize pasted markup before it enters the editable DOM, so things like
  // <img onerror> from a malicious copy source never execute locally.
  const onPaste = (e: React.ClipboardEvent) => {
    // File pastes are handled by the app-wide upload handler.
    if (e.clipboardData.files.length > 0) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment: Node = html
      ? DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true })
      : document.createTextNode(text);
    const last = fragment.lastChild ?? fragment;
    if (last === fragment && fragment.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      // Sanitizer stripped everything — nothing to insert.
      syncEmpty();
      return;
    }
    range.insertNode(fragment);
    // Move the caret after the inserted content.
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncEmpty();
  };

  return (
    <div className="flex flex-1 flex-col">
      <label className="mb-2 text-sm font-medium text-gray-600 dark:text-gray-400">
        Compose
      </label>
      <div
        ref={ref}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Compose message"
        onInput={syncEmpty}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        data-placeholder="Type or paste rich text, then broadcast to every device…"
        className="min-h-40 flex-1 overflow-auto rounded-lg border border-gray-300 bg-white p-4 text-gray-900 outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-200 empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30 dark:empty:before:text-gray-500"
      />

      {tooBig && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {tooBig}
        </p>
      )}

      {hasAttachments && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <li key={att.localId} className="relative">
              {att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.file.name}
                  className="size-16 rounded-lg border border-gray-200 object-cover dark:border-gray-700"
                />
              ) : (
                <div className="flex max-w-56 items-center gap-2 rounded-lg border border-gray-200 bg-white py-2 pl-2.5 pr-8 dark:border-gray-700 dark:bg-gray-800">
                  <span className="grid size-9 shrink-0 place-items-center rounded bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                    <DocumentIcon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                      {middleTruncate(att.file.name, 22)}
                    </span>
                    <span className="block text-xs text-gray-400 dark:text-gray-500">
                      {humanSize(att.file.size)}
                    </span>
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemoveAttachment(att.localId)}
                disabled={sending}
                aria-label={`Remove ${att.file.name}`}
                title="Remove"
                className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
              >
                <XMarkIcon className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Press{" "}
          <kbd className="rounded border border-gray-300 bg-gray-50 px-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            ⌘/Ctrl
          </kbd>{" "}
          +{" "}
          <kbd className="rounded border border-gray-300 bg-gray-50 px-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            Enter
          </kbd>{" "}
          to send
        </span>
        <button
          type="button"
          onClick={broadcast}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-400"
        >
          <PaperAirplaneIcon className="size-4" aria-hidden="true" />
          {sending ? "Sending…" : "Broadcast"}
        </button>
      </div>
    </div>
  );
}
