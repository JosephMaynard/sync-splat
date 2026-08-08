import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Dialog accessibility for modals: focus the dialog on open, trap Tab within
 * it, close on Escape, and restore focus to the previously-focused element on
 * unmount. The container should carry role="dialog", aria-modal="true", and
 * tabIndex={-1} so it can receive initial focus when it has no focusables.
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // Keep the latest onClose in a ref so a changing callback identity doesn't
  // re-run the focus-management effect (which would re-capture focus and
  // re-trap on every parent render). Sync in its own effect, not during
  // render. The main effect below stays mount-only.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;

    const focusables = (): HTMLElement[] =>
      container
        ? Array.from(
            container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
          ).filter((el) => el.offsetParent !== null || el === container)
        : [];

    // Initial focus: first focusable control, else the dialog itself.
    (focusables()[0] ?? container)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        // Nothing to move to — keep focus on the dialog.
        e.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [containerRef]);
}
