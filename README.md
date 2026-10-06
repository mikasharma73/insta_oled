# insta

Instagram profile archiver. Logs in once through a real browser, then downloads
everything from a profile into folders named by username, with captions as filenames.

## Setup

```bash
bun install
bunx playwright install chromium
```

If Chromium is missing system libraries on Linux:

```bash
sudo node node_modules/playwright/cli.js install-deps chromium
```

## Commands

```bash
bun run index.ts login                  # opens a browser, sign in, session is saved to .session/
bun run index.ts info <username>        # profile summary only
bun run index.ts download <username>    # everything
bun run index.ts upload <username>      # push downloads/<username>/ to Bunny
bun run index.ts auto <username>        # download, then upload
```

`login` must be run on a machine with a display (or over SSH with X forwarding).
The session is stored in `.session/` and reused, so you only do this once.

### Download options

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Output root, default `./downloads` |
| `--max <n>` | Stop after n posts, good for a first test |
| `--stories` | Also download stories (skipped by default) |
| `--no-posts` | Skip posts, reels and carousels, stories only |
| `--headed` | Keep the browser window visible while downloading |
| `--json` | `info` only, print the summary as JSON |

```bash
bun run index.ts download someuser --out ~/Pictures/insta
bun run index.ts download someuser --max 20      # quick test
bun run index.ts download someuser --stories     # posts plus stories
```

## Output layout

```
downloads/
└── username/
    ├── photos/     single-image posts
    ├── reels/      single-video posts
    ├── carousels/  multi-image posts, numbered -01 -02 ...
    └── stories/    currently active stories
```

Each post gets three files sharing the same stem:

- the media file (`0001-Caption-first-line.jpg`)
- `0001-Caption-first-line.txt` with the full caption
- `0001-Caption-first-line.json` with the permalink, timestamp and source URLs

Filenames start with a zero-padded index so they sort oldest first. Captions are
sanitized: filesystem-illegal characters and emoji removed, first line only,
truncated to 70 characters. Posts with no caption fall back to the shortcode.

Re-running is safe. Files already on disk are skipped, so an interrupted run picks
up where it stopped.

## Bunny CDN upload

`upload` and `auto` push the downloaded folder to a Bunny storage zone, mirroring
the local layout under a key prefix:

```
local  downloads/nasa/photos/0003-In a class of their own.jpg
key    main/nasa/photos/0003-In a class of their own.jpg
url    https://<pull-zone-host>/main/nasa/photos/0003-In a class of their own.jpg
```

Bunny storage has no real folders, `/` is part of the object name, so the nesting
only exists in the path. The dashboard and CDN URLs show it as directories.

Credentials come from the environment, never from a flag:

```bash
export BUNNY_STORAGE_PASSWORD=your-storage-password
export BUNNY_STORAGE_ZONE=123456            # optional, same as --storage-zone
bun run index.ts auto someuser
```

| Flag | Effect |
| --- | --- |
| `--storage-zone <id>` | Storage zone, or `BUNNY_STORAGE_ZONE` |
| `--path <prefix>` | Key prefix inside the zone, default `main` |
| `--no-prefix` | Upload to the zone root, no prefix |
| `--only <subfolder>` | Upload just one of `photos`, `reels`, `carousels`, `stories` |
| `--media-only` | Skip the `.txt` and `.json` sidecars |
| `--concurrency <n>` | Parallel uploads, default 4 |
| `--dry-run` | Print what would be sent, upload nothing. Works without a password |

```bash
bun run index.ts upload someuser --storage-zone 123456 --dry-run
bun run index.ts upload someuser --storage-zone 123456 --media-only
bun run index.ts auto someuser --storage-zone 123456 --stories
```

`auto` checks the Bunny settings before it starts downloading, so a missing
password fails immediately instead of after a long download.

Before each upload the file is HEAD-checked, and an identical size on the zone
side is skipped, so re-running only sends what is actually new. Failures retry
with exponential backoff and a non-zero exit code is returned if anything is
still missing at the end.

## Notes

- Pagination past roughly the 12 most recent posts requires a logged-in session,
  so run `login` first if you want the complete history, not just the first page.
- Stories are never public; they need `login` first, hence `--stories`.
- Request pacing is deliberately slow to avoid tripping Instagram's rate limits.
