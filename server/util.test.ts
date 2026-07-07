import { describe, expect, it } from "vitest";
import {
  asciiFallbackName,
  encodeRFC5987,
  extname,
  mimeForPath,
  sanitizeFilename,
} from "./util";

describe("sanitizeFilename", () => {
  it("strips path traversal segments and keeps the final segment", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeFilename("C:\\Windows\\System32\\evil.exe")).toBe(
      "evil.exe",
    );
  });

  it("drops control characters and DEL", () => {
    expect(sanitizeFilename("bad\x01\x1fname\x7f.txt")).toBe("badname.txt");
  });

  it("strips CRLF sequences", () => {
    expect(sanitizeFilename("evil\r\nname.txt")).toBe("evilname.txt");
  });

  it("falls back to 'file' for empty input", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  it("falls back to 'file' for '.' and '..'", () => {
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
  });

  it("truncates long names while preserving a short extension", () => {
    const longName = "a".repeat(300) + ".txt";
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith(".txt")).toBe(true);
  });

  it("truncates long names without a short extension by hard cutoff", () => {
    const longName = "a".repeat(300);
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(180);
  });

  it("truncates when the 'extension' is too long to preserve", () => {
    const longExt = "." + "b".repeat(50);
    const longName = "a".repeat(200) + longExt;
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(180);
    // The extension is too long (>12 chars incl dot) so it's not preserved.
    expect(result.endsWith(longExt)).toBe(false);
  });
});

describe("asciiFallbackName", () => {
  it("neutralises quotes and backslashes", () => {
    expect(asciiFallbackName('na"me.txt')).toBe("na_me.txt");
    expect(asciiFallbackName("na\\me.txt")).toBe("na_me.txt");
  });

  it("neutralises non-ascii characters", () => {
    expect(asciiFallbackName("café.txt")).toBe("caf_.txt");
    expect(asciiFallbackName("日本語.txt")).toBe("___.txt");
  });

  it("neutralises control characters", () => {
    expect(asciiFallbackName("a\x01b.txt")).toBe("a_b.txt");
  });

  it("falls back to 'file' when nothing usable remains", () => {
    expect(asciiFallbackName("")).toBe("file");
  });

  it("passes through plain ascii unchanged", () => {
    expect(asciiFallbackName("plain-name_123.txt")).toBe(
      "plain-name_123.txt",
    );
  });
});

describe("encodeRFC5987", () => {
  it("percent-encodes reserved characters used by RFC 5987", () => {
    const encoded = encodeRFC5987("a b'c(d)e*f");
    expect(encoded).not.toContain("'");
    expect(encoded).not.toContain("(");
    expect(encoded).not.toContain(")");
    expect(encoded).not.toContain("*");
    expect(encoded).toContain("%20");
  });

  it("leaves ~!*()' equivalents decoded back for the special unreserved set", () => {
    // encodeURIComponent leaves | ` ^ escaped as %7C %60 %5E, which the
    // function decodes back to raw characters per RFC 5987's unreserved set.
    expect(encodeRFC5987("|")).toBe("|");
    expect(encodeRFC5987("`")).toBe("`");
    expect(encodeRFC5987("^")).toBe("^");
  });

  it("round trips ascii names safely", () => {
    expect(encodeRFC5987("simple.txt")).toBe("simple.txt");
  });

  it("encodes unicode filenames", () => {
    const encoded = encodeRFC5987("café.txt");
    expect(encoded).toBe("caf%C3%A9.txt");
  });
});

describe("extname", () => {
  it("returns the lowercased extension of the final path segment", () => {
    expect(extname("/a/b/c.TXT")).toBe("txt");
    expect(extname("file.tar.gz")).toBe("gz");
  });

  it("handles backslash separators", () => {
    expect(extname("C:\\Windows\\file.EXE")).toBe("exe");
  });

  it("returns '' when there is no extension", () => {
    expect(extname("README")).toBe("");
    expect(extname("/a/b/README")).toBe("");
  });

  it("treats a leading dot (dotfile) as having no extension", () => {
    expect(extname(".gitignore")).toBe("");
  });

  it("returns '' for an empty path", () => {
    expect(extname("")).toBe("");
  });
});

describe("mimeForPath", () => {
  it("returns the known mime for a known extension", () => {
    expect(mimeForPath("/assets/app.js")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(mimeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeForPath("logo.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(mimeForPath("archive.rar")).toBe("application/octet-stream");
  });

  it("falls back to octet-stream when there is no extension", () => {
    expect(mimeForPath("Makefile")).toBe("application/octet-stream");
  });
});
