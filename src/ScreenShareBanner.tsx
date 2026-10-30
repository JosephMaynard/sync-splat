import { useEffect, useId, useState } from "react";
import {
  ChevronDownIcon,
  ComputerDesktopIcon,
  EyeIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { Device } from "../shared/types";
import type { ScreenShareApi } from "./screenShare";

interface Props {
  share: ScreenShareApi;
  /** Our socket.id, read at render time (changes on reconnect). */
  selfId: string | undefined;
  /** Presence list, to name the viewers of our share. */
  devices: Device[];
}

/** Toasts clear themselves after this long. */
const TOAST_MS = 5000;

/**
 * Full-width strip under the header: "you're sharing" (red, so it can't be
 * missed — the whole screen is going out), "someone is sharing" (with Watch),
 * and transient screen-share notices. Renders nothing when idle.
 */
export default function ScreenShareBanner({ share, selfId, devices }: Props) {
  const { screen, sharing, viewerIds, viewer, toast, dismissToast } = share;
  const [showViewers, setShowViewers] = useState(false);
  const viewersListId = useId();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  // The server's count is authoritative for the number; the names come from
  // viewer-joined/left ids matched against presence.
  const watching = screen.viewers;
  const viewerLabels = viewerIds.map(
    (id) => devices.find((d) => d.id === id)?.label ?? "Unknown device",
  );
  const listOpen = showViewers && viewerLabels.length > 0;
  const remote =
    sharing === null && screen.sharer && screen.sharer.id !== selfId
      ? screen.sharer
      : null;

  return (
    <>
      {sharing === "live" && (
        <div className="shrink-0 border-b border-red-700 bg-red-600 px-4 py-2 text-sm text-white sm:px-6 dark:border-red-900 dark:bg-red-700">
          <div className="flex items-center gap-3">
            <span
              className="inline-block size-2.5 shrink-0 animate-pulse rounded-full bg-white"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1">
              <span className="font-semibold">You're sharing your screen</span>
              <span aria-hidden="true"> · </span>
              {/* Anyone on the LAN can watch (unless there's a passcode), so
                  who's watching is one tap away, not just a count. */}
              {viewerLabels.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowViewers((v) => !v)}
                  aria-expanded={listOpen}
                  aria-controls={viewersListId}
                  className="inline-flex items-center gap-0.5 whitespace-nowrap rounded tabular-nums underline decoration-white/50 underline-offset-2 hover:decoration-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {watching} watching
                  <ChevronDownIcon
                    className={`size-3.5 transition-transform ${listOpen ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <span className="whitespace-nowrap tabular-nums">
                  {watching} watching
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={share.stopShare}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <StopIcon className="size-4" aria-hidden="true" />
              Stop
            </button>
          </div>
          {listOpen && (
            <ul
              id={viewersListId}
              aria-label="Watching now"
              className="mt-2 flex flex-wrap gap-1.5 pl-5.5"
            >
              {viewerLabels.map((label, i) => (
                <li
                  key={viewerIds[i]}
                  className="max-w-full truncate rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium"
                >
                  {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {remote && (
        <div className="flex shrink-0 items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 sm:px-6 dark:border-blue-900/60 dark:bg-blue-950/60 dark:text-blue-100">
          <ComputerDesktopIcon
            className="size-5 shrink-0 text-blue-600 dark:text-blue-400"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1">
            <span className="font-semibold break-words">{remote.label}</span>{" "}
            is sharing their screen
          </p>
          <button
            type="button"
            onClick={share.watch}
            disabled={viewer !== null}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
          >
            <EyeIcon className="size-4" aria-hidden="true" />
            {viewer?.status === "joining" ? "Joining…" : "Watch"}
          </button>
        </div>
      )}

      {toast && (
        <div
          role={toast.kind === "error" ? "alert" : "status"}
          className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm sm:px-6 ${
            toast.kind === "error"
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-200"
              : "border-gray-200 bg-white text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
          }`}
        >
          <p className="min-w-0 flex-1">{toast.text}</p>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 rounded-md p-1 opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            aria-label="Dismiss"
          >
            <XMarkIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
