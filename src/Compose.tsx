import { useRef, useState } from "react";
import DOMPurify from "dompurify";
import { PaperAirplaneIcon } from "@heroicons/react/24/outline";

interface Props {
  connected: boolean;
  onSend: (html: string) => void;
}

export default function Compose({ connected, onSend }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);

  const disabled = empty || !connected;

  const syncEmpty = () => {
    const el = ref.current;
    setEmpty(!el || el.textContent?.trim() === "");
  };

  const broadcast = () => {
    const el = ref.current;
    if (!el || disabled) return;
    const html = el.innerHTML;
    if (el.textContent?.trim() === "") return;
    onSend(html);
    el.innerHTML = "";
    setEmpty(true);
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
        className="min-h-40 flex-1 overflow-auto rounded-lg border border-gray-300 bg-white p-4 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30 dark:empty:before:text-gray-500"
      />
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
          Broadcast
        </button>
      </div>
    </div>
  );
}
