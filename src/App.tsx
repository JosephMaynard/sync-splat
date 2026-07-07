import { useCallback, useEffect, useRef, useState } from "react";
import {
  QrCodeIcon,
  PaperClipIcon,
  ArrowUpTrayIcon,
} from "@heroicons/react/24/outline";
import { socket } from "./socket";
import type { Item, ServerInfo } from "../shared/types";
import { LIMITS } from "../shared/types";
import HistoryItem from "./HistoryItem";
import Compose from "./Compose";
import QrModal from "./QrModal";
import Logo from "./Logo";
import { humanSize } from "./util";

export default function App() {
  const [history, setHistory] = useState<Item[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [showQr, setShowQr] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [maxFileBytes, setMaxFileBytes] = useState(LIMITS.maxFileBytes);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  /* socket lifecycle */
  useEffect(() => {
    const onHistory = (items: Item[]) => setHistory(items);
    const onNew = (item: Item) => setHistory((prev) => [item, ...prev]);
    const onDeleted = (id: string) =>
      setHistory((prev) => prev.filter((it) => it.id !== id));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on("history", onHistory);
    socket.on("item:new", onNew);
    socket.on("item:deleted", onDeleted);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("history", onHistory);
      socket.off("item:new", onNew);
      socket.off("item:deleted", onDeleted);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  /* fetch limits so we can pre-check file sizes */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info: ServerInfo | null) => {
        if (!cancelled && info) setMaxFileBytes(info.maxFileBytes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /* auto-dismiss upload errors */
  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(null), 5000);
    return () => clearTimeout(t);
  }, [uploadError]);

  const sendText = useCallback((html: string) => {
    socket.emit("text:send", { html });
  }, []);

  const deleteItem = useCallback((id: string) => {
    socket.emit("item:delete", id);
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      setUploadError(null);
      if (file.size > maxFileBytes) {
        setUploadError(
          `"${file.name}" is too big (${humanSize(file.size)}). Max is ${humanSize(maxFileBytes)}.`,
        );
        return;
      }
      try {
        const res = await fetch(
          `/api/upload?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            body: file,
            headers: {
              "Content-Type": file.type || "application/octet-stream",
            },
          },
        );
        if (!res.ok) {
          if (res.status === 413) {
            setUploadError(`"${file.name}" is too big.`);
          } else {
            setUploadError(`Upload failed (${res.status}).`);
          }
        }
        // On success the server broadcasts item:new — no local insert needed.
      } catch {
        setUploadError("Upload failed — is the server still running?");
      }
    },
    [maxFileBytes],
  );

  const uploadFiles = useCallback(
    (files: FileList | File[]) => {
      // Sequential so multi-file drops don't race the server or each other's
      // error reporting; fire-and-forget from the caller's perspective.
      void (async () => {
        for (const f of Array.from(files)) await uploadFile(f);
      })();
    },
    [uploadFile],
  );

  /* drag-and-drop onto the whole page */
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      // Only intercept drops that carry files — plain text/link drops must
      // keep working (e.g. dragging text into the compose box).
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadFiles]);

  /* paste files (e.g. screenshots) anywhere on the page */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        // Don't hijack plain-text paste into the compose box.
        e.preventDefault();
        uploadFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [uploadFiles]);

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Logo className="h-8 w-8 text-blue-600" />
          <h1 className="text-xl font-bold sm:text-2xl">Sync Splat</h1>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500"
            title={connected ? "Connected" : "Reconnecting"}
          >
            <span
              className={`inline-block size-2.5 rounded-full ${
                connected ? "bg-green-500" : "animate-pulse bg-amber-500"
              }`}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">
              {connected ? "connected" : "reconnecting…"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setShowQr(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            title="Show QR code"
          >
            <QrCodeIcon className="size-5" aria-hidden="true" />
            <span className="hidden sm:inline">QR</span>
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-4 sm:p-6 md:grid-cols-2">
        {/* compose column */}
        <section className="flex flex-col">
          <Compose connected={connected} onSend={sendText} />

          <div className="mt-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-600 hover:border-blue-400 hover:text-blue-600 sm:w-auto"
            >
              <PaperClipIcon className="size-5" aria-hidden="true" />
              Share a file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="mt-2 text-xs text-gray-400">
              …or drag a file onto the page, or paste one. Max{" "}
              {humanSize(maxFileBytes)}.
            </p>
            {uploadError && (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {uploadError}
              </p>
            )}
          </div>
        </section>

        {/* history column */}
        <section className="flex min-h-0 flex-col">
          <h2 className="mb-3 text-sm font-medium text-gray-600">History</h2>
          {history.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400">
              Nothing shared yet. Broadcast some text or share a file to get
              started.
            </p>
          ) : (
            <div className="space-y-2">
              {history.map((item) => (
                <HistoryItem key={item.id} item={item} onDelete={deleteItem} />
              ))}
            </div>
          )}
        </section>
      </main>

      {showQr && <QrModal onClose={() => setShowQr(false)} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-blue-600/10 p-8">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-blue-500 bg-white/90 px-10 py-12 text-blue-700 shadow-lg">
            <ArrowUpTrayIcon className="size-10" aria-hidden="true" />
            <p className="text-lg font-semibold">Drop to share</p>
          </div>
        </div>
      )}
    </div>
  );
}
