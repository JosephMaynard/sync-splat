import { useCallback, useEffect, useRef, useState } from "react";
import {
  QrCodeIcon,
  ArrowUpTrayIcon,
  SunIcon,
  MoonIcon,
} from "@heroicons/react/24/outline";
import { socket } from "./socket";
import { getTheme, toggleTheme, watchSystemTheme, type Theme } from "./theme";
import type { ActionAck, Item, ServerInfo, ServerInfoLocked } from "../shared/types";
import { LIMITS } from "../shared/types";
import HistoryItem from "./HistoryItem";
import Compose from "./Compose";
import QrModal from "./QrModal";
import ShareBrowser from "./ShareBrowser";
import PasscodePrompt from "./PasscodePrompt";
import Logo from "./Logo";
import { humanSize } from "./util";
import { authHeaders, setToken, clearToken } from "./auth";
import { uploadWithProgress } from "./upload";

/** Result of a broadcast: whether the (optional) text send succeeded. */
export interface BroadcastResult {
  textOk: boolean;
  textError?: string;
}

/** Error string carried by a rejected ActionAck. */
type AckError = Extract<ActionAck, { ok: false }>["error"];

/** Human-readable message for a rejected action ack. */
function messageForAck(error: AckError): string {
  switch (error) {
    case "too-big":
      return "Too big to send. Try attaching it as a file instead.";
    case "rate-limited":
      return "You're sending too fast — wait a moment and try again.";
    case "not-found":
      return "That item no longer exists.";
    default:
      return "The server rejected that message.";
  }
}

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
  // Per-attachment upload progress, keyed by localId, in [0, 1].
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  // Auth gate: "checking" until /api/info answers; "locked" shows the passcode
  // prompt; "ok" boots the app and connects the socket.
  const [authState, setAuthState] = useState<"checking" | "ok" | "locked">(
    "checking",
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  // True once we know the server has a passcode — used to interpret a socket
  // connect_error as "key rejected" rather than a transient network blip.
  const authRequiredRef = useRef(false);

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

  /* Fetch /api/info: resolve the auth gate and (when unlocked) the limits.
   * A locked payload (authRequired with no full body) means we need a key. A
   * network failure isn't an auth problem, so we still boot with defaults. */
  const loadInfo = useCallback(async (): Promise<"ok" | "locked"> => {
    try {
      const res = await fetch("/api/info", { headers: authHeaders() });
      // Only a 401 means "wrong/missing key". Any other non-OK (500, etc.) is
      // not an auth problem — boot with defaults rather than trapping the user
      // behind a passcode prompt they can't satisfy.
      if (res.status === 401) return "locked";
      if (!res.ok) return "ok";
      const info: ServerInfo | ServerInfoLocked = await res.json();
      if (info.authRequired && !("maxFileBytes" in info)) {
        authRequiredRef.current = true;
        return "locked";
      }
      const full = info as ServerInfo;
      authRequiredRef.current = full.authRequired;
      setMaxFileBytes(full.maxFileBytes);
      setMaxTextBytes(full.maxTextBytes);
      setShare(full.share);
      return "ok";
    } catch {
      // Can't reach /api/info — not an auth failure; boot with defaults rather
      // than trapping the user behind a prompt they can't satisfy.
      return "ok";
    }
  }, []);

  /* Resolve the auth gate on boot. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await loadInfo();
      if (!cancelled) setAuthState(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInfo]);

  /* Store the entered passcode and retry. Returns false if still rejected. */
  const retryAuth = useCallback(
    async (token: string): Promise<boolean> => {
      setToken(token);
      const r = await loadInfo();
      if (r === "ok") {
        setAuthState("ok");
        return true;
      }
      // Rejected: drop the bad token so it isn't reused on the next attempt.
      clearToken();
      return false;
    },
    [loadInfo],
  );

  /* socket lifecycle — only after the auth gate is open. */
  useEffect(() => {
    if (authState !== "ok") return;

    const onHistory = (items: Item[]) => setHistory(items);
    const onNew = (item: Item) => setHistory((prev) => [item, ...prev]);
    const onDeleted = (id: string) =>
      setHistory((prev) => prev.filter((it) => it.id !== id));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      // The server's socket middleware rejects a bad key with
      // Error("unauthorized"); only that (with a passcode in play) should
      // surface the prompt. Transport/network blips socket.io retries itself.
      if (authRequiredRef.current && err.message === "unauthorized") {
        setAuthState("locked");
      }
    };

    socket.on("history", onHistory);
    socket.on("item:new", onNew);
    socket.on("item:deleted", onDeleted);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    // Connect only after every listener is wired: the server emits `history`
    // the moment the connection lands, and events with no listener are lost.
    socket.connect();

    return () => {
      socket.off("history", onHistory);
      socket.off("item:new", onNew);
      socket.off("item:deleted", onDeleted);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      // Disconnect so a remount (StrictMode, HMR) reconnects fresh and
      // receives a new history snapshot instead of a listenerless socket.
      socket.disconnect();
    };
  }, [authState]);

  /* auto-dismiss upload errors */
  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(null), 5000);
    return () => clearTimeout(t);
  }, [uploadError]);

  /* Emit text and await the server ack so we can surface rejections (too-big /
   * rate-limited / invalid) instead of silently assuming success. A timeout
   * (old server with no ack) is treated as delivered — the prior behavior. */
  const sendText = useCallback(
    (html: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (r: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        // No ack within the window (e.g. an older server): treat as delivered,
        // matching the prior fire-and-forget behavior rather than blocking.
        const timer = setTimeout(() => done({ ok: true }), 8000);
        socket.emit("text:send", { html }, (ack: ActionAck) => {
          if (ack && ack.ok === false) {
            done({ ok: false, error: messageForAck(ack.error) });
          } else {
            done({ ok: true });
          }
        });
      }),
    [],
  );

  const deleteItem = useCallback((id: string) => {
    // Pass a no-op ack so a not-found (already deleted elsewhere) can't throw.
    socket.emit("item:delete", id, () => {});
  }, []);

  /* Upload a single file via XHR for progress. Size is pre-checked at add
   * time. Returns success so the broadcast loop can stop on the first failure
   * and leave items staged. */
  const uploadFile = useCallback(
    async (file: File, localId: string): Promise<boolean> => {
      try {
        const res = await uploadWithProgress(
          `/api/upload?name=${encodeURIComponent(file.name)}`,
          file,
          {
            headers: authHeaders(),
            onProgress: (fraction) =>
              setUploadProgress((p) => ({ ...p, [localId]: fraction })),
          },
        );
        if (!res.ok) {
          setUploadError(
            res.status === 413
              ? `"${file.name}" is too big.`
              : `Upload failed (${res.status}).`,
          );
          return false;
        }
        // On success the server broadcasts item:new — no local insert needed.
        return true;
      } catch {
        setUploadError("Upload failed — is the server still running?");
        return false;
      } finally {
        // Drop this file's progress entry so a failed upload can't leave a
        // permanent bar stuck at 100% (and a finished one clears cleanly).
        setUploadProgress((p) => {
          const { [localId]: _removed, ...rest } = p;
          return rest;
        });
      }
    },
    [],
  );

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

  const clearProgress = useCallback((localId: string) => {
    setUploadProgress((prev) => {
      if (!(localId in prev)) return prev;
      const { [localId]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const removeAttachment = useCallback(
    (localId: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.localId === localId);
        if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((a) => a.localId !== localId);
      });
      clearProgress(localId);
    },
    [clearProgress],
  );

  /* Broadcast: send text first (if any), then upload staged files one by one.
   * If the text send is rejected we keep the box (Compose handles that) and
   * don't touch the attachments. Uploaded items are cleared as they go; on the
   * first upload failure we stop and leave the rest staged for a retry. */
  const broadcast = useCallback(
    async (html: string | null): Promise<BroadcastResult> => {
      if (html) {
        const r = await sendText(html);
        if (!r.ok) return { textOk: false, textError: r.error };
      }
      const queued = attachments;
      if (queued.length === 0) return { textOk: true };
      setUploadError(null);
      setSending(true);
      try {
        for (const att of queued) {
          const ok = await uploadFile(att.file, att.localId);
          if (!ok) break;
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
          setAttachments((prev) =>
            prev.filter((a) => a.localId !== att.localId),
          );
          clearProgress(att.localId);
        }
      } finally {
        setSending(false);
      }
      return { textOk: true };
    },
    [attachments, sendText, uploadFile, clearProgress],
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

  // Hold rendering until the auth gate resolves, then either prompt or boot.
  if (authState === "checking") {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-950" aria-hidden />
    );
  }
  if (authState === "locked") {
    return <PasscodePrompt onSubmit={retryAuth} />;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900">
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

      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 sm:p-6 md:min-h-0 md:grid-cols-2 md:overflow-hidden">
        {/* compose column — editor scrolls, controls pinned in Compose's footer */}
        <section className="flex min-h-0 flex-col">
          <Compose
            connected={connected}
            sending={sending}
            attachments={attachments}
            uploadProgress={uploadProgress}
            maxTextBytes={maxTextBytes}
            maxFileBytes={maxFileBytes}
            uploadError={uploadError}
            onAttach={() => fileInputRef.current?.click()}
            onBroadcast={broadcast}
            onRemoveAttachment={removeAttachment}
          />
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

          <div className="min-h-0 flex-1 md:overflow-y-auto">
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
          </div>
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
