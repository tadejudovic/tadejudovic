import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
  "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
];

function findFont(): string | null {
  if (process.env.FONT_FILE) return process.env.FONT_FILE;
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appUrl: (process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
  dataDir,
  mediaDir: path.join(dataDir, "media"),
  thumbsDir: path.join(dataDir, "thumbs"),
  rendersDir: path.join(dataDir, "renders"),
  tmpDir: path.join(dataDir, "tmp"),
  dbFile: path.join(dataDir, "db.json"),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  claude: {
    enabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    /** Cheap model for the bulk jobs: scanning every imported clip and reading TikTok covers. */
    fastModel: process.env.CLAUDE_FAST_MODEL ?? "claude-haiku-5-5",
  },
  /** Apify (apify.com) token: lets caption research search TikTok itself, with real view counts. */
  apify: {
    token: process.env.APIFY_TOKEN ?? "",
    actor: process.env.APIFY_TIKTOK_ACTOR ?? "clockworks~tiktok-scraper",
    /** Reads a hashtag's total number of posts (TikTok blocks reading it directly). */
    hashtagActor: process.env.APIFY_HASHTAG_ACTOR ?? "crawlerbros~tiktok-hashtag-scraper",
    /** Reads the comments of TikTok videos (only the creator's own, to learn what their audience asks). */
    commentsActor: process.env.APIFY_COMMENTS_ACTOR ?? "clockworks~tiktok-comments-scraper",
    /** Reads a public Instagram post's numbers (plays, likes, comments). */
    instagramActor: process.env.APIFY_INSTAGRAM_ACTOR ?? "apify~instagram-scraper",
  },
  /** ElevenLabs (elevenlabs.io) API key: clones the creator's voice and reads voiceovers in it. */
  elevenlabs: {
    key: process.env.ELEVENLABS_API_KEY ?? "",
    model: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
  },
  fontFile: findFont(),
  output: { width: 1080, height: 1920, fps: 30 },
};

/** Memory available to this process: the container's limit if there is one (Render, Docker), else the machine's. */
function memoryLimitMb(): number {
  if (process.env.MEMORY_MB) return Number(process.env.MEMORY_MB);
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      const n = Number(v);
      if (v !== "max" && Number.isFinite(n) && n > 0 && n < 1e15) return Math.round(n / 1024 / 1024);
    } catch {}
  }
  return Math.round(os.totalmem() / 1024 / 1024);
}

export const memoryMb = memoryLimitMb();
/** Decoding 4K phone video needs ~300 MB on top of the app; below ~1 GB we avoid it entirely. */
export const canDecode4K = memoryMb >= 1024;

for (const dir of [config.mediaDir, config.thumbsDir, config.rendersDir, config.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
