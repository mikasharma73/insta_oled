import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import { SESSION_DIR, UA } from "./config.ts";

const PROFILE_DIR = `${SESSION_DIR}/browser-profile`;
const STATE_FILE = `${SESSION_DIR}/storage-state.json`;

export async function launch(headed = true): Promise<BrowserContext> {
  await mkdir(PROFILE_DIR, { recursive: true });

  // A persistent context keeps cookies in PROFILE_DIR on disk, so storageState
  // is not needed here and Playwright rejects it for this launch mode.
  return await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    userAgent: UA,
    viewport: null,
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

export async function saveState(ctx: BrowserContext): Promise<void> {
  await mkdir(SESSION_DIR, { recursive: true });
  await ctx.storageState({ path: STATE_FILE });
}

/** True when the session cookie Instagram uses to identify a login is present. */
export async function isLoggedIn(ctx: BrowserContext): Promise<boolean> {
  try {
    const cookies = await ctx.cookies("https://www.instagram.com");
    return cookies.some((c) => c.name === "sessionid" && c.value.length > 20);
  } catch {
    return false;
  }
}

export async function close(ctx: BrowserContext | null): Promise<void> {
  if (!ctx) return;
  try {
    await saveState(ctx);
  } catch {
    /* saving is best effort */
  }
  try {
    await ctx.close();
  } catch {
    /* already closed */
  }
}
