/**
 * Theme management. The resolved theme is always "light" or "dark".
 *
 * Storage: localStorage key "sync-splat-theme" holds an explicit preference
 * ("light" | "dark"). When the key is absent the app follows the OS via
 * `prefers-color-scheme` and reacts to its change events live.
 *
 * The `.dark` class on <html> is the single source of truth for the CSS — the
 * inline boot script in index.html sets it before React mounts to avoid a flash.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "sync-splat-theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function storedPreference(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

/** Apply/remove the `.dark` class on <html> to match a resolved theme. */
function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** The currently resolved theme: explicit preference, else system. */
export function getTheme(): Theme {
  return storedPreference() ?? systemTheme();
}

/** Persist an explicit preference and apply it immediately. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Flip between light and dark, persisting the result. Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/**
 * While the user has no explicit preference, keep the resolved theme in sync
 * with the OS. Calls `onChange` with the new resolved theme. Returns a cleanup
 * function. Once the user picks a preference, system changes are ignored.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (storedPreference() !== null) return; // explicit choice wins
    const resolved = systemTheme();
    applyTheme(resolved);
    onChange(resolved);
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
