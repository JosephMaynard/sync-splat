import { useRef, useState } from "react";
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

  return (
    <div className="flex flex-1 flex-col">
      <label className="mb-2 text-sm font-medium text-gray-600">
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
        data-placeholder="Type or paste rich text, then broadcast to every device…"
        className="min-h-40 flex-1 overflow-auto rounded-lg border border-gray-300 bg-white p-4 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)]"
      />
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-gray-400">
          Press{" "}
          <kbd className="rounded border border-gray-300 bg-gray-50 px-1">
            ⌘/Ctrl
          </kbd>{" "}
          +{" "}
          <kbd className="rounded border border-gray-300 bg-gray-50 px-1">
            Enter
          </kbd>{" "}
          to send
        </span>
        <button
          type="button"
          onClick={broadcast}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PaperAirplaneIcon className="size-4" aria-hidden="true" />
          Broadcast
        </button>
      </div>
    </div>
  );
}
