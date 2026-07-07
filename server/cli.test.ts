import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const binPath = fileURLToPath(
  new URL("../bin/sync-splat.js", import.meta.url),
);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("bin/sync-splat.js", () => {
  it("--help exits 0 and prints usage mentioning --port and --max-file-size", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, "--help"],
      { cwd: repoRoot, timeout: 10_000 },
    );
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--max-file-size");
    expect(stderr).toBe("");
  });

  it("-h is an alias for --help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, "-h"], {
      cwd: repoRoot,
      timeout: 10_000,
    });
    expect(stdout).toContain("Usage: sync-splat");
  });

  it("--port notanumber exits non-zero with an error message", async () => {
    await expect(
      execFileAsync(process.execPath, [binPath, "--port", "notanumber"], {
        cwd: repoRoot,
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("invalid port"),
    });
  });
});
