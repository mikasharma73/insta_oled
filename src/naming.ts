// \u2063 and \u200b are zero-width/invisible separators Instagram injects into captions.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

export function safeSegment(input: string, max = 80): string {
  let s = (input ?? "")
    .replace(/\r/g, "")
    .split("\n")[0]!
    .replace(INVISIBLE, "")
    .replace(EMOJI, "")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop trailing dots/spaces: Windows and some Linux tooling choke on them.
  s = s.replace(/[. ]+$/g, "");

  if (s.length > max) {
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return s;
}

export function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

/** Builds `0007-caption-slug` style prefixes so files sort chronologically. */
export function orderedName(index: number, caption: string, shortcode: string): string {
  const slug = safeSegment(caption, 70);
  const num = pad(index);
  return slug ? `${num}-${slug}` : `${num}-${shortcode}`;
}

export function uniquePath(dir: string, base: string, ext: string, taken: Set<string>): string {
  let candidate = `${base}.${ext}`;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${i}.${ext}`;
    i++;
  }
  taken.add(candidate);
  return candidate;
}
