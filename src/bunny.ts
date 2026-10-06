import { readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

const HOST = "https://storage.bunnycdn.net";
const MEDIA_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".mp4",
  ".mov",
  ".webm",
  ".m4v",
]);

export interface BunnyOpts {
  zone: string;
  password: string;
  /** Literal key prefix inside the zone, e.g. `main`. Empty for none. */
  pathPrefix: string;
  /** Subfolder inside the username folder to upload. Empty for all of them. */
  only?: string;
  /** Skip .txt and .json sidecars. */
  mediaOnly: boolean;
  /** Log what would be uploaded without sending anything. */
  dryRun: boolean;
  concurrency: number;
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

interface FileEntry {
  local: string;
  /** Object key relative to the zone root, without prefix. */
  key: string;
  size: number;
}

export function objectKey(prefix: string, username: string, rel: string): string {
  const clean = rel.split(sep).join(posix.sep);
  const parts = [prefix, username, clean].filter(Boolean);
  return parts.join("/");
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export class Bunny {
  constructor(private opts: BunnyOpts) {}

  private url(key: string): string {
    return `${HOST}/${encodeKey(this.opts.zone)}/${encodePath(key)}`;
  }

  private headers(): Record<string, string> {
    return { AccessKey: this.opts.password, "content-type": "application/octet-stream" };
  }

  /** Collects everything under root, honouring the media-only and only filters. */
  async collect(root: string, username: string): Promise<FileEntry[]> {
    const all = await walk(root);
    const entries: FileEntry[] = [];

    for (const local of all) {
      const rel = relative(root, local);
      const top = rel.split(sep)[0] ?? "";
      if (this.opts.only && top !== this.opts.only) continue;
      if (this.opts.mediaOnly && !MEDIA_EXT.has(extOf(local))) continue;

      const { size } = await stat(local);
      entries.push({ local, key: objectKey(this.opts.pathPrefix, username, rel), size });
    }

    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Sends everything, a few at a time. Existing same-size files are skipped. */
  async upload(entries: FileEntry[]): Promise<UploadResult> {
    const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0, bytes: 0 };
    if (this.opts.dryRun) {
      for (const e of entries) {
        console.log(`  would PUT ${e.key}  (${format(e.size)})`);
        result.skipped++;
      }
      return result;
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, this.opts.concurrency) }, async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]!;
        const existing = await this.sizeAt(entry.key);
        if (existing === entry.size && entry.size > 0) {
          result.skipped++;
          console.log(`  skip   ${entry.key} (already there)`);
          continue;
        }
        const sent = await this.put(entry);
        if (sent) {
          result.uploaded++;
          result.bytes += entry.size;
          console.log(`  ok     ${entry.key}  ${format(entry.size)}`);
        } else {
          result.failed++;
          console.error(`  FAIL   ${entry.key}`);
        }
      }
    });

    await Promise.all(workers);
    return result;
  }

  private async sizeAt(key: string): Promise<number | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(this.url(key), { method: "HEAD", headers: this.headers() });
        if (res.status === 404) return null;
        if (res.status === 401 || res.status === 403) throw new Error(
          `Bunny rejected the storage password (HTTP ${res.status}). Check BUNNY_STORAGE_PASSWORD and the zone id.`,
        );
        if (res.ok) return Number(res.headers.get("content-length") ?? -1);
        await backoff(attempt);
      } catch (err) {
        if ((err as Error).message.includes("Bunny rejected")) throw err;
        await backoff(attempt);
      }
    }
    return null;
  }

  private async put(entry: FileEntry): Promise<boolean> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const body = Bun.file(entry.local);
        const res = await fetch(this.url(entry.key), {
          method: "PUT",
          headers: this.headers(),
          body,
        });

        if (res.ok) return true;
        if (res.status === 401 || res.status === 403) throw new Error(
          `Bunny rejected the storage password (HTTP ${res.status}) on ${entry.key}`,
        );
        const detail = (await res.text()).slice(0, 160);
        console.warn(`    ${res.status} ${detail}`);
        if (res.status === 400 || res.status === 404) return false; // bad key, retrying will not help
        await backoff(attempt);
      } catch (err) {
        if ((err as Error).message.includes("Bunny rejected")) throw err;
        console.warn(`    attempt ${attempt}: ${(err as Error).message}`);
        await backoff(attempt);
      }
    }
    return false;
  }
}

function backoff(attempt: number): Promise<void> {
  return Bun.sleep(1000 * 2 ** (attempt - 1));
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

/** The zone id is a plain token; object keys keep their slashes. */
function encodeKey(key: string): string {
  return key;
}

/** Percent-encodes each segment but keeps the separators readable. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function format(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

