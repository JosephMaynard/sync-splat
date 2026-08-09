import { describe, it, expect } from "vitest";
import {
  fileExtension,
  classifyPreview,
  isPreviewable,
  hljsLanguageForExtension,
} from "./util";
import { parseTokenFromHash } from "./auth";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("photo.PNG")).toBe("png");
    expect(fileExtension("a.tar.gz")).toBe("gz");
    expect(fileExtension("README.md")).toBe("md");
  });

  it("returns '' when there is no usable extension", () => {
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension(".gitignore")).toBe(""); // leading dot only
    expect(fileExtension("trailingdot.")).toBe("");
    expect(fileExtension("")).toBe("");
  });
});

describe("classifyPreview", () => {
  it("classifies images by MIME", () => {
    expect(classifyPreview("x", "image/png")).toBe("image");
    expect(classifyPreview("x", "image/webp")).toBe("image");
  });

  it("classifies images by extension when MIME is absent", () => {
    expect(classifyPreview("shot.jpg", "")).toBe("image");
    expect(classifyPreview("anim.GIF", "")).toBe("image");
  });

  it("treats svg as code source, never an inline image", () => {
    // SVG can carry script — excluded from image handling by design.
    expect(classifyPreview("logo.svg", "image/svg+xml")).toBe("code");
  });

  it("classifies markdown", () => {
    expect(classifyPreview("notes.md", "")).toBe("markdown");
    expect(classifyPreview("notes.markdown", "")).toBe("markdown");
  });

  it("classifies code by extension", () => {
    expect(classifyPreview("main.ts", "")).toBe("code");
    expect(classifyPreview("styles.css", "")).toBe("code");
    expect(classifyPreview("data.json", "")).toBe("code");
    expect(classifyPreview("script.py", "text/x-python")).toBe("code");
  });

  it("returns none for unknown / binary types", () => {
    expect(classifyPreview("archive.zip", "application/zip")).toBe("none");
    expect(classifyPreview("movie.mp4", "video/mp4")).toBe("none");
    expect(classifyPreview("Makefile", "")).toBe("none");
  });

  it("isPreviewable mirrors classifyPreview", () => {
    expect(isPreviewable("a.png", "image/png")).toBe(true);
    expect(isPreviewable("a.md", "")).toBe(true);
    expect(isPreviewable("a.zip", "application/zip")).toBe(false);
  });
});

describe("hljsLanguageForExtension", () => {
  it("maps extensions to highlight.js language names", () => {
    expect(hljsLanguageForExtension("ts")).toBe("typescript");
    expect(hljsLanguageForExtension("tsx")).toBe("typescript");
    expect(hljsLanguageForExtension("mjs")).toBe("javascript");
    expect(hljsLanguageForExtension("yml")).toBe("yaml");
    expect(hljsLanguageForExtension("sh")).toBe("bash");
    expect(hljsLanguageForExtension("rs")).toBe("rust");
    expect(hljsLanguageForExtension("svg")).toBe("xml");
  });

  it("falls back to the extension itself when unmapped", () => {
    expect(hljsLanguageForExtension("json")).toBe("json");
    expect(hljsLanguageForExtension("python")).toBe("python");
  });

  it("returns null for an empty extension", () => {
    expect(hljsLanguageForExtension("")).toBeNull();
  });
});

describe("parseTokenFromHash", () => {
  it("extracts the token from a #k=<token> fragment", () => {
    expect(parseTokenFromHash("#k=abc123")).toBe("abc123");
    expect(parseTokenFromHash("k=abc123")).toBe("abc123"); // no leading #
  });

  it("extracts k from a multi-param fragment", () => {
    expect(parseTokenFromHash("#foo=bar&k=tok9")).toBe("tok9");
  });

  it("decodes percent-encoded tokens", () => {
    expect(parseTokenFromHash("#k=a%20b")).toBe("a b");
  });

  it("returns null when there is no token", () => {
    expect(parseTokenFromHash("")).toBeNull();
    expect(parseTokenFromHash("#")).toBeNull();
    expect(parseTokenFromHash("#other=1")).toBeNull();
    expect(parseTokenFromHash("#k=")).toBeNull();
    expect(parseTokenFromHash("#k=%20%20")).toBeNull(); // whitespace only
  });
});
