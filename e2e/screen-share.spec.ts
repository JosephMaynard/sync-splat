import { test, expect, type Browser, type Page } from "@playwright/test";

// Screen sharing end to end: two browser contexts (two "devices") against the
// real built server, with WebRTC media flowing between them over loopback.
//
// Chrome hides host ICE candidates behind mDNS `.local` names unless the page
// holds a real camera/mic grant; our stubbed capture holds none, and mDNS
// resolution is flaky in headless/sandboxed runs. Disable the obfuscation so
// the peers exchange plain host candidates.
test.use({
  launchOptions: {
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
  },
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * Deterministic getDisplayMedia for headless runs: instead of a real screen
 * picker, return the stream of an off-screen canvas that keeps repainting
 * (captureStream only emits frames when the canvas changes).
 */
function stubDisplayMedia() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    const paint = () => {
      frame += 1;
      ctx.fillStyle = `hsl(${(frame * 7) % 360} 70% 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "32px sans-serif";
      ctx.fillText(`frame ${frame}`, 24, 56);
    };
    paint();
    setInterval(paint, 50);
    return canvas.captureStream(15);
  };
}

async function openDevice(
  browser: Browser,
  opts: { userAgent?: string; stub?: boolean } = {},
): Promise<Page> {
  const context = await browser.newContext(
    opts.userAgent ? { userAgent: opts.userAgent } : {},
  );
  if (opts.stub) await context.addInitScript(stubDisplayMedia);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByText("connected", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  return page;
}

const deviceCount = (page: Page) => page.getByTestId("device-count");

test("presence lists every device and updates when one leaves", async ({
  browser,
}) => {
  const desktop = await openDevice(browser);
  const phone = await openDevice(browser, { userAgent: IPHONE_UA });

  await expect(deviceCount(desktop)).toHaveText("2");
  await expect(deviceCount(phone)).toHaveText("2");

  // Open the list on the phone: both labels, with the phone marked as self.
  const toggle = phone.getByRole("button", { name: /devices online/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = phone.getByRole("region", { name: "Devices online" });
  const self = list.getByRole("listitem").filter({ hasText: "this device" });
  await expect(self).toHaveCount(1);
  await expect(self).toContainText("iPhone · Safari");
  // Playwright's Desktop Chrome profile reports a Windows UA.
  await expect(list).toContainText("Windows · Chrome");
  // Both run on the server's machine (loopback).
  await expect(list.getByText("server", { exact: true })).toHaveCount(2);

  // Escape closes and returns focus to the toggle.
  await phone.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(toggle).toBeFocused();

  // An outside click closes it too.
  await toggle.click();
  await expect(list).toBeVisible();
  await phone.getByRole("textbox", { name: /compose/i }).click();
  await expect(list).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await desktop.context().close();
  await expect(deviceCount(phone)).toHaveText("1");
  await phone.context().close();
});

test("shares a screen to a viewer over WebRTC", async ({ browser }) => {
  const sharer = await openDevice(browser, { stub: true });
  const viewer = await openDevice(browser, { userAgent: IPHONE_UA });

  await expect(deviceCount(sharer)).toHaveText("2");
  await expect(deviceCount(viewer)).toHaveText("2");

  // 127.0.0.1 is a secure context, so the share button is offered.
  await sharer.getByRole("button", { name: "Share screen" }).click();
  await expect(sharer.getByText("You're sharing your screen")).toBeVisible();
  await expect(sharer.getByText("0 watching")).toBeVisible();
  // One share at a time: the button goes away on both sides.
  await expect(sharer.getByRole("button", { name: "Share screen" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Share screen" })).toHaveCount(0);

  await expect(viewer.getByText("is sharing their screen")).toBeVisible();
  await expect(viewer.getByText("Windows · Chrome")).toBeVisible();
  await viewer.getByRole("button", { name: "Watch" }).click();

  const dialog = viewer.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const video = dialog.locator("video");
  // Frames actually decoded and playing — not just a connected peer.
  await expect
    .poll(
      () =>
        video.evaluate((v: HTMLVideoElement) => ({
          width: v.videoWidth,
          playing: !v.paused && v.readyState >= 2,
        })),
      { timeout: 15_000 },
    )
    .toEqual({ width: 640, playing: true });
  await expect(dialog.getByText("Connecting…")).toHaveCount(0);

  await expect(sharer.getByText("1 watching")).toBeVisible();
  // The sharer can see who is watching, not just how many.
  await sharer.getByRole("button", { name: "1 watching" }).click();
  await expect(
    sharer.getByRole("list", { name: "Watching now" }).getByRole("listitem"),
  ).toHaveText(["iPhone · Safari"]);

  // Closing the viewer leaves the share.
  await dialog.getByRole("button", { name: "Stop watching" }).click();
  await expect(dialog).toBeHidden();
  await expect(sharer.getByText("0 watching")).toBeVisible();

  // Stopping ends it for everyone.
  await sharer.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(sharer.getByText("You're sharing your screen")).toBeHidden();
  await expect(viewer.getByText("is sharing their screen")).toBeHidden();
  await expect(sharer.getByRole("button", { name: "Share screen" })).toBeVisible();

  await sharer.context().close();
  await viewer.context().close();
});

test("an open viewer closes with a note when the share ends", async ({
  browser,
}) => {
  const sharer = await openDevice(browser, { stub: true });
  const viewer = await openDevice(browser);

  await sharer.getByRole("button", { name: "Share screen" }).click();
  await viewer.getByRole("button", { name: "Watch" }).click();
  const dialog = viewer.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(sharer.getByText("1 watching")).toBeVisible();

  // The sharer vanishing (tab closed) ends the share server-side.
  await sharer.context().close();
  await expect(dialog).toBeHidden();
  await expect(viewer.getByText("Sharing ended")).toBeVisible();
  await expect(viewer.getByText("is sharing their screen")).toBeHidden();

  await viewer.context().close();
});
