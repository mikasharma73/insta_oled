import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { DL_DELAY_MS, UA } from "./config.ts";
import { orderedName, safeSegment, uniquePath } from "./naming.ts";
import type { DownloadStats, Item, MediaFile, Profile } from "./types.ts";

type Kind = "photos" | "reels" | "carousels" | "stories";

function dirFor(kind: Item["kind"]): Kind {
  if (kind === "story") return "stories";
  if (kind === "carousel") return "carousels";
  if (kind === "video") return "reels";
  return "photos";
}

export class Downloader {
  constructor(private page: Page) {}

  /** Existing filenames per folder, so re-runs skip work without re-downloading. */
  private async known(dir: string): Promise<Set<string>> {
    try {
      return new Set(await readdir(dir));
    } catch {
      return new Set();
    }
  }

  async save(profile: Profile, kind: Item["kind"], item: Item, index: number, stats: DownloadStats): Promise<void> {
    const root = join(this.base, profile.username, dirFor(kind));
    await mkdir(root, { recursive: true });
    const existing = await this.known(root);
    const base = orderedName(index, item.caption, item.shortcode);
    // Names claimed during this run, so two posts with the same caption do not collide.
    const claimed = new Set<string>();

    const files = item.files;
    let saved = 0;

    for (const [i, file] of files.entries()) {
      const name = files.length > 1 ? `${base}-${String(i + 1).padStart(2, "0")}` : base;
      const candidate = `${name}.${file.ext}`;

      // Resume: if this exact file is already on disk from a previous run, leave it.
      if (existing.has(candidate) || claimed.has(candidate)) {
        stats.skipped++;
        continue;
      }
      const target = join(root, uniquePath(root, name, file.ext, claimed));
      if (await this.fetch(file, target, item.shortcode)) {
        saved++;
        if (file.isVideo) stats.videos++;
        else stats.photos++;
        if (kind === "carousel") stats.carouselsItems++;
        await Bun.sleep(DL_DELAY_MS);
      } else {
        stats.failed++;
      }
    }

    if (saved > 0) {
      if (kind === "carousel") stats.carousels++;
      if (kind === "story") stats.stories++;
      await writeFile(`${root}/${base}.txt`, item.caption, "utf8");
      await this.meta(`${root}/${base}.json`, item, profile);
      console.log(
        `  [${kind}] ${base} -> ${saved}/${files.length} file(s)` +
          (item.caption ? "" : "  (no caption, used shortcode)"),
      );
    }
  }

  private async meta(file: string, item: Item, profile: Profile): Promise<void> {
    await writeFile(
      file,
      JSON.stringify(
        {
          username: profile.username,
          shortcode: item.shortcode,
          url: `https://www.instagram.com/p/${item.shortcode}/`,
          kind: item.kind,
          caption: item.caption,
          takenAt: item.takenAt ? new Date(item.takenAt * 1000).toISOString() : null,
          files: item.files.map((f) => f.url),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  /** Streams through the logged-in browser, so private CDN URLs keep working. */
  private async fetch(file: MediaFile, target: string, shortcode: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const bytes = await this.page.evaluate(
          async ({ url, ua }) => {
            const res = await fetch(url, { credentials: "omit", headers: { "user-agent": ua } });
            if (!res.ok) return { ok: false, status: res.status, data: "" };
            const buf = new Uint8Array(await res.arrayBuffer());
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < buf.length; i += chunk) {
              bin += String.fromCharCode(...buf.subarray(i, i + chunk));
            }
            return { ok: true, status: res.status, data: btoa(bin) };
          },
          { url: file.url, ua: UA },
        );

        if (!bytes.ok) {
          console.warn(`    attempt ${attempt}: HTTP ${bytes.status}`);
          await Bun.sleep(1200 * attempt);
          continue;
        }

        const part = `${target}.part`;
        await Bun.write(part, Buffer.from(bytes.data, "base64"));
        const size = (await stat(part)).size;
        if (size < 1024) {
          await unlink(part);
          console.warn(`    attempt ${attempt}: file too small (${size} bytes)`);
          continue;
        }
        await rename(part, target);
        return true;
      } catch (err) {
        console.warn(`    attempt ${attempt} failed for ${shortcode}: ${(err as Error).message}`);
        await Bun.sleep(1200 * attempt);
      }
    }
    return false;
  }

  base = process.cwd();

  setBase(dir: string): void {
    this.base = dir;
  }
}


