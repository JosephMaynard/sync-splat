import { useCallback, useEffect, useRef, useState } from "react";
import {
  QrCodeIcon,
  PaperClipIcon,
  ArrowUpTrayIcon,
  SunIcon,
  MoonIcon,
} from "@heroicons/react/24/outline";
import { socket } from "./socket";
import { getTheme, toggleTheme, watchSystemTheme, type Theme } from "./theme";
import type { Item, ServerInfo } from "../shared/types";
import { LIMITS } from "../shared/types";
import HistoryItem from "./HistoryItem";
import Compose from "./Compose";
import QrModal from "./QrModal";
import ShareBrowser from "./ShareBrowser";
import Logo from "./Logo";
import { humanSize } from "./util";

/** Client-local id for staged attachments. crypto.randomUUID is unavailable
 *  in insecure contexts (http:// on a phone — our primary use case). */
let localIdCounter = 0;
function newLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  localIdCounter += 1;
  return `att-${Date.now()}-${localIdCounter}`;
}

/** A file staged in the compose area, not yet uploaded. */
export interface PendingAttachment {
  localId: string;
  file: File;
  /** Object URL for image/* previews; null for everything else. Must be revoked. */
  previewUrl: string | null;
}

export default function App() {
  const [history, setHistory] = useState<Item[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [showQr, setShowQr] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [maxFileBytes, setMaxFileBytes] = useState(LIMITS.maxFileBytes);
  const [maxTextBytes, setMaxTextBytes] = useState(LIMITS.maxTextBytes);
  const [share, setShare] = useState<ServerInfo["share"]>(null);
  const [tab, setTab] = useState<"splats" | "files">("splats");
  const tabRefs = useRef<Record<"splats" | "files", HTMLButtonElement | null>>({
    splats: null,
    files: null,
  });
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  /* revoke any outstanding object URLs when the app unmounts */
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    },
    [],
  );

  /* follow the OS theme live while the user hasn't picked an explicit one */
  useEffect(() => watchSystemTheme(setThemeState), []);

  const onToggleTheme = useCallback(() => {
    setThemeState(toggleTheme());
  }, []);

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

    // Connect only after every listener is wired: the server emits `history`
    // the moment the connection lands, and events with no listener are lost.
    // (autoConnect is off, so the socket cannot already be connected here.)
    socket.connect();

    return () => {
      socket.off("history", onHistory);
      socket.off("item:new", onNew);
      socket.off("item:deleted", onDeleted);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      // Disconnect so a remount (StrictMode, HMR) reconnects fresh and
      // receives a new history snapshot instead of a listenerless socket.
      socket.disconnect();
    };
  }, []);

  /* fetch limits so we can pre-check file sizes */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info: ServerInfo | null) => {
        if (!cancelled && info) {
          setMaxFileBytes(info.maxFileBytes);
          setMaxTextBytes(info.maxTextBytes);
          setShare(info.share);
        }
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

  /* Upload a single file. Size is pre-checked at add time. Returns success so
   * the broadcast loop can stop on the first failure and leave items staged. */
  const uploadFile = useCallback(async (file: File): Promise<boolean> => {
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
        return false;
      }
      // On success the server broadcasts item:new — no local insert needed.
      return true;
    } catch {
      setUploadError("Upload failed — is the server still running?");
      return false;
    }
  }, []);

  /* Stage files as pending attachments (paste / drop / picker all land here).
   * Oversize files are rejected immediately with the friendly message. */
  const addAttachments = useCallback(
    (files: FileList | File[]) => {
      setUploadError(null);
      const accepted: PendingAttachment[] = [];
      for (const file of Array.from(files)) {
        if (file.size > maxFileBytes) {
          setUploadError(
            `"${file.name}" is too big (${humanSize(file.size)}). Max is ${humanSize(maxFileBytes)}.`,
          );
          continue;
        }
        accepted.push({
          localId: newLocalId(),
          file,
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : null,
        });
      }
      if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
    },
    [maxFileBytes],
  );

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  }, []);

  /* Broadcast: emit text first (if any), then upload staged files one by one.
   * Successful items are cleared as they go; on the first failure we stop and
   * leave the failed item plus any not-yet-sent ones staged for a retry. */
  const broadcast = useCallback(
    async (html: string | null): Promise<void> => {
      if (html) sendText(html);
      const queued = attachments;
      if (queued.length === 0) return;
      setUploadError(null);
      setSending(true);
      try {
        for (const att of queued) {
          const ok = await uploadFile(att.file);
          if (!ok) break;
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
          setAttachments((prev) =>
            prev.filter((a) => a.localId !== att.localId),
          );
        }
      } finally {
        setSending(false);
      }
    },
    [attachments, sendText, uploadFile],
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
      if (e.dataTransfer?.files?.length) addAttachments(e.dataTransfer.files);
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
  }, [addAttachments]);

  /* paste files (e.g. screenshots) anywhere on the page — stage, don't send */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        // Don't hijack plain-text paste into the compose box.
        e.preventDefault();
        addAttachments(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addAttachments]);

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <Logo className="h-8 w-8 text-blue-600 dark:text-blue-500" />
          <h1 className="text-xl font-bold sm:text-2xl">Sync Splat</h1>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400"
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
            onClick={onToggleTheme}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <SunIcon className="size-5" aria-hidden="true" />
            ) : (
              <MoonIcon className="size-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowQr(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
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
          <Compose
            connected={connected}
            sending={sending}
            attachments={attachments}
            maxTextBytes={maxTextBytes}
            onBroadcast={broadcast}
            onRemoveAttachment={removeAttachment}
          />

          <div className="mt-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-600 hover:border-blue-400 hover:text-blue-600 sm:w-auto dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-blue-500 dark:hover:text-blue-400"
            >
              <PaperClipIcon className="size-5" aria-hidden="true" />
              Attach a file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addAttachments(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              …or drag files onto the page, or paste a screenshot. Attachments
              send when you broadcast. Max {humanSize(maxFileBytes)}.
            </p>
            {uploadError && (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                {uploadError}
              </p>
            )}
          </div>
        </section>

        {/* splats / files column */}
        <section className="flex min-h-0 flex-col">
          {share ? (
            <div
              role="tablist"
              aria-label="Splats and files"
              className="mb-3 inline-flex self-start rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-800 dark:bg-gray-800/50"
            >
              {(["splats", "files"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`panel-${t}`}
                  // Roving tabindex: Tab lands on the active tab; arrows move
                  // selection AND focus between tabs (WAI-ARIA tabs pattern).
                  tabIndex={tab === t ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[t] = el;
                  }}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const next = t === "splats" ? "files" : "splats";
                    setTab(next);
                    tabRefs.current[next]?.focus();
                  }}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
                    tab === t
                      ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                      : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : (
            <h2 className="mb-3 text-sm font-medium text-gray-600 dark:text-gray-400">
              Splats
            </h2>
          )}

          {(!share || tab === "splats") && (
            <div
              id="panel-splats"
              role={share ? "tabpanel" : undefined}
              aria-labelledby={share ? "tab-splats" : undefined}
            >
              {history.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500">
                  Nothing splatted yet. Broadcast some text or share a file to
                  get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {history.map((item) => (
                    <HistoryItem
                      key={item.id}
                      item={item}
                      onDelete={deleteItem}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {share && tab === "files" && (
            <div
              id="panel-files"
              role="tabpanel"
              aria-labelledby="tab-files"
              className="flex min-h-0 flex-col"
            >
              <ShareBrowser
                shareName={share.name}
                maxFileBytes={maxFileBytes}
              />
            </div>
          )}
        </section>
      </main>

      {showQr && <QrModal onClose={() => setShowQr(false)} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-blue-600/10 p-8 dark:bg-blue-500/10">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-blue-500 bg-white/90 px-10 py-12 text-blue-700 shadow-lg dark:border-blue-400 dark:bg-gray-900/90 dark:text-blue-300">
            <ArrowUpTrayIcon className="size-10" aria-hidden="true" />
            <p className="text-lg font-semibold">Drop to attach</p>
          </div>
        </div>
      )}
    </div>
  );
}
