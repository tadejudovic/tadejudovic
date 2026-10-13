# PawCut 🐾

Turn the pile of pet footage in your Google Photos library into ready-to-post **10–20 second vertical shorts** for TikTok, Reels and Shorts, several a day, in a few clicks.

1. **Import**: pick clips straight from Google Photos, or drag and drop files.
2. **Analyze**: every clip gets a motion + sound "energy" curve that finds zoomies, barks and jumps. If an Anthropic API key is set, Claude also looks at the footage and tags the best moments.
3. **Create**: choose a proven format, a length (10/15/20/30s) and how many videos you want.
4. **Post**: download 1080×1920 MP4s with hooks and captions burned in, plus a ready-to-paste caption and hashtags.

## Formats

| Format | What it does |
|---|---|
| **Quick-cut montage** | 6–12 cuts of 1.2–2.2s each. The strongest moment goes first, with a bold hook on screen for the first ~2.5s. |
| **One perfect moment** | One continuous setup → payoff ("wait for it…"). Built to loop. |
| **POV / caption story** | 3–5 beats with escalating captions in the pet's voice. |
| **Then vs now** | Oldest footage vs newest footage (puppy → now), using the capture dates from Google Photos. |

Every render:
- Crops portrait footage to fill the frame. Landscape footage gets a blurred backdrop.
- Keeps on-screen text inside TikTok's safe zone.
- Normalizes loudness to −14 LUFS.
- Avoids clips you've already posted a lot, so daily output stays fresh.
- Optionally mixes in a music bed. You can also add a trending sound inside TikTok.

## Quick start

Requirements: **Node 20+** and **ffmpeg/ffprobe** on your PATH (`brew install ffmpeg` / `apt install ffmpeg`).

```bash
npm install
cp .env.example .env     # fill in what you have; everything is optional except ffmpeg
npm run dev              # http://localhost:3000
```

Without any keys you can already upload files and generate videos with the built-in heuristic director.

### Connect Google Photos

Google [removed full-library read access](https://developers.google.com/photos/support/updates) for third-party apps in March 2025. The supported way in is the **Google Photos Picker API**: you choose items in Google Photos' own picker and the app receives only those. Tip: search your pet's name or face group in the picker, then select everything.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and **enable the "Photos Picker API"**.
2. Set up the **OAuth consent screen**. While testing, add yourself as a test user. The app only asks for the `photospicker.mediaitems.readonly` scope.
3. Create an **OAuth client ID** of type *Web application* with the redirect URI `http://localhost:3000/auth/google/callback`. It must match `APP_URL`.
4. Put the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.
5. Click **Connect Google Photos** → **Import from Google Photos**.

Picked items are downloaded right away, because Google's download links expire after about an hour. Videos are downloaded in their original quality.

### Turn on the AI director (optional)

Set `ANTHROPIC_API_KEY` in `.env`. Claude then:
- watches up to 16 sampled frames per clip once, on import, and writes a summary, tags and its best moments, which are cached;
- plans each batch of videos from that text catalog. It picks moments, orders the cuts and writes the hook, per-cut captions, post caption and hashtags. You can steer it with a free-text direction, e.g. *"Lex being dramatic about bath time"*.

Because the frames are only analyzed once, planning a day's worth of videos is a single cheap text-only call. Requests use server-side refusal fallbacks (`fallbacks: "default"`). If the API is unavailable, the app falls back to the heuristic planner. Use **Preview plans** to edit hooks and captions before rendering.

## How it works

```
Google Photos Picker ─┐
File upload ──────────┴─► ingest queue ─► ffprobe ─► photo → slow-zoom clip
                                         └► energy curve (frame diff + RMS loudness, per 0.5s)
                                         └► highlight windows ─► [Claude: tags + moments]
Create ─► planner (Claude or heuristic) ─► plan (segments, hook, captions)
       ─► render queue ─► per-segment ffmpeg (9:16 framing, speed, captions)
                      ─► concat ─► hook + handle overlay, music mix, loudnorm ─► MP4
```

| Path | Role |
|---|---|
| `src/server.ts` | Express API and static UI |
| `src/google/` | OAuth and the Photos Picker API client |
| `src/media/analyze.ts` | Energy curve and moment detection |
| `src/media/render.ts` | ffmpeg composition |
| `src/ai/director.ts` | Claude tagging and planning (structured JSON outputs) |
| `src/planner.ts`, `src/templates.ts` | Heuristic planner and format playbooks |
| `public/` | Single-page UI (no build step) |
| `data/` | Media, renders and `db.json` (git-ignored) |

```bash
npm test          # unit tests (planner, moment detection, text layout)
npm run typecheck
```

The server binds to `127.0.0.1` by default because it has no user accounts yet. Set `HOST=0.0.0.0` only behind your own auth.

## Roadmap to a commercial product

What exists today is a single-creator, local-first MVP. The path to a product other creators would pay for:

1. **Multi-tenant backend**: user accounts, Postgres instead of `db.json`, S3/R2 for media, and per-user Google tokens encrypted at rest. Google requires **OAuth app verification** before the Photos scope can be used by the public.
2. **Worker fleet**: move ffmpeg renders to a job queue (e.g. BullMQ/SQS) with autoscaling workers or GPU encoding. Each 15s video takes roughly 10–20s of CPU today.
3. **Direct posting**: the TikTok Content Posting API (requires an app audit), Instagram Graph API for Reels, and YouTube Data API for Shorts, plus a content calendar ("3 posts a day at peak times").
4. **Feedback loop**: pull view and retention stats per post and feed them back into the director, so it learns which hooks and formats work for *this* account.
5. **Better perception**: pet face/body tracking for smart reframing instead of a center crop, beat-synced cuts to licensed music, and auto-subtitles from speech.
6. **Pricing**: a free tier with a watermark and N videos/month; Pro for unlimited videos, the AI director and direct posting; Agency for multiple pets and accounts.
