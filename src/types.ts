export type ClipSource = "google_photos" | "upload";
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
}

export type TemplateId = "quick_cuts" | "single_moment" | "pov_story" | "then_vs_now";

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
}

export type RenderStatus = "queued" | "rendering" | "done" | "error";

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
}

export interface RenderOptions {
  /** "fill" crops to 9:16, "blur" letterboxes over a blurred copy. "auto" picks per clip. */
  framing: "auto" | "fill" | "blur";
  keepOriginalAudio: boolean;
  musicFile?: string;
  textStyle: "classic" | "box";
}

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
