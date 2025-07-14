import { useState } from "react";
import type { HistoryItemData } from "./types";
import {
    DocumentDuplicateIcon,
    EyeIcon,
    TrashIcon,
} from "@heroicons/react/24/outline";

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

    /**
     * Copies the item to clipboard preserving rich‑text (HTML) *and*
     * a plain‑text fallback.  If the browser doesn’t support
     * `navigator.clipboard.write`, we gracefully fall back to
     * `writeText(plain)`.
     */
    const copyToClipboard = async () => {
        if (item.type !== "html") return;

        // --- prepare HTML ---
        const rawHtml = item.data;

        // remove the outermost wrapper <div> added by contentEditable,
        // but keep the original inner markup (colours, <br>, etc.)
        const tmp = document.createElement("div");
        tmp.innerHTML = rawHtml;
        const maybeWrapped =
            tmp.childElementCount === 1 &&
            tmp.firstElementChild?.tagName === "DIV";
        const htmlToCopy = maybeWrapped
            ? (tmp.firstElementChild as HTMLElement).innerHTML
            : rawHtml;

        // --- plain‑text version for fall‑back / other apps ---
        const plainText = tmp.innerText;

        try {
            if ("clipboard" in navigator && "write" in navigator.clipboard) {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/html": new Blob([htmlToCopy], {
                            type: "text/html",
                        }),
                        "text/plain": new Blob([plainText], {
                            type: "text/plain",
                        }),
                    }),
                ]);
            } else {
                // legacy / insecure context
                await navigator.clipboard.writeText(plainText);
            }
        } catch (err) {
            console.error("Clipboard write failed", err);
        }
    };

    return (
        <>
            {/* list row */}
            <div className="p-3 border-gray-300 border rounded bg-white shadow flex justify-between items-center">
                <span className="truncate mr-2">{previewText}</span>

                <div className="space-x-1">
                    <span className="isolate inline-flex rounded-md shadow-sm">
                        <button
                            type="button"
                            className="relative inline-flex items-center rounded-l-md bg-white px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-10"
                            title="Copy to clipboard"
                            onClick={copyToClipboard}
                        >
                            <span className="sr-only">Copy to clipboard</span>
                            <DocumentDuplicateIcon
                                aria-hidden="true"
                                className="size-5"
                            />
                        </button>
                        <button
                            type="button"
                            className="relative -ml-px inline-flex items-center  bg-white px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-10"
                            title="Preview"
                            onClick={() => setOpen(true)}
                        >
                            <span className="sr-only">Preview</span>
                            <EyeIcon aria-hidden="true" className="size-5" />
                        </button>
                        <button
                            type="button"
                            className="relative -ml-px inline-flex items-center rounded-r-md bg-white px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-10"
                            title="Delete"
                            onClick={onDelete}
                        >
                            <span className="sr-only">Delete</span>
                            <TrashIcon aria-hidden="true" className="size-5" />
                        </button>
                    </span>
                </div>
            </div>

            {/* modal */}
            {open && (
                <div className="fixed inset-0 bg-black/60 grid place-items-center z-50">
                    <div className="bg-white p-6 max-w-2xl max-h-[80vh] overflow-auto rounded">
                        <button
                            className="mb-2 ml-auto block text-sm text-gray-500"
                            onClick={() => setOpen(false)}
                        >
                            Close
                        </button>

                        {item.type === "html" && (
                            <div
                                dangerouslySetInnerHTML={{ __html: item.data }}
                            />
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
