import type { Page } from "playwright";
import { APP_ID, UA } from "./config.ts";
import type { Item, MediaFile, Profile } from "./types.ts";

/**
 * All network calls run inside the logged-in page so that session cookies,
 * the csrf token and same-origin headers are applied exactly like the real app.
 */

interface FetchOpts {
  method?: "GET" | "POST";
  body?: unknown;
}

export class Api {
  constructor(private page: Page) {}

  private async raw(url: string, opts: FetchOpts = {}): Promise<{ status: number; ok: boolean; text: string }> {
    const headers: Record<string, string> = {
      "x-ig-app-id": APP_ID,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "x-requested-with": "XMLHttpRequest",
      "x-asbd-id": "129477",
      "referer": "https://www.instagram.com/",
    };
    if (opts.body) headers["content-type"] = "application/x-www-form-urlencoded";

    // A Response object cannot cross the evaluate boundary, so flatten it here.
    return await this.page.evaluate(
      async ({ url, headers, method, body }) => {
        const res = await fetch(url, {
          method: method ?? "GET",
          headers,
          credentials: "include",
          body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
        });
        return { status: res.status, ok: res.ok, text: await res.text() };
      },
      {
        url,
        headers,
        method: opts.method ?? "GET",
        body: opts.body ?? null,
      },
    );
  }

  private async json<T>(url: string, opts: FetchOpts = {}): Promise<T> {
    let lastErr: unknown;

    // Instagram answers 401 both for a dead session and for rate limiting, so
    // back off and retry before concluding the login is gone.
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await this.raw(url, opts);
      const text = res.text;

      if (res.ok) {
        try {
          return JSON.parse(text) as T;
        } catch {
          if (text.includes("<html")) throw new LoginRequired(url);
          throw new Error(`Bad JSON from ${url}: ${text.slice(0, 200)}`);
        }
      }

      lastErr = new HttpError(res.status, url, text.slice(0, 300));
      const retriable = res.status === 401 || res.status === 429 || res.status === 500 || res.status === 503;
      if (!retriable || attempt === 4) throw lastErr;

      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${res.status} from Instagram, retrying in ${wait / 1000}s (${attempt}/4)`);
      await Bun.sleep(wait);
    }
    throw lastErr;
  }

  async profile(username: string): Promise<{ profile: Profile; firstPage: GqlPage }> {
    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const data = await this.json<{ data: { user: GqlUser } }>(url);
    const u = data.data.user;
    if (!u) throw new Error(`Profile not found: @${username}`);

    return {
      profile: {
        id: String(u.id),
        username: u.username,
        fullName: u.full_name ?? u.username,
        bio: u.biography ?? "",
        isPrivate: Boolean(u.is_private),
        followers: u.edge_followed_by?.count ?? 0,
        following: u.edge_follow?.count ?? 0,
        mediaCount: u.edge_owner_to_timeline_media?.count ?? 0,
        profilePic: u.profile_pic_url ?? "",
      },
      firstPage: u.edge_owner_to_timeline_media ?? { edges: [], page_info: { has_next_page: false, end_cursor: null } },
    };
  }

  /** Paginate a profile's timeline. Falls back across endpoints until one works. */
  async *posts(userId: string, first: GqlPage): AsyncGenerator<Item[]> {
    let cursor = first.page_info.end_cursor;
    let hasNext = first.page_info.has_next_page;

    if (first.edges.length) yield first.edges.map((e) => fromGql(e.node));

    let mode: "gql" | "rest" = "gql";

    while (hasNext) {
      if (!cursor) break;
      await Bun.sleep(900);

      try {
        const page =
          mode === "gql"
            ? await this.gqlPosts(userId, cursor)
            : await this.restPosts(userId, cursor);
        if (!page.items.length) break;
        yield page.items;
        hasNext = page.hasNext;
        cursor = page.cursor;
      } catch (err) {
        if (mode === "gql" && err instanceof HttpError && err.status === 400) {
          mode = "rest"; // this session cannot use the old graphql hashes
          continue;
        }
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new LoginRequired("posts");
        throw err;
      }
    }
  }

  private async gqlPosts(userId: string, after: string): Promise<RawPage> {
    const hashes = [
      "003056d32c2554def87228bc3fd9668a",
      "e7e2f4da4b02303f74f0841279e52d76",
      "69cba40317214236af40e7efa697781d",
    ];
    let lastErr: unknown;

    for (const hash of hashes) {
      const vars = encodeURIComponent(JSON.stringify({ id: userId, first: 50, after }));
      const url = `https://www.instagram.com/graphql/query/?query_hash=${hash}&variables=${vars}`;
      try {
        const data = await this.json<{
          data?: { user?: { edge_owner_to_timeline_media: GqlPage } };
        }>(url);
        const tl = data.data?.user?.edge_owner_to_timeline_media;
        if (!tl) {
          lastErr = new Error(`graphql hash ${hash} returned no timeline`);
          continue;
        }
        return {
          items: tl.edges.map((e) => fromGql(e.node)),
          cursor: tl.page_info.end_cursor,
          hasNext: tl.page_info.has_next_page,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.status === 401) throw new LoginRequired("graphql");
      }
    }
    throw lastErr ?? new Error("all graphql hashes failed");
  }

  private async restPosts(userId: string, maxId: string): Promise<RawPage> {
    const url = `https://i.instagram.com/api/v1/feed/user/${userId}/?count=50&max_id=${encodeURIComponent(maxId)}`;
    const data = await this.json<{ items: RestItem[]; next_max_id?: string; next_max_id_str?: string }>(url);
    return {
      items: data.items.map(fromRest),
      cursor: data.next_max_id_str ?? data.next_max_id ?? null,
      hasNext: Boolean(data.next_max_id ?? data.next_max_id_str),
    };
  }

  /** Full detail for one post, needed for carousel children. */
  async postDetail(id: string): Promise<Item> {
    const url = `https://i.instagram.com/api/v1/media/${id}/info/`;
    const data = await this.json<{ items: RestItem[] }>(url);
    if (!data.items?.length) throw new Error(`no detail for media ${id}`);
    return fromRest(data.items[0]!);
  }

  /** Active stories for a user, newest first. */
  async stories(userId: string): Promise<Item[]> {
    const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
    const data = await this.json<{ reels: Record<string, { items: RestItem[] }> }>(url);
    return (data.reels[userId]?.items ?? []).map((it) => ({
      ...fromRest(it),
      kind: "story" as const,
    }));
  }
}

/* --------------------------------- shaping -------------------------------- */

export function fromRest(it: RestItem): Item {
  const files: MediaFile[] = [];
  const children = it.carousel_media ?? [];

  if (children.length) {
    for (const c of children) files.push(...filesOf(c));
  } else {
    files.push(...filesOf(it));
  }

  const isCarousel = children.length > 1;
  const kind = isCarousel ? "carousel" : files[0]?.isVideo ? "video" : "photo";

  return {
    id: String(it.id),
    shortcode: it.code,
    kind,
    caption: it.caption?.text ?? "",
    takenAt: it.taken_at ?? 0,
    files,
  };
}

function filesOf(it: RestItem): MediaFile[] {
  const out: MediaFile[] = [];
  const vid = it.video_versions?.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  if (vid?.url) out.push({ url: vid.url, ext: "mp4", isVideo: true });
  const img = it.image_versions2?.candidates ?? [];
  const best = img[0]?.url ?? img[img.length - 1]?.url;
  if (!vid?.url && best) out.push({ url: best, ext: "jpg", isVideo: false });
  return out;
}

export function fromGql(node: GqlNode): Item {
  const children = node.edge_sidecar_to_children?.edges ?? [];
  const files: MediaFile[] = [];

  if (children.length) {
    for (const c of children) files.push(...filesOfGql(c.node));
  } else {
    files.push(...filesOfGql(node));
  }

  const isCarousel = children.length > 1;
  return {
    id: String(node.id),
    shortcode: node.shortcode,
    kind: isCarousel ? "carousel" : files[0]?.isVideo ? "video" : "photo",
    caption: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
    takenAt: node.taken_at_timestamp ?? 0,
    files,
  };
}

function filesOfGql(n: GqlNode): MediaFile[] {
  const out: MediaFile[] = [];
  if (n.is_video && n.video_url) out.push({ url: n.video_url, ext: "mp4", isVideo: true });
  if (out.length === 0 && n.display_url) {
    const url = n.display_url.replace(/\/s\d+x\d+/, "/s1080x1080");
    out.push({ url, ext: "jpg", isVideo: false });
  }
  return out;
}

/* ---------------------------------- errors -------------------------------- */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export class LoginRequired extends Error {
  constructor(what: string) {
    super(`Instagram asked to log in again while reading ${what}. Run: bun run index.ts login`);
    this.name = "LoginRequired";
  }
}

/* ---------------------------------- shapes -------------------------------- */

export interface GqlPage {
  count?: number;
  edges: { node: GqlNode }[];
  page_info: { has_next_page: boolean; end_cursor: string | null };
}

export interface RawPage {
  items: Item[];
  cursor: string | null;
  hasNext: boolean;
}

export interface GqlNode {
  id: string;
  shortcode: string;
  __typename?: string;
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  taken_at_timestamp?: number;
  product_type?: string;
  edge_media_to_caption?: { edges: { node: { text: string } }[] };
  edge_sidecar_to_children?: { edges: { node: GqlNode }[] };
}

export interface GqlUser {
  id: string | number;
  username: string;
  full_name?: string;
  biography?: string;
  is_private?: boolean;
  profile_pic_url?: string;
  edge_followed_by?: { count: number };
  edge_follow?: { count: number };
  edge_owner_to_timeline_media?: GqlPage;
}

export interface RestItem {
  id: string | number;
  code: string;
  taken_at?: number;
  media_type?: number;
  caption?: { text: string } | null;
  image_versions2?: { candidates?: { url: string; width?: number; height?: number }[] };
  video_versions?: { url: string; width?: number; height?: number }[];
  carousel_media?: RestItem[] | null;
}

export { UA };
