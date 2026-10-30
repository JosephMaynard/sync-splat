import { useEffect, useRef, useState } from "react";
import {
  XMarkIcon,
  ArrowsPointingOutIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { ViewerSnapshot } from "./screenShare";
import { useModalA11y } from "./useModalA11y";

interface Props {
  viewer: ViewerSnapshot;
  onClose: () => void;
  onRetry: () => void;
}

/** Vendor-prefixed fullscreen APIs: iPhone Safari only supports fullscreen on
 *  <video> via webkitEnterFullscreen; older iPadOS uses the webkit prefix. */
type FullscreenVideo = HTMLVideoElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitEnterFullscreen?: () => void;
};

function enterFullscreen(video: FullscreenVideo): void {
  try {
    if (typeof video.requestFullscreen === "function") {
      video.requestFullscreen().catch(() => {
        // Some browsers expose requestFullscreen but refuse it for video
        // (iPhone); fall back to the native video player.
        video.webkitEnterFullscreen?.();
      });
    } else if (typeof video.webkitRequestFullscreen === "function") {
      void video.webkitRequestFullscreen();
    } else {
      video.webkitEnterFullscreen?.();
    }
  } catch {
    // Fullscreen is a nicety; the overlay already fills the viewport.
  }
}

/**
 * Full-viewport overlay that plays a remote screen share. Mounted only while
 * watching (status connecting/connected/failed), so it gets modal focus
 * management on open and focus restore on close.
 */
export default function ScreenViewer({ viewer, onClose, onRetry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<FullscreenVideo>(null);
  // Which stream has produced frames. Tracking the stream (not a boolean)
  // means a retry's new stream reads as "not playing yet" without a reset.
  const [playingStream, setPlayingStream] = useState<MediaStream | null>(null);
  useModalA11y(containerRef, onClose);

  const { stream, status, sharer } = viewer;
  const playing = stream !== null && playingStream === stream;

  // srcObject can't be set declaratively. muted + playsInline + autoPlay is
  // what lets iOS Safari start playback without a user gesture; play() is
  // called too because a srcObject swap doesn't always re-trigger autoplay.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => {});
  }, [stream]);

  const failed = status === "failed";

  return (
    // No click-backdrop-to-close: the video fills the overlay, and a stray
    // tap on a phone shouldn't end the session. Close button + Escape only.
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${sharer.label}'s screen`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black outline-hidden"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-gray-100 sm:px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {sharer.label}
          <span className="text-gray-400">'s screen</span>
        </h2>
        <button
          type="button"
          onClick={() => videoRef.current && enterFullscreen(videoRef.current)}
          disabled={!playing}
          className="rounded-md p-2 text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Full screen"
          title="Full screen"
        >
          <ArrowsPointingOutIcon className="size-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          aria-label="Stop watching"
          title="Stop watching"
        >
          <XMarkIcon className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2 sm:p-4">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onPlaying={() => setPlayingStream(stream)}
          aria-label={`${sharer.label}'s shared screen`}
          className={`h-full w-full object-contain ${
            playing && !failed ? "" : "invisible"
          }`}
        />

        {!failed && !playing && (
          <p
            role="status"
            className="absolute inset-0 grid place-items-center text-sm text-gray-300"
          >
            Connecting…
          </p>
        )}

        {failed && (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-gray-200"
          >
            <ExclamationTriangleIcon
              className="size-8 text-amber-400"
              aria-hidden="true"
            />
            <p className="max-w-sm text-sm">
              Couldn't connect to the shared screen. Make sure both devices
              are on the same network (guest Wi-Fi and VPNs often block
              device-to-device traffic).
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
            >
              <ArrowPathIcon className="size-4" aria-hidden="true" />
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
