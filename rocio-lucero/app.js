/* Builds the page from content.js. You shouldn't need to edit this file. */
(function () {
  const S = window.SITE || {};
  const L = Object.assign(
    { music: "Music", videos: "Videos", shows: "Shows", about: "About", press: "Press", contact: "Contact", tickets: "Tickets", listen: "Listen" },
    S.labels || {}
  );

  // ---------- helpers ----------
  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Only allow web, mail and relative links (keeps the page safe from typos/odd pastes).
  const safeUrl = (u) => {
    u = String(u || "").trim();
    if (!u) return "";
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return "";
    return u; // relative path like images/photo.jpg
  };
  const list = (a) => (Array.isArray(a) ? a.filter(Boolean) : []);
  const ext = (href) => (/^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : "");
  const $ = (id) => document.getElementById(id);

  function spotifyEmbed(url) {
    const m = String(url || "").match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode)\/([A-Za-z0-9]+)/);
    return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0` : "";
  }
  function youtubeId(url) {
    const m = String(url || "").match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
    return m ? m[1] : "";
  }

  const SOCIAL_NAMES = {
    spotify: "Spotify", appleMusic: "Apple Music", youtube: "YouTube", instagram: "Instagram",
    tiktok: "TikTok", soundcloud: "SoundCloud", bandcamp: "Bandcamp", facebook: "Facebook",
  };
  function socialsHtml() {
    const links = S.links || {};
    return Object.keys(links)
      .map((k) => [k, safeUrl(links[k])])
      .filter(([, href]) => href)
      .map(([k, href]) => `<a class="pill" href="${esc(href)}"${ext(href)}>${esc(SOCIAL_NAMES[k] || k)}</a>`)
      .join("");
  }

  function sectionHead(title) {
    return `<h2 class="section-title">${esc(title)}</h2>`;
  }

  // ---------- theme & meta ----------
  const t = S.theme || {};
  const root = document.documentElement.style;
  if (t.accent) root.setProperty("--accent", t.accent);
  if (t.background) root.setProperty("--bg", t.background);
  if (t.text) root.setProperty("--text", t.text);
  if (S.language) document.documentElement.lang = S.language;

  document.title = S.tagline ? `${S.name} — ${S.tagline}` : S.name || "";
  const setMeta = (sel, val) => { const el = document.querySelector(sel); if (el && val) el.setAttribute("content", val); };
  setMeta('meta[name="description"]', S.description);
  setMeta('meta[property="og:title"]', S.name);
  setMeta('meta[property="og:description"]', S.description);
  setMeta('meta[property="og:image"]', safeUrl(S.heroImage));
  document.querySelectorAll("[data-site]").forEach((el) => { el.textContent = S[el.dataset.site] || ""; });
  $("year").textContent = new Date().getFullYear();

  // ---------- hero ----------
  const hero = safeUrl(S.heroImage);
  if (hero) $("heroBg").style.backgroundImage = `url("${hero.replace(/"/g, "%22")}")`;
  else $("hero").classList.add("hero--plain");

  const f = S.featured || {};
  const fLink = safeUrl(f.link);
  if (f.title || fLink) {
    $("featured").innerHTML =
      (f.label ? `<span class="featured-label">${esc(f.label)}</span>` : "") +
      (f.title ? `<span class="featured-title">${esc(f.title)}</span>` : "") +
      (fLink ? `<a class="btn" href="${esc(fLink)}"${ext(fLink)}>${esc(f.buttonText || L.listen)}</a>` : "");
  }
  $("heroSocials").innerHTML = socialsHtml();
  $("footerSocials").innerHTML = socialsHtml();

  // ---------- sections (each hides itself when empty) ----------
  const shown = [];
  function render(id, html) {
    const el = $(id);
    if (!html) { el.remove(); return; }
    el.innerHTML = html;
    shown.push(id);
  }

  // Music
  const music = list(S.music);
  render("music", music.length && sectionHead(L.music) + `<div class="grid grid-music">` + music.map((r) => {
    const embed = spotifyEmbed(r.spotify);
    const link = safeUrl(r.link) || safeUrl(r.spotify);
    const meta = [r.type, r.year].filter(Boolean).map(esc).join(" · ");
    return `<article class="card">
      ${embed ? `<iframe class="spotify" src="${esc(embed)}" height="152" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="${esc(r.title || "Spotify")}"></iframe>` : ""}
      <div class="card-body">
        <h3>${esc(r.title)}</h3>
        ${meta ? `<p class="muted">${meta}</p>` : ""}
        ${link && !embed ? `<a class="text-link" href="${esc(link)}"${ext(link)}>${esc(L.listen)} →</a>` : ""}
        ${embed && safeUrl(r.link) ? `<a class="text-link" href="${esc(safeUrl(r.link))}"${ext(r.link)}>${esc(L.listen)} →</a>` : ""}
      </div>
    </article>`;
  }).join("") + `</div>`);

  // Videos
  const videos = list(S.videos).filter((v) => youtubeId(v.youtube));
  render("videos", videos.length && sectionHead(L.videos) + `<div class="grid grid-videos">` + videos.map((v) => {
    const id = youtubeId(v.youtube);
    return `<figure class="video">
      <button class="video-thumb" data-yt="${esc(id)}" aria-label="Play ${esc(v.title || "video")}" style="background-image:url('https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg')"><span class="play"></span></button>
      ${v.title ? `<figcaption>${esc(v.title)}</figcaption>` : ""}
    </figure>`;
  }).join("") + `</div>`);
  // Load the YouTube player only when clicked (keeps the page fast).
  document.querySelectorAll(".video-thumb").forEach((b) => b.addEventListener("click", () => {
    const f = document.createElement("iframe");
    f.src = `https://www.youtube-nocookie.com/embed/${b.dataset.yt}?autoplay=1&rel=0`;
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    f.title = b.getAttribute("aria-label");
    f.className = "video-frame";
    b.replaceWith(f);
  }));

  // Shows (past dates hide automatically)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parseDate = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const upcoming = list(S.shows)
    .map((s) => Object.assign({}, s, { _d: parseDate(s.date) }))
    .filter((s) => s._d && s._d >= today)
    .sort((a, b) => a._d - b._d);
  const lang = S.language || "es";
  const hasShowsData = list(S.shows).length > 0 || S.showsEmptyText;
  render("shows", hasShowsData && sectionHead(L.shows) + (upcoming.length
    ? `<ul class="shows">` + upcoming.map((s) => {
        const tix = safeUrl(s.tickets);
        return `<li class="show">
          <div class="show-date"><span class="show-day">${s._d.getDate()}</span><span class="show-month">${esc(s._d.toLocaleDateString(lang, { month: "short" }).replace(".", ""))} ${s._d.getFullYear() !== today.getFullYear() ? s._d.getFullYear() : ""}</span></div>
          <div class="show-info"><strong>${esc(s.city)}</strong><span class="muted">${esc(s.venue)}</span></div>
          <div class="show-action">${s.note ? `<span class="muted">${esc(s.note)}</span>` : ""}${tix ? `<a class="btn btn-small" href="${esc(tix)}"${ext(tix)}>${esc(L.tickets)}</a>` : ""}</div>
        </li>`;
      }).join("") + `</ul>`
    : `<p class="muted center">${esc(S.showsEmptyText)}</p>`));

  // About
  const ab = S.about || {};
  const paras = list(ab.paragraphs);
  const abImg = safeUrl(ab.image);
  render("about", paras.length && sectionHead(L.about) + `<div class="about ${abImg ? "" : "about--noimg"}">
    ${abImg ? `<img class="about-img" src="${esc(abImg)}" alt="${esc(S.name)}" loading="lazy">` : ""}
    <div class="about-text">${paras.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
  </div>`);

  // Press
  const pr = S.press || {};
  const prLink = safeUrl(pr.downloadLink);
  render("press", prLink && sectionHead(L.press) + `<div class="center">
    ${pr.text ? `<p class="muted">${esc(pr.text)}</p>` : ""}
    <a class="btn btn-outline" href="${esc(prLink)}"${ext(prLink)}>${esc(pr.buttonText || L.press)}</a>
  </div>`);

  // Contact
  const c = S.contact || {};
  const email = String(c.email || "").trim();
  const nl = safeUrl(c.newsletterLink);
  render("contact", (email || nl) && sectionHead(c.heading || L.contact) + `<div class="center">
    ${c.text ? `<p class="muted">${esc(c.text)}</p>` : ""}
    ${email ? `<a class="contact-email" href="mailto:${esc(email)}">${esc(email)}</a>` : ""}
    ${c.managementName ? `<p class="muted">${esc(c.managementName)}</p>` : ""}
    ${nl ? `<p><a class="btn" href="${esc(nl)}"${ext(nl)}>${esc(c.newsletterText || "Newsletter")}</a></p>` : ""}
  </div>`);

  // ---------- menu (only lists sections that are visible) ----------
  const navLabels = { music: L.music, videos: L.videos, shows: L.shows, about: L.about, press: L.press, contact: L.contact };
  $("navLinks").innerHTML = shown.map((id) => `<a href="#${id}">${esc(navLabels[id])}</a>`).join("");
  const toggle = $("navToggle");
  toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", open);
  });
  $("navLinks").addEventListener("click", (e) => {
    if (e.target.tagName === "A") { document.body.classList.remove("menu-open"); toggle.setAttribute("aria-expanded", "false"); }
  });
  const onScroll = () => $("nav").classList.toggle("nav--solid", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Gentle fade-in as sections scroll into view
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { threshold: 0.1 });
    document.querySelectorAll(".section").forEach((s) => { s.classList.add("reveal"); io.observe(s); });
  }
})();
