import { test, expect } from "@playwright/test";

// End-to-end smoke over the real built app + server (see playwright.config.ts,
// which starts `sync-splat --no-share` on port 3099). Covers the flows unit
// tests can't: initial connection + history, sending text, and rich preview.

test("connects, shows connected status, and splats text", async ({ page }) => {
  await page.goto("/");

  // The connection race regression: a fresh load must reach "connected", not
  // stay stuck on "reconnecting".
  await expect(page.getByText("connected")).toBeVisible({ timeout: 10_000 });

  const box = page.getByRole("textbox", { name: /compose/i });
  await box.click();
  await box.fill("hello e2e");
  await page.getByRole("button", { name: /broadcast/i }).click();

  // The splat appears in the shared history (server-authoritative round-trip).
  await expect(page.getByText("hello e2e")).toBeVisible({ timeout: 5_000 });
});

test("previews a markdown file with rendered HTML", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("connected")).toBeVisible({ timeout: 10_000 });

  // Upload a markdown file via the API from the page context (same origin, so
  // the origin check passes), then preview it in the UI.
  const md = "# Title\n\nSome **bold** text and `code`.";
  const id = await page.evaluate(async (body) => {
    const res = await fetch("/api/upload?name=notes.md", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body,
    });
    return (await res.json()).id as string;
  }, md);
  expect(id).toBeTruthy();

  // Scope to the notes.md row — an earlier test may have left a text splat
  // (also previewable) in the shared history, so an unscoped .first() would be
  // ambiguous. The row is the deepest element holding both the filename and a
  // Preview button.
  const row = page
    .locator("div")
    .filter({ hasText: "notes.md" })
    .filter({ has: page.getByRole("button", { name: /preview/i }) })
    .last();
  await row.getByRole("button", { name: /preview/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // marked turns "# Title" into a heading and **bold** into <strong>.
  await expect(dialog.getByRole("heading", { name: "Title" })).toBeVisible();
  await expect(dialog.getByText("bold")).toBeVisible();

  // Escape closes the dialog (focus-trap hook wiring).
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("strips external srcset candidates from a rendered splat", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("connected")).toBeVisible({ timeout: 10_000 });

  // A malicious splat mixing a local candidate at 1x with an external beacon at
  // 2x — the sanitizer must not keep the whole srcset just because it starts
  // with a local URL. A unique alt marker lets us find THIS request's image so
  // the test can't pass just because no image rendered.
  const marker = `srcset-check-${Date.now()}`;
  const status = await page.evaluate(async (m) => {
    const res = await fetch("/api/text", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body:
        `<img alt="${m}" src="/favicon.svg" ` +
        'srcset="/favicon.svg 1x, http://evil.example/beacon.png 2x">',
    });
    return res.status;
  }, marker);
  expect(status).toBe(201);

  // The image must actually render (proving the img survived sanitization)…
  const img = page.locator(`img[alt="${marker}"]`);
  await expect(img).toBeAttached({ timeout: 5_000 });
  // …and it must carry no external srcset candidate (our fix drops the whole
  // attribute when any candidate is external).
  await expect(img).not.toHaveAttribute("srcset", /evil\.example/);
});
