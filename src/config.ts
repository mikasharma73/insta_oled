import { resolve } from "node:path";

export const APP_ID = "936619743392459";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const ROOT = resolve(import.meta.dir, "..");
export const SESSION_DIR = resolve(ROOT, ".session");
export const DOWNLOAD_ROOT = resolve(ROOT, "downloads");

/** Delay between media downloads, milliseconds. */
export const DL_DELAY_MS = 250;
