import {
  INLINE_IMAGE_MIMES,
  PREVIEW_MARKDOWN_EXTENSIONS,
  PREVIEW_CODE_EXTENSIONS,
} from "../shared/types";

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

/** Preserve explicit line breaks and block boundaries without rendering HTML. */
export function htmlToPlainText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  let text = "";
  let blockBreak = false;
  const blocks = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV",
    "DL", "DT", "DD", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "TR", "UL"]);
  const append = (value: string) => {
    if (!value) return;
    if (blockBreak && text && !text.endsWith("\n")) text += "\n";
    blockBreak = false;
    text += value;
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) return;
    if (node.tagName === "BR") {
      append("\n");
      return;
    }
    const block = blocks.has(node.tagName);
    if (block) blockBreak = true;
    node.childNodes.forEach(visit);
    if (block) blockBreak = true;
  };
  template.content.childNodes.forEach(visit);
  return text;
}

/* -------------------------------------------------------------------------- */
/* Preview classification (pure — unit tested, kept DOM-free).                 */
/* -------------------------------------------------------------------------- */

/** How the client can render a given file inline, if at all. */
export type PreviewKind = "image" | "markdown" | "code" | "none";

/** Raster image extensions we can render with a native <img>. SVG is
 *  deliberately excluded (served as code source) — it can carry script. */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
] as const;

/** Lowercase extension without the dot, or "" when there isn't one. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Decide how to preview a file from its name and (possibly empty) MIME type.
 *  Shared-folder entries have no MIME, so extension is the fallback signal. */
export function classifyPreview(name: string, mime: string): PreviewKind {
  const ext = fileExtension(name);
  if (
    (INLINE_IMAGE_MIMES as readonly string[]).includes(mime) ||
    (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
  ) {
    return "image";
  }
  if ((PREVIEW_MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)) {
    return "markdown";
  }
  if ((PREVIEW_CODE_EXTENSIONS as readonly string[]).includes(ext)) {
    return "code";
  }
  return "none";
}

/** True when the file can be shown in the preview modal (any non-"none" kind). */
export function isPreviewable(name: string, mime: string): boolean {
  return classifyPreview(name, mime) !== "none";
}

/** Map a file extension to a highlight.js language name where the two differ.
 *  Returns the extension itself as a best-effort fallback (the caller checks
 *  hljs.getLanguage and falls back to highlightAuto when it's unknown). */
const HLJS_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  h: "c",
  hpp: "cpp",
  html: "xml",
  svg: "xml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  patch: "diff",
  diff: "diff",
};

export function hljsLanguageForExtension(ext: string): string | null {
  if (!ext) return null;
  return HLJS_LANGUAGE_BY_EXTENSION[ext] ?? ext;
}
