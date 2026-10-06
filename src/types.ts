export type MediaKind = "photo" | "video" | "carousel" | "story";

export interface MediaFile {
  url: string;
  ext: string;
  isVideo: boolean;
}

export interface Item {
  id: string;
  shortcode: string;
  kind: MediaKind;
  caption: string;
  takenAt: number;
  files: MediaFile[];
}

export interface Profile {
  id: string;
  username: string;
  fullName: string;
  bio: string;
  isPrivate: boolean;
  followers: number;
  following: number;
  mediaCount: number;
  profilePic: string;
}

export interface DownloadStats {
  photos: number;
  videos: number;
  carousels: number;
  carouselsItems: number;
  stories: number;
  skipped: number;
  failed: number;
}
