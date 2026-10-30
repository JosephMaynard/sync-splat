import { test, expect } from "@playwright/test";

test("a lost send preserves the draft, reports uncertainty, and can be retried", async ({ page, request }) => {
  let upgraded = false;
  let dropped = false;
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (message === "5") upgraded = true;
      if (!dropped && typeof message === "string" && message.includes('"text:send"')) {
        dropped = true;
        return;
      }
      server.send(message);
    });
  });
  await page.goto("/");
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect.poll(() => upgraded).toBe(true);
  const draft = "lost-send regression draft";
  const box = page.getByRole("textbox", { name: "Compose message" });
  await box.fill(draft);
  await page.getByRole("button", { name: "Broadcast", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Delivery wasn't confirmed", { timeout: 12_000 });
  expect(dropped).toBe(true);
  await expect(box).toHaveText(draft);
  const before = await (await request.get("/api/history")).json();
  expect(before.some((item: { html?: string }) => item.html === draft)).toBe(false);
  await page.getByRole("button", { name: "Broadcast", exact: true }).click();
  await expect(box).toBeEmpty();
  await expect.poll(async () => {
    const history = await (await request.get("/api/history")).json();
    return history.filter((item: { html?: string }) => item.html === draft).length;
  }).toBe(1);
});

for (const edit of ["replace", "restore same text"] as const) {
  test(`upload completion preserves a draft edited during sending (${edit})`, async ({ page }) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let uploading = false;
    await page.route("**/api/upload?**", async (route) => {
      uploading = true;
      await blocked;
      await route.continue();
    });
    await page.goto("/");
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    const box = page.getByRole("textbox", { name: "Compose message" });
    await box.fill("submitted draft");
    await page.locator('input[type="file"]').setInputFiles({
      name: `draft-${edit}.txt`, mimeType: "text/plain", buffer: Buffer.from("attachment"),
    });
    await page.getByRole("button", { name: "Broadcast", exact: true }).click();
    try {
      await expect.poll(() => uploading).toBe(true);
      await box.fill("new unsent draft");
      if (edit === "restore same text") await box.fill("submitted draft");
    } finally { release(); }
    await expect(page.getByRole("button", { name: "Broadcast", exact: true })).toBeEnabled();
    await expect(box).toHaveText(edit === "replace" ? "new unsent draft" : "submitted draft");
    await expect(page.getByRole("button", { name: /^Remove draft-/ })).toHaveCount(0);
  });
}

for (const mode of ["rich", "plain", "legacy"] as const) {
  test(`copy preserves line breaks, blank lines and preformatted spacing (${mode})`, async ({ page, request }) => {
    await page.goto("/");
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await page.evaluate((mode) => {
      const save = (text: string) => { (window as typeof window & { copiedText: string }).copiedText = text; };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "legacy" ? undefined : {
        write: mode === "rich" ? async (items: ClipboardItem[]) => save(await (await items[0].getType("text/plain")).text()) : undefined,
        writeText: async (text: string) => save(text),
      } });
      document.execCommand = (command: string) => {
        if (command !== "copy") return false;
        save((document.activeElement as HTMLTextAreaElement).value);
        return true;
      };
    }, mode);
    const marker = `copy-boundaries-${mode}`;
    const response = await request.post("/api/text", { headers: { "Content-Type": "text/plain" },
      data: `<p>${marker}<br>beta</p><div>gamma</div><div><br></div><pre>  delta\n epsilon</pre><ul><li>one</li><li>two</li></ul>`,
    });
    expect(response.status()).toBe(201);
    const row = page.locator("div").filter({ hasText: marker })
      .filter({ has: page.getByRole("button", { name: "Copy to clipboard", exact: true }) }).last();
    await row.getByRole("button", { name: "Copy to clipboard", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { copiedText?: string }).copiedText))
      .toBe(`${marker}\nbeta\ngamma\n\n  delta\n epsilon\none\ntwo`);
  });
}

for (const failure of ["access", "read", "write"] as const) {
  test(`theme and startup tolerate storage ${failure} failures`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((failure) => {
      if (failure === "access") {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Denied", "SecurityError"); } });
      } else {
        Storage.prototype[failure === "read" ? "getItem" : "setItem"] = () => {
          throw new DOMException("Unavailable", failure === "read" ? "SecurityError" : "QuotaExceededError");
        };
      }
    }, failure);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // An explicit choice remains effective even when persistence failed.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(errors).toEqual([]);
  });
}
