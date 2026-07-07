/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Middle-truncate a filename so the extension stays visible, e.g.
 * "a-very-long-report-name.pdf" -> "a-very-lo…name.pdf".
 */
export function middleTruncate(name: string, max = 34): string {
  if (name.length <= max) return name;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** Derive plain text from an HTML string via a detached element. */
export function htmlToPlainText(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}
