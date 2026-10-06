#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { Api, LoginRequired } from "./src/api.ts";
import { Bunny } from "./src/bunny.ts";
import { DOWNLOAD_ROOT } from "./src/config.ts";
import { Downloader } from "./src/download.ts";
import { close, isLoggedIn, launch } from "./src/session.ts";
import type { DownloadStats, Item, Profile } from "./src/types.ts";

const HELP = `
insta <command>

  login                  Open a browser, sign in to Instagram, session is saved
  info <username>        Show profile summary (counts, privacy) without downloading
  download <username>    Download everything: posts, reels, carousels, stories
  upload <username>      Upload downloads/<username>/ to a Bunny storage zone
  auto <username>        Download then upload in one run
    --out <dir>          Output root (default ./downloads)
    --max <n>            Stop after n posts (useful for a first test)
    --stories            Also download stories (skipped by default)
    --no-posts           Skip posts/reels/carousels, stories only
    --headed             Show the browser window while downloading
    --json               Print the profile summary as JSON

  upload options
    --storage-zone <id>  Bunny storage zone (or BUNNY_STORAGE_ZONE)
    --path <prefix>      Key prefix inside the zone, default "main"
    --no-prefix          Put files at the zone root, no prefix
    --only <subfolder>   Upload just one of photos/reels/carousels/stories
    --media-only         Skip the .txt and .json sidecars
    --concurrency <n>    Parallel uploads, default 4
    --dry-run            List what would be uploaded, send nothing
    --out <dir>          Where downloads/<username> lives, default ./downloads

Examples
  bun run index.ts login
  bun run index.ts info someuser
  bun run index.ts download someuser --out ./downloads

export BUNNY_STORAGE_PASSWORD=...   # required by upload, never passed as a flag
bun run index.ts upload someuser --storage-zone 123456 --dry-run
bun run index.ts upload someuser --storage-zone 123456
bun run index.ts auto someuser --storage-zone 123456          # download then upload
`;

interface UploadOpts {
  zone: string;
  password: string;
  prefix: string;
  only?: string;
  mediaOnly: boolean;
  dryRun: boolean;
  concurrency: number;
  out: string;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

async function cmdUpload(username: string, opts: UploadOpts): Promise<void> {
  const root = join(resolve(opts.out), username);

  try {
    await stat(root);
  } catch {
    throw new Error(
      `No local folder at ${root}. Run "bun run index.ts download ${username}" first.`,
    );
  }

  const bunny = new Bunny({
    zone: opts.zone,
    password: opts.password,
    pathPrefix: opts.prefix,
    only: opts.only,
    mediaOnly: opts.mediaOnly,
    dryRun: opts.dryRun,
    concurrency: opts.concurrency,
  });

  const entries = await bunny.collect(root, username);
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);

  const target = [opts.prefix, username].filter(Boolean).join("/");
  console.log(`Source   ${root}`);
  console.log(`Zone     ${opts.zone}`);
  console.log(`Prefix   ${opts.prefix ? `${opts.prefix}/` : "(none)"}`);
  console.log(`Files    ${entries.length}  (${mb(totalBytes)})`);
  if (opts.only) console.log(`Filter   only ${opts.only}/${opts.mediaOnly ? "media only" : "all files"}`);
  console.log(`Target   ${target}/...\n`);

  if (!entries.length) {
    console.log("Nothing to upload.");
    return;
  }

  const started = Date.now();
  const result = await bunny.upload(entries);
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  console.log(
    `\n${opts.dryRun ? "Dry run finished" : "Upload finished"} in ${secs}s\n` +
      `  uploaded ${result.uploaded}  skipped ${result.skipped}  failed ${result.failed}\n`,
  );

  if (result.failed > 0) process.exitCode = 1;
}

/** Reads the Bunny settings from flags and env, shared by `upload` and `auto`. */
function uploadOptsFromArgs(out: string): UploadOpts {
  const dryRun = has("--dry-run");
  const password = Bun.env.BUNNY_STORAGE_PASSWORD ?? "";
  const zone = arg("--storage-zone") ?? Bun.env.BUNNY_STORAGE_ZONE ?? "";

  if (!password && !dryRun) {
    throw new Error("Set BUNNY_STORAGE_PASSWORD in your environment before running upload.");
  }
  if (!zone) {
    throw new Error("Pass --storage-zone <id> or set BUNNY_STORAGE_ZONE.");
  }

  return {
    zone,
    password,
    prefix: has("--no-prefix") ? "" : (arg("--path") ?? "main"),
    only: arg("--only"),
    mediaOnly: has("--media-only"),
    dryRun,
    concurrency: Number(arg("--concurrency") ?? 4),
    out,
  };
}

/** download, then upload, in one run. */
async function cmdAuto(
  ctx: BrowserContext,
  username: string,
  out: string,
  download: { max: number; stories: boolean; posts: boolean },
): Promise<void> {
  // Resolve Bunny settings first so a missing password fails immediately
  // rather than after a long download.
  const upload = uploadOptsFromArgs(out);

  await cmdDownload(ctx, username, { ...download, out });

  console.log("\n" + "=".repeat(60) + "\n");
  await cmdUpload(username, upload);
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

  if (command !== "info" && command !== "download" && command !== "upload" && command !== "auto") {
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

  // Upload needs no Instagram session, only the local folder and Bunny creds.
  if (command === "upload") {
    const out = arg("--out") ?? DOWNLOAD_ROOT;
    try {
      await cmdUpload(username, uploadOptsFromArgs(out));
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

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

    const downloadOpts = {
      out: arg("--out") ?? DOWNLOAD_ROOT,
      max: Number(arg("--max") ?? 0),
      stories: has("--stories"),
      posts: !has("--no-posts"),
    };

    if (command === "download") {
      await cmdDownload(ctx, username, downloadOpts);
      return;
    }

    await cmdAuto(ctx, username, downloadOpts.out, {
      max: downloadOpts.max,
      stories: downloadOpts.stories,
      posts: downloadOpts.posts,
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
