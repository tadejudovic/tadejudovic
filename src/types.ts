export type ClipSource = "google_photos" | "shared_album" | "upload";
export type ClipStatus = "importing" | "analyzing" | "ready" | "error";

/** A short window inside a clip that is worth using in a video. */
export interface Moment {
  start: number;
  end: number;
  /** 0..1, how strong the moment is (energy for heuristics, virality for AI). */
  score: number;
  description?: string;
  tags?: string[];
}

export interface Clip {
  id: string;
  source: ClipSource;
  sourceId?: string;
  filename: string;
  file: string;
  thumb?: string;
  kind: "video" | "photo";
  /** When the footage was captured (from Google Photos or file metadata). */
  capturedAt?: string;
  importedAt: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  status: ClipStatus;
  error?: string;
  /** Per-0.5s energy curve (motion + audio), normalized 0..1. */
  energy?: number[];
  /** Heuristic highlight windows. */
  moments?: Moment[];
  /** Claude's read of the clip, if the AI director is enabled. */
  ai?: {
    summary: string;
    tags: string[];
    moments: Moment[];
  };
  /** How many rendered videos have used this clip (to keep daily output fresh). */
  uses: number;
  /** Creator's own description of what's on the footage (optional, fed to the AI director). */
  note?: string;
  /** The situation the clip shows (e.g. "security check"), from the AI or set by the creator. */
  scene?: string;
  sceneSetBy?: "ai" | "creator";
  /** The creator rejected a video because of this footage: it's no longer picked automatically. */
  disliked?: boolean;
}

/** A caption/overlay that is known to have done well on TikTok for a situation. */
export interface ProvenCaption {
  id: string;
  text: string;
  views?: number;
  url?: string;
  /** "overlay" = on-screen text, "description" = the post's caption, "creator" = added by hand. */
  kind: "overlay" | "description" | "creator";
  /** Who posted it / any context. */
  note?: string;
  foundAt: string;
}

export interface PickedHashtag {
  tag: string;
  /** Number of posts using it on TikTok. */
  posts: number;
  tier: "big" | "mid" | "small";
}

export interface SceneResearch {
  scene: string;
  updatedAt?: string;
  error?: string;
  /** Three hashtags picked from the top videos by post count (one big, one mid, one small). */
  hashtags?: PickedHashtag[];
  /** Why hashtags couldn't be picked, if they couldn't. */
  hashtagNote?: string;
  /** Where the captions came from: TikTok search via Apify, or Claude's web search. */
  source?: "tiktok" | "web";
  captions: ProvenCaption[];
}

/** A video the creator knows performed well, used as a style reference. */
export interface Example {
  id: string;
  addedAt: string;
  filename?: string;
  file?: string;
  thumb?: string;
  duration?: number;
  /** Why the creator thinks it worked, context, etc. */
  note?: string;
  /** Overlay text, if the creator wants to type it in. */
  overlayText?: string;
  views?: number;
  status: "analyzing" | "ready" | "error";
  error?: string;
  analysis?: {
    overlayText: string;
    whatHappens: string;
    structure: string;
    whyItWorks: string;
    captionStyle: string;
  };
}

/** A line of on-screen text, timed on the output video's timeline. */
export interface Overlay {
  text: string;
  start: number;
  end: number;
}

export type TemplateId = "auto" | "text_overlay" | "quick_cuts" | "single_moment" | "pov_story" | "then_vs_now";

export interface Segment {
  clipId: string;
  start: number;
  end: number;
  /** On-screen text shown during this segment. */
  caption?: string;
  /** Playback speed multiplier (e.g. 0.5 for slow-mo). */
  speed?: number;
}

export interface VideoPlan {
  template: TemplateId;
  title: string;
  hook: string;
  segments: Segment[];
  /** Caption to paste into TikTok when posting. */
  postCaption: string;
  hashtags: string[];
  plannedBy: "claude" | "heuristic";
  /** Timed overlays; when present they replace the hook/caption text. */
  overlays?: Overlay[];
  /** The director's one-line reasoning, shown in review. */
  concept?: string;
  /** The proven caption this overlay was adapted from. */
  basedOn?: { text: string; views?: number; url?: string };
  scene?: string;
  /** Post counts of the researched hashtags this video uses. */
  hashtagInfo?: PickedHashtag[];
}

export type RenderStatus = "queued" | "rendering" | "done" | "error";
export type ReviewStatus = "pending" | "approved" | "rejected";
/** Why the creator swiped a video away: what to change next time. */
export type RejectReason = "text" | "clip" | "edit" | "other";

export interface Render {
  id: string;
  createdAt: string;
  plan: VideoPlan;
  options: RenderOptions;
  status: RenderStatus;
  progress: number;
  file?: string;
  thumb?: string;
  duration?: number;
  error?: string;
  /** Daily batch this render belongs to (YYYY-MM-DD), if it was made automatically. */
  batch?: string;
  review: ReviewStatus;
  rejectReason?: RejectReason;
  reviewedAt?: string;
  /** The video file was downloaded. */
  downloaded?: boolean;
  /** Whether finishing this render should count as a use of its clips (false for re-renders). */
  countUse?: boolean;
}

export interface RenderOptions {
  keepOriginalAudio: boolean;
  musicFile?: string;
  textStyle: TextStyle;
  fontId: string;
}

export type TextStyle = "yellow" | "classic" | "box" | "plain";

export interface GenerateRequest {
  template: TemplateId;
  targetSeconds: number;
  count: number;
  /** Free-text direction, e.g. "Lex being dramatic about bath time". */
  brief?: string;
  clipIds?: string[];
  useAi: boolean;
  options: RenderOptions;
}

/** A public Google Photos shared-album link the app watches for new videos. */
export interface AlbumSource {
  id: string;
  /** Connector type. Only public Google Photos albums today; e.g. iCloud shared albums could be added. */
  kind: "google_photos_album";
  url: string;
  title?: string;
  addedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  /** Item ids already handled (imported videos and skipped photos). */
  seen: string[];
  videoCount: number;
  /** Version of the video-detection logic `seen` was built with; a newer version re-checks skipped items. */
  detectVersion?: number;
  /** How many times each item's import has failed; items stop being retried after 3. */
  failures?: Record<string, number>;
  /** What Google answered for items that weren't recognized as videos, counted ("=dv: image/jpeg" → 12). */
  skipped?: Record<string, number>;
  /** Only import videos taken in the last N days (for live albums that auto-add every video of the pet). 0/unset = all. */
  recentDays?: number;
  /** Videos left out at the last check because they're older than recentDays. */
  tooOld?: number;
  /** Videos waiting for a later check (each check imports a limited number). */
  waiting?: number;
}

/** A text-overlay format that is currently performing on TikTok. */
export interface TrendFormat {
  /** The reusable pattern, e.g. "POV: the energy shift when ___". */
  pattern: string;
  /** A filled-in pet example. */
  example: string;
  /** What kind of footage it fits. */
  fits: string;
}

export interface Trends {
  updatedAt?: string;
  source: "seed" | "claude_web_search";
  formats: TrendFormat[];
}

export interface AutoSettings {
  enabled: boolean;
  /** Videos per daily batch. */
  dailyCount: number;
  /** Local time the batch is prepared, "HH:MM". */
  dailyTime: string;
  template: TemplateId;
  targetSeconds: number;
  /** How often to check shared albums for new videos. */
  syncEveryHours: number;
  lastBatchDate?: string;
}

/** The creator's recent swipe decisions, fed to the AI director. */
export interface ReviewFeedback {
  kept: { text: string; scene?: string; basedOn?: string }[];
  rejected: { text: string; scene?: string; basedOn?: string; reason?: RejectReason }[];
}
