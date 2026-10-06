#!/usr/bin/env bun
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { Api, LoginRequired } from "./src/api.ts";
import { DOWNLOAD_ROOT } from "./src/config.ts";
import { Downloader } from "./src/download.ts";
import { close, isLoggedIn, launch } from "./src/session.ts";
import type { DownloadStats, Item, Profile } from "./src/types.ts";

const HELP = `
insta <command>

  login                  Open a browser, sign in to Instagram, session is saved
  info <username>        Show profile summary (counts, privacy) without downloading
  download <username>    Download everything: posts, reels, carousels, stories
    --out <dir>          Output root (default ./downloads)
    --max <n>            Stop after n posts (useful for a first test)
    --stories            Also download stories (skipped by default)
    --no-posts           Skip posts/reels/carousels, stories only
    --headed             Show the browser window while downloading
    --json               Print the profile summary as JSON

Examples
  bun run index.ts login
  bun run index.ts info someuser
  bun run index.ts download someuser --out ./downloads
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (f: string) => process.argv.includes(f);

/**
 * Opens a browser and returns it ready to use.
 * - `allowAnonymous` lets public profile reads proceed with no login at all.
 * - When a login is required we relaunch headed so the user can sign in,
 *   otherwise an error tells them to run the `login` command.
 */
async function ensureSession(opts: { headed: boolean; allowAnonymous: boolean }): Promise<BrowserContext> {
  let ctx = await launch(opts.headed);
  if (await isLoggedIn(ctx)) return ctx;
  // Public profile data is readable without a session, so `info` may proceed.
  if (opts.allowAnonymous) return ctx;

  await close(ctx);
  if (!opts.headed) {
    throw new Error("Not logged in. Run: bun run index.ts login");
  }
  ctx = await launch(true);
  await interactiveLogin(ctx);
  return ctx;
}

async function interactiveLogin(ctx: BrowserContext): Promise<void> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });

  console.log("\nA browser window is open. Log in there (username/password or QR).");
  console.log("Waiting for Instagram to mark the session as logged in...\n");

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(ctx)) {
      console.log("Logged in. Session saved to .session/\n");
      return;
    }
    await Bun.sleep(2000);
  }
  throw new Error("Login timed out after 5 minutes.");
}

function showProfile(p: Profile): void {
  const n = (v: number) => v.toLocaleString("en-US");
  console.log(`\n  @${p.username}  ${p.fullName}`);
  if (p.isPrivate) console.log("  PRIVATE profile");
  console.log(`  followers   ${n(p.followers)}`);
  console.log(`  following   ${n(p.following)}`);
  console.log(`  posts       ${n(p.mediaCount)}`);
  if (p.bio) console.log(`  bio         ${p.bio.replace(/\n/g, " ").slice(0, 120)}`);
  console.log("");
}

async function cmdInfo(api: Api, username: string): Promise<Profile> {
  const { profile } = await api.profile(username);
  showProfile(profile);
  return profile;
}

async function cmdDownload(
  ctx: BrowserContext,
  username: string,
  opts: { out: string; max: number; stories: boolean; posts: boolean },
): Promise<void> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (page.url() === "about:blank") {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  }

  const api = new Api(page);
  const dl = new Downloader(page);
  dl.setBase(resolve(opts.out));

  const { profile, firstPage } = await api.profile(username);
  showProfile(profile);
  if (profile.isPrivate && !(await isLoggedIn(ctx))) {
    throw new Error("This profile is private and you are not logged in to an account that follows it.");
  }

  const stats: DownloadStats = {
    photos: 0,
    videos: 0,
    carousels: 0,
    carouselsItems: 0,
    stories: 0,
    skipped: 0,
    failed: 0,
  };
  const started = Date.now();

  if (opts.posts) {
    console.log(`Downloading posts (${profile.mediaCount.toLocaleString("en-US")} total)...\n`);
    let i = 0;
    try {
      for await (const batch of api.posts(profile.id, firstPage)) {
        const items = await Promise.all(batch.map((item) => resolveItem(api, item)));
        for (const item of items) {
          if (opts.max && i >= opts.max) break;
          await dl.save(profile, item.kind, item, i + 1, stats);
          i++;
        }
        process.stdout.write(`  ...${i} posts processed\n`);
        if (opts.max && i >= opts.max) break;
      }
    } catch (err) {
      if (err instanceof LoginRequired) {
        console.log(`\n  Stopped after ${i} posts: Instagram requires a login to page further back.`);
        console.log("  Run `bun run index.ts login`, then re-run this command to continue where it stopped.\n");
      } else {
        throw err;
      }
    }
  }

  if (opts.stories) {
    if (!(await isLoggedIn(ctx))) {
      console.log("\nStories need a logged-in session (they are not public). Run `bun run index.ts login` first.");
    } else {
      const stories = await api.stories(profile.id);
      console.log(`\nStories: ${stories.length} found`);
      for (const s of stories) {
        const when = s.takenAt ? new Date(s.takenAt * 1000).toISOString().slice(0, 16) : "?";
        console.log(`  ${when}  ${s.shortcode}  ${s.files[0]?.isVideo ? "video" : "photo"}`);
      }
      for (const [n, item] of stories.entries()) {
        await dl.save(profile, "story", item, n + 1, stats);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `\nDone in ${secs}s -> ${resolve(opts.out, profile.username)}\n` +
      `  photos ${stats.photos}  videos ${stats.videos}  carousel items ${stats.carouselsItems} (${stats.carousels} posts)  stories ${stats.stories}\n` +
      `  skipped ${stats.skipped}  failed ${stats.failed}\n`,
  );
}

/** Carousel children are not always in the paginated payload; refresh via REST. */
async function resolveItem(api: Api, item: Item): Promise<Item> {
  if (item.kind !== "carousel") return item;
  try {
    const full = await api.postDetail(item.id);
    return full.files.length > item.files.length ? full : item;
  } catch {
    return item;
  }
}

async function main(): Promise<void> {
  const [command, arg1] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (!command || command === "help" || has("--help")) {
    console.log(HELP);
    return;
  }

  if (command === "login") {
    const ctx = await launch(true);
    try {
      if (await isLoggedIn(ctx)) {
        console.log("Already logged in. Nothing to do.");
        return;
      }
      await interactiveLogin(ctx);
    } finally {
      await close(ctx);
    }
    return;
  }

  if (command !== "info" && command !== "download") {
    console.error(`Unknown command: ${command}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (!arg1) {
    console.error(`Missing username. Usage: bun run index.ts ${command} <username>`);
    process.exitCode = 1;
    return;
  }

  const username = arg1.replace(/^@/, "");

  const ctx = await ensureSession({
    headed: has("--headed"),
    // Public posts read fine without a session; private data and stories raise
    // LoginRequired on their own, which is a clearer error than failing at launch.
    allowAnonymous: true,
  });

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (page.url() === "about:blank") {
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    }
    const api = new Api(page);

    if (command === "info") {
      const p = await cmdInfo(api, username);
      if (has("--json")) console.log(JSON.stringify(p, null, 2));
      return;
    }

    await cmdDownload(ctx, username, {
      out: arg("--out") ?? DOWNLOAD_ROOT,
      max: Number(arg("--max") ?? 0),
      stories: has("--stories"),
      posts: !has("--no-posts"),
    });
  } catch (err) {
    if (err instanceof LoginRequired) console.error(`\n${err.message}\n`);
    else console.error(`\nError: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await close(ctx);
  }
}

main();
