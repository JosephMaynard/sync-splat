import DOMPurify from "dompurify";

/**
 * Strict sanitizer for all untrusted HTML (text splats, pasted content, and
 * rendered markdown/code). On top of DOMPurify's default script-stripping this:
 *   - drops the `style` attribute and `<style>` tag, so a peer's splat can't
 *     use `position:fixed` to overlay the whole app (UI redress) or inject CSS;
 *   - forbids forms and interactive/embedding elements, so a splat can't render
 *     a convincing phishing form or embed a frame;
 *   - blocks external subresource loads (tracking beacons / LAN probing through
 *     the viewer's browser) by stripping any src/href that isn't same-origin,
 *     relative, data:, or blob:.
 *
 * The hook is global (DOMPurify.addHook applies to every sanitize call), which
 * is what we want — every render path is covered, including the QR SVG.
 */
const FORBID_TAGS = [
  "style",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
];
const FORBID_ATTR = ["style"];

// Single-URL attributes get a whole-value check; srcset is a comma-separated
// list of "<url> <descriptor>" candidates, each validated on its own.
const URL_ATTRS = ["src", "href", "xlink:href", "poster", "background"];

/** True when a URL is safe to keep: same-origin, relative, data:, or blob:
 *  (but not protocol-relative "//host"). */
function isLocalUrl(value: string): boolean {
  const v = value.trim();
  if (/^(?:data:|blob:|#|\/(?!\/)|\.{1,2}\/)/i.test(v)) return true;
  try {
    return new URL(v, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (typeof el.getAttribute !== "function") return;
  for (const attr of URL_ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    if (!isLocalUrl(el.getAttribute(attr) ?? "")) el.removeAttribute(attr);
  }
  // srcset: parse each candidate's URL (the token before its optional
  // descriptor) and drop the whole attribute if ANY candidate is external —
  // validating the joined string would let "/local 1x, http://evil 2x" pass.
  if (el.hasAttribute("srcset")) {
    const candidates = (el.getAttribute("srcset") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const allLocal = candidates.every((c) => isLocalUrl(c.split(/\s+/)[0]));
    if (!allLocal) el.removeAttribute("srcset");
  }
});

/** Sanitize untrusted HTML to a safe HTML string. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR });
}

/** Sanitize untrusted HTML to a DocumentFragment (for contentEditable paste). */
export function sanitizeToFragment(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    RETURN_DOM_FRAGMENT: true,
  });
}
