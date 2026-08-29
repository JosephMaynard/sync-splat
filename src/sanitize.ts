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

const URL_ATTRS = ["src", "href", "xlink:href", "poster", "srcset", "background"];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (typeof el.getAttribute !== "function") return;
  for (const attr of URL_ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    const value = el.getAttribute(attr) ?? "";
    // Allow data:, blob:, fragment-only, and relative (but not protocol-
    // relative "//host") URLs outright.
    if (/^(?:data:|blob:|#|\/(?!\/)|\.{1,2}\/)/i.test(value.trim())) continue;
    // Allow same-origin absolute URLs; strip anything else (external hosts).
    let sameOrigin = false;
    try {
      sameOrigin = new URL(value, location.origin).origin === location.origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) el.removeAttribute(attr);
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
