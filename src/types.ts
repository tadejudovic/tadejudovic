export type ClipSource = "google_photos" | "shared_album" | "upload";
/** "archived": an unusable clip whose files were deleted; the record stays so it's never imported again. */
export type ClipStatus = "importing" | "analyzing" | "ready" | "error" | "archived";

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
  /** Where it was filmed ("Lisbon, Portugal"): from the file's GPS, the AI's read of signs, or the creator. */
  place?: string;
  placeSource?: "gps" | "ai" | "creator";
  /** The situation the clip shows (e.g. "security check"), from the AI or set by the creator. */
  scene?: string;
  sceneSetBy?: "ai" | "creator";
  /** The creator rejected a video because of this footage: it's no longer picked automatically. */
  disliked?: boolean;
  /** Already an edited video (text, captions or stickers on it): never picked automatically. */
  edited?: boolean;
  /** The creator marked (or unmarked) the clip as already edited: the AI doesn't change it. */
  editedSetBy?: "creator";
  /** When its files were deleted (see ClipStatus "archived"). */
  archivedAt?: string;
  /** Why the AI look at this clip failed (it's retried on the next start). */
  tagError?: string;
  /** The same video was already imported (e.g. it's in two albums) as this clip: never picked automatically. */
  duplicateOf?: string;
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
  /** "pets": from pet videos; "everyone": from general videos of the same situation (works for any audience). */
  audience?: "pets" | "everyone";
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
  /** "caption": subtitles in the lower part of the frame (voiceover videos), instead of the hook position. */
  at?: "caption";
  /** Where the text block's center sits (0 top … 1 bottom), instead of the usual position. */
  y?: number;
  /** And across (0 left … 1 right), for points that zig-zag over the frame; centered when unset. */
  x?: number;
  /** A red arrow from the text to this point of the frame (0..1 from the left / top). */
  pointTo?: { x: number; y: number };
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
  /** The kind of post: "fun" (entertainment), "tips" (educational) or "inspire" (inspirational). */
  format?: PostFormat;
  /** The follower question an educational video answers. */
  faq?: string;
  /** Educational: the theme (destination, airline, gear) and the specific topic, so it isn't repeated. */
  pillar?: EduPillar;
  topic?: string;
  /** Made from footage beyond the airport situations (the daily outside video). */
  outside?: boolean;
  /** A remake of a video the creator rejected (that video's id), and how many remakes deep. */
  remakeOf?: string;
  remakeDepth?: number;
  /** Who the text speaks to (fun and inspirational alternate between the two). */
  audience?: "pets" | "everyone";
  /** The part of the frame (top to bottom, 0..1) where the subject is: Lex, faces. Text stays out of it. */
  keepClear?: { top: number; bottom: number };
  /** Set when the AI couldn't write this video and a no-AI fallback was used: why. */
  aiNote?: string;
  /** Voiceover lines on the output timeline (story videos with the creator's voice). */
  voiceover?: { file: string; start: number }[];
  /** A brand collaboration version of a video. */
  collab?: { partnerId: string; name: string; handle?: string };
}

export type PostFormat = "fun" | "tips" | "inspire" | "story";

/** How many candidates of each kind of post a round makes (the creator keeps the best of each). */
export interface DailyMix {
  fun: number;
  educational: number;
  inspirational: number;
}

/** One spoken line of a voiceover story: its words, the clip shown, and the creator's recording. */
export interface DraftLine {
  text: string;
  /** The footage the creator asked for with [..] or /word in their text. */
  shot?: string;
  clipId?: string;
  start?: number;
  end?: number;
  /** What footage this line needs when no clip fits. */
  missing?: string;
  /** The recorded line (m4a) and its length. */
  audio?: string;
  audioSeconds?: number;
  /** Recorded by the creator, or read by their cloned voice. */
  audioBy?: "me" | "clone";
}

/** A voiceover story waiting for its recording: built from a script (word for word) or a talk track (rewritten). */
export interface StoryDraft {
  id: string;
  createdAt: string;
  mode: "script" | "talk";
  source: string;
  partnerId?: string;
  title: string;
  lines: DraftLine[];
  postCaption: string;
  hashtags: string[];
  basedOn?: { text: string; views?: number; url?: string };
  scene?: string;
}

/** A question followers ask, with the creator's answer. */
export interface FaqItem {
  q: string;
  a?: string;
}

/** A brand the creator works with. */
export interface Partner {
  id: string;
  name: string;
  /** @handle on TikTok/Instagram. */
  handle?: string;
  /** What the product/place is and what to highlight, in the creator's words. */
  about: string;
  /** Anything every collab post must include: a code, link, wording. */
  mustInclude?: string;
}

export type RenderStatus = "queued" | "rendering" | "done" | "error";
export type ReviewStatus = "pending" | "approved" | "rejected";
/** Why the creator swiped a video away: what to change next time. */
/** Educational themes, in rotation: how to get to a place, airlines, what we travel with. */
export type EduPillar = "destination" | "airline" | "gear";

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
  /** The new version made after this one was rejected. */
  remadeAs?: string;
  /** The creator's own words on what they didn't like. */
  rejectNote?: string;
  reviewedAt?: string;
  /** The video file was downloaded. */
  downloaded?: boolean;
  /** Where the creator posted it (TikTok and/or Instagram), and how it's doing there. */
  posts?: PostedInfo[];
  /** Before Instagram was supported: the TikTok post. Moved into `posts` on load. */
  posted?: PostedInfo;
  /** Whether this is a new video: counts toward the daily limit and as a use of its clips (false for re-renders). */
  countUse?: boolean;
  /** Its clips' use was counted when it finished. */
  usesCounted?: boolean;
  /** Rejected, so its clips were handed back to be tried again. */
  usesReturned?: boolean;
}

export interface RenderOptions {
  keepOriginalAudio: boolean;
  musicFile?: string;
  textStyle: TextStyle;
  /** Size of the text on the video; older videos without it render at "medium". */
  textSize?: TextSize;
  fontId: string;
}

export type TextStyle = "yellowbox" | "yellow" | "classic" | "box" | "plain";
export type TextSize = "small" | "medium" | "large";
/** Who the on-screen text is written for. */
export type CaptionAudience = "pets" | "mix" | "everyone";

export interface GenerateRequest {
  template: TemplateId;
  targetSeconds: number;
  count: number;
  /** Free-text direction, e.g. "Lex being dramatic about bath time". */
  brief?: string;
  clipIds?: string[];
  /** clipIds are a pool to choose from (rotating situations, one take per moment), not a hand-picked list. */
  pickFromPool?: boolean;
  /** Make this kind of video (instead of following the daily mix). */
  format?: PostFormat;
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
  /** Items Rollcut can see in the album (big albums load in batches). */
  itemsSeen?: number;
  /** Whether the whole album could be listed, and why not if it couldn't. */
  listingComplete?: boolean;
  listingError?: string;
  /** Older videos (before the date range) imported because the range was used up. */
  reachedBack?: number;
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
export interface PostStats {
  views: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

export type Platform = "tiktok" | "instagram";

export interface PostedInfo {
  platform: Platform;
  url: string;
  addedAt: string;
  stats?: PostStats;
  fetchedAt?: string;
  /** When TikTok says it was posted. */
  postedAt?: string;
  error?: string;
}

export interface FeedbackItem {
  text: string;
  scene?: string;
  basedOn?: string;
  /** fun / tips / inspire */
  format?: string;
}

/** A change the creator made to a video's words: kept (even when videos are deleted) and fed to the AI. */
export interface EditRecord {
  at: string;
  what: "text" | "caption" | "hashtags";
  before: string;
  after: string;
  format?: PostFormat;
  scene?: string;
}

export interface ReviewFeedback {
  /** The creator's own corrections, newest first: the most direct signal of their taste. */
  edits?: EditRecord[];
  kept: FeedbackItem[];
  rejected: (FeedbackItem & { reason?: RejectReason; note?: string })[];
  /** Posted videos with real stats, best first. */
  performance?: (FeedbackItem & { platform: Platform; views: number; likes?: number; shares?: number; saves?: number })[];
}
