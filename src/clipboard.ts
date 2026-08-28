/**
 * Clipboard helpers with a fallback chain that also works over plain http://
 * (no secure context) — the common case on a phone hitting a LAN IP, where
 * navigator.clipboard is often unavailable. Each returns whether it succeeded.
 */

/** Copy plain text. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && "writeText" in navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // In finally so a throwing execCommand can't leak the node.
    ta.remove();
  }
}

/** Copy rich text (html + a plain-text alternative), falling back to plain. */
export async function copyRich(html: string, plain: string): Promise<boolean> {
  try {
    if (navigator.clipboard && "write" in navigator.clipboard) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
  } catch {
    /* fall through */
  }
  return copyText(plain);
}
