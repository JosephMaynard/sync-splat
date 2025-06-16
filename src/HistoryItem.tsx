import { useState } from "react";
import type { HistoryItemData } from "./types";

interface Props {
  item: HistoryItemData;
  onDelete: () => void;
}

export default function HistoryItem({ item, onDelete }: Props) {
  const [open, setOpen] = useState(false);

  const previewText =
    item.type === "html"
      ? item.data.replace(/<[^>]+>/g, "").slice(0, 50) + "…"
      : item.type;

  const copyToClipboard = async () => {
    if (item.type === "html") {
      await navigator.clipboard.writeText(item.data);
    }
    // extend for other types (images, files) later
  };

  return (
    <>
      {/* list row */}
      <div className="p-3 border rounded bg-white shadow flex justify-between items-center">
        <span className="truncate mr-2">{previewText}</span>

        <div className="space-x-1">
          <button onClick={copyToClipboard} className="btn">
            Copy
          </button>
          <button onClick={() => setOpen(true)} className="btn">
            Preview
          </button>
          <button onClick={onDelete} className="btn text-red-500">
            ✕
          </button>
        </div>
      </div>

      {/* modal */}
      {open && (
        <div className="fixed inset-0 bg-black/60 grid place-items-center z-50">
          <div className="bg-white p-6 max-w-lg max-h-[80vh] overflow-auto rounded">
            <button
              className="mb-2 ml-auto block text-sm text-gray-500"
              onClick={() => setOpen(false)}
            >
              Close
            </button>

            {item.type === "html" && (
              <div dangerouslySetInnerHTML={{ __html: item.data }} />
            )}

            {item.type === "image" && (
              <img src={item.data} alt="Clipboard item" />
            )}
          </div>
        </div>
      )}
    </>
  );
}