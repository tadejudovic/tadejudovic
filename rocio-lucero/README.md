# Rocío Lucero — website

A simple, fast website for Rocío's music: latest release, music players, videos, concerts, bio, press kit and contact.

**Everything on the site is edited in one file: [`content.js`](content.js).** You never need to touch the other files.

## How to change something (no coding needed)

1. On GitHub, open `rocio-lucero/content.js` and click the ✏️ pencil (Edit).
2. Change the text between the quotes. Keep the commas at the ends of lines.
3. Click **Commit changes**. If the site is connected to a host (see below), it updates by itself within a minute.

### Common edits

| I want to… | In `content.js` |
|---|---|
| Promote a new single | Edit `featured` (title + link) |
| Add a song or album | Add an entry to `music` with the Spotify share link. The player appears automatically |
| Add a video | Add `{ title: "...", youtube: "link" }` to `videos` |
| Add a concert | Add an entry to `shows` with the date as `"2026-12-12"`. Past dates disappear by themselves |
| Add Instagram/TikTok/etc. | Paste the link into `links` |
| Change colours | Edit `theme` (any colour code, e.g. from [htmlcolorcodes.com](https://htmlcolorcodes.com)) |
| Add photos | Upload them to `rocio-lucero/images/`, then set `heroImage` / `about.image` to `"images/name.jpg"` |
| Hide a section | Leave its list empty (`[]`) or its link empty (`""`) |
| Switch to English | Change `labels`, the texts, and set `language: "en"` |

Copy an existing entry to make a new one. The commented examples (lines starting with `//`) show the exact format.

## Preview on a computer

Double-click `index.html`. It opens in the browser, no install needed.

## Putting it online (free)

Pick one:

- **Netlify Drop**: drag the `rocio-lucero` folder onto [app.netlify.com/drop](https://app.netlify.com/drop).
- **Vercel / Netlify connected to GitHub** (recommended, so every edit goes live automatically): import this repository and set the **root directory** to `rocio-lucero`. There is no build command.
- **Custom domain** (e.g. `rociolucero.com`): buy it from any registrar and add it in the host's domain settings.

## Files

- `content.js`: all the text, links and settings ← edit this
- `index.html`, `app.js`, `styles.css`: layout and design
- `images/`: photos
