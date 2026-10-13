# PawCut 🐾

Turn the pile of pet footage in your Google Photos library into ready-to-post **10–20 second vertical shorts** for TikTok, Reels and Shorts, several a day, in a few clicks.

1. **Import**: pick clips straight from Google Photos, or drag and drop files.
2. **Analyze**: every clip gets a motion + sound "energy" curve that finds zoomies, barks and jumps. If an Anthropic API key is set, Claude also looks at the footage and tags the best moments.
3. **Create**: choose a proven format, a length (10/15/20/30s) and how many videos you want.
4. **Post**: download 1080×1920 MP4s with hooks and captions burned in, plus a ready-to-paste caption and hashtags.

## The daily flow

1. **You curate in Google Photos.** Put the videos you think have potential into a shared album and turn on *link sharing*.
2. **Paste the album link into PawCut** ("Watch album"). It is checked every few hours (1–24h, configurable), and new videos are imported and analyzed automatically. Photos in the album are skipped.
3. **Every morning at a time you choose, PawCut prepares a batch** of 3–5 videos (configurable) for review. It favors footage that hasn't been used yet. Everything starts from the footage. For each clip, the AI director:
   - watches the clip and reads your optional note about it (e.g. *"first time at the airport, very excited"*);
   - looks at your **example videos that worked**;
   - decides what the clip is really about, which part to use, and the on-screen line that lands, e.g. *"POV: the energy shift when we pull into the airport"*, optionally with a delayed punchline overlay;
   - writes the **post caption** with hashtags.

   There's no fixed format. Trending text structures are only offered as inspiration, used when they genuinely fit.
4. **You review** in the *Daily batch* section: watch each video, tweak the overlay (one-click re-render) or the caption, then **Approve & download** or **Reject**. Upload the approved ones to TikTok and paste the caption.

Trend inspiration comes from a starter list of proven patterns ("POV: the energy shift when…", "nobody: / Lex at 6am:", "me: … / Lex:", …). If the AI director is on, Claude also searches the web once a day for the text formats pet accounts are using right now and adds them to the rotation. You can also trigger this with *Research what's trending now*. Without an API key, overlays are picked from the starter list and aren't matched to the clip, so read them before approving.

> **Keep the app running** (a spare laptop, a Mac mini or a small server) so the scheduled checks and the morning batch fire. If it was off at the scheduled time, the batch is made as soon as it starts again. **Make today's batch now** runs it on demand.

### About shared-album links

Google has no official API for reading an album from its share link. PawCut reads the same data the album page loads for its own viewer, so it only sees what anyone with the link can see. That has two consequences:

- The reader may need updating if Google changes the page.
- Very large albums may only expose their first few hundred items. Keep the "high potential" album focused, or start a new album every so often.

If you'd rather not use a public link, the **Google Photos picker** import (below) works through Google's official API.

## Footage, look and references

- **Portrait only.** Output is 1080×1920. Landscape clips stay in the library, marked "not used", and are never put in a video.
- **Notes on clips.** Each clip card has a "What's happening?" field. It's optional, but it helps the AI with context the frames can't show (where you are, what just happened).
- **Example videos that worked.** Upload videos that performed well, add the view count and why you think it worked, or just type the overlay text. The AI reads their on-screen text, structure and tone once and writes new overlays in that style without copying them.
- **Fonts.** Choose from 27 fonts creators use in CapCut/TikTok edits, with Outline, Box or Plain styles. CapCut doesn't publish its font list and its built-in fonts can't be redistributed, so the picker offers the free originals or closest matches: TikTok Sans (TikTok's own font), Montserrat (closest to CapCut's "Classic"), Poppins, Bebas Neue, Luckiest Guy and more. They're downloaded from Google Fonts on first use. You can also upload any .ttf/.otf, e.g. a font file you use in CapCut desktop.
- **No watermark.**

## Manual approaches

The *Create manually* panel defaults to **Footage decides**, the same director as the daily batch. You can also force one of these structures:

| Approach | What it does |
|---|---|
| **Footage decides** | The AI picks the edit and text per clip. |
| **Text overlay (POV)** | One continuous clip with one line of text on screen the whole time. |
| **Quick-cut montage** | 6–12 cuts of 1.2–2.2s each. The strongest moment goes first, with a bold hook on screen for the first ~2.5s. |
| **One perfect moment** | One continuous setup → payoff ("wait for it…"). Built to loop. |
| **POV / caption story** | 3–5 beats with escalating captions in the pet's voice. |
| **Then vs now** | Oldest footage vs newest footage (puppy → now), using the capture dates from Google Photos. |

Every render:
- Fills the 9:16 frame.
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

## Put it online behind a password (studio.lexintheair.com)

The app needs an always-on server with ffmpeg and a disk. Serverless hosts like Vercel can't run long video renders or the daily schedule. The repo ships a `Dockerfile` and a Render blueprint (`render.yaml`).

1. **Deploy on [Render](https://render.com):** *New → Blueprint*, pick this GitHub repo and branch. When prompted, fill in:
   - `APP_PASSWORD`: the password for the gate (use a long one);
   - `ANTHROPIC_API_KEY`;
   - `TZ`: your time zone, e.g. `Europe/London`, so the morning batch runs at your local time.

   This creates an always-on web service (Starter plan) with a 10 GB persistent disk at `/data` for clips, renders and settings.
2. **Add the domain in Render:** *Settings → Custom Domains → Add* `studio.lexintheair.com`. Render shows a target like `pawcut-xxxx.onrender.com`.
3. **Point DNS at it.** lexintheair.com's DNS is at Namecheap: *Domain List → Manage → Advanced DNS → Add new record*, type `CNAME`, host `studio`, value = the Render target. Render issues the HTTPS certificate automatically.
4. Open https://studio.lexintheair.com and sign in with `APP_PASSWORD`.

The gate covers every page, API call and media file. Sessions last 30 days, and changing `APP_PASSWORD` signs everyone out. Repeated wrong passwords are throttled. Pages are marked `noindex`. The server refuses to listen publicly without `APP_PASSWORD`.

The same image runs anywhere with a persistent volume (Railway, Fly.io, a VPS): `docker build -t pawcut . && docker run -p 3000:3000 -v pawcut-data:/data -e APP_PASSWORD=… -e ANTHROPIC_API_KEY=… pawcut`.

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
| `src/google/` | Shared-album reader, OAuth, Photos Picker API client |
| `src/albums.ts`, `src/scheduler.ts` | Album watching, the daily batch |
| `src/ai/trends.ts` | Trend research (Claude + web search) and the starter formats |
| `src/media/analyze.ts` | Energy curve and moment detection |
| `src/media/render.ts` | ffmpeg composition |
| `src/ai/director.ts` | Claude: clip tagging, footage-first direction, example analysis (structured JSON outputs) |
| `src/fonts.ts`, `src/examples.ts` | Font library, reference videos |
| `src/planner.ts`, `src/templates.ts` | Heuristic planner and format playbooks |
| `public/` | Single-page UI (no build step) |
| `data/` | Media, renders and `db.json` (git-ignored) |

```bash
npm test          # unit tests (planner, moment detection, text layout, album parsing)
DATA_DIR=/tmp/pc FOOTAGE_DIR=/dir/with/portrait.mp4+landscape.mov npx tsx test/flow.integration.ts   # offline end-to-end of the daily flow
npm run typecheck
```

Without `APP_PASSWORD` the server only listens on `127.0.0.1`.

## Roadmap to a commercial product

What exists today is a single-creator, local-first MVP. The path to a product other creators would pay for:

1. **Multi-tenant backend**: user accounts, Postgres instead of `db.json`, S3/R2 for media, and per-user Google tokens encrypted at rest. Google requires **OAuth app verification** before the Photos scope can be used by the public.
2. **Worker fleet**: move ffmpeg renders to a job queue (e.g. BullMQ/SQS) with autoscaling workers or GPU encoding. Each 15s video takes roughly 10–20s of CPU today.
3. **Direct posting**: the TikTok Content Posting API (requires an app audit), Instagram Graph API for Reels, and YouTube Data API for Shorts, plus a content calendar ("3 posts a day at peak times").
4. **Feedback loop**: pull view and retention stats per post and feed them back into the director, so it learns which hooks and formats work for *this* account.
5. **Better perception**: pet face/body tracking for smart reframing instead of a center crop, beat-synced cuts to licensed music, and auto-subtitles from speech.
6. **Pricing**: a free tier with N videos/month; Pro for unlimited videos, the AI director and direct posting; Agency for multiple pets and accounts.
