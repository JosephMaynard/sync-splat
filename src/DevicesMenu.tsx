import { useEffect, useId, useRef, useState } from "react";
import {
  CommandLineIcon,
  ComputerDesktopIcon,
  DevicePhoneMobileIcon,
  DeviceTabletIcon,
} from "@heroicons/react/24/outline";
import type { Device } from "../shared/types";

interface Props {
  devices: Device[];
  /** Our own socket.id — read at render time by the caller because it
   *  changes on every reconnect. Undefined while disconnected. */
  selfId: string | undefined;
}

/** Cosmetic icon from the (self-chosen, unverified) label. */
function iconFor(device: Device) {
  if (device.kind === "terminal") return CommandLineIcon;
  if (/^(iPhone|Android)\b/.test(device.label)) return DevicePhoneMobileIcon;
  if (/^iPad\b/.test(device.label)) return DeviceTabletIcon;
  return ComputerDesktopIcon;
}

/**
 * Header control: a device count that discloses the presence list. A plain
 * disclosure (button + aria-expanded), not a menu — the list isn't
 * interactive, so focus stays on the button while it's open.
 */
export default function DevicesMenu({ devices, selfId }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Escape / outside click close the popover.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      // On `click` (not pointerdown) focus has already moved to whatever was
      // clicked; only reclaim it if it fell to <body>, so clicking into the
      // compose box isn't undone.
      if (document.activeElement === document.body) {
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  const count = devices.length;
  // Self first, then the server machine, then the rest in server order.
  const sorted = [...devices].sort(
    (a, b) =>
      Number(b.id === selfId) - Number(a.id === selfId) ||
      Number(b.host) - Number(a.host),
  );

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${count} ${count === 1 ? "device" : "devices"} online`}
        title="Devices online"
        className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm font-medium tabular-nums text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:gap-1.5 sm:px-3 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        <DevicePhoneMobileIcon className="size-5" aria-hidden="true" />
        <span data-testid="device-count">{count}</span>
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Devices online"
          // Right-aligned under the button; capped to the viewport so it
          // never pushes a 375px-wide phone into horizontal scroll.
          className="absolute right-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-800 dark:bg-gray-900"
        >
          <p className="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Devices online
          </p>
          {count === 0 ? (
            <p className="px-2 py-2 text-sm text-gray-500 dark:text-gray-400">
              Nobody yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {sorted.map((d) => {
                const Icon = iconFor(d);
                const self = d.id === selfId;
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <Icon
                      className="size-5 shrink-0 text-gray-400 dark:text-gray-500"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">
                      {d.label}
                      {d.kind === "terminal" && (
                        <span className="sr-only"> (terminal)</span>
                      )}
                    </span>
                    {self && (
                      <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                        this device
                      </span>
                    )}
                    {d.host && (
                      <span
                        className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        title="On the computer running sync-splat"
                      >
                        server
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
