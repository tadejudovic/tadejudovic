const $ = (s, el = document) => el.querySelector(s);
const state = { status: null, clips: [], renders: [], selected: new Set(), plans: null, planOptions: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : {},
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** Tiny element builder; children strings become text nodes (never HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/**
 * A video's address, or none once this month's bandwidth is nearly used up: the video then shows
 * its still frame (poster) instead of playing, until the month resets.
 */
function playable(url) {
  if (!state.status?.bandwidth?.paused) return url;
  if (!playable.told) {
    playable.told = true;
    banner(`Videos show as still images until the 1st: this month's free bandwidth is nearly used up (${state.status.bandwidth.usedGb} of ${state.status.bandwidth.includedGb} GB). Saving and sharing videos to post still works.`, "warn");
  }
  return undefined;
}

/** Extra features (Settings > Labs): what's switched off is hidden. */
const featureOn = (f) => !!state.status?.settings?.features?.[f];
const FEATURE_ROWS = { vlog: "sp-vlog", story: "sp-story", collab: "sp-partners", manual: "sp-manual", spares: null, retries: null, albums: null };
function applyFeatures(features) {
  const links = document.getElementById("album-links");
  if (links) links.hidden = !features.albums;
  for (const [f, page] of Object.entries(FEATURE_ROWS)) {
    const row = page && document.querySelector(`[data-open="${page}"]`);
    if (row) row.hidden = !features[f];
    const box = document.querySelector(`#labs input[name="${f}"]`);
    if (box && document.activeElement !== box) box.checked = !!features[f];
  }
  const on = Object.keys(FEATURE_ROWS).filter((f) => features[f]).length;
  const sum = document.getElementById("sum-labs");
  if (sum) sum.textContent = on ? `${on} on` : "beta features";
}
document.querySelector("#labs")?.addEventListener("change", async () => {
  const features = Object.fromEntries([...document.querySelectorAll("#labs input")].map((i) => [i.name, i.checked]));
  await api("/api/settings", { method: "PUT", body: { features } });
  await loadStatus();
});

/** Line icons (same set as the landing page). */
const ICONS = {
  muted: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
};
function icon(name) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function banner(msg, kind = "warn") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = `banner ${kind}`;
  b.hidden = !msg;
  if (msg) clearTimeout(banner.t), (banner.t = setTimeout(() => (b.hidden = true), 9000));
}

const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`);

// ---- Status ---------------------------------------------------------------

// The text looks, most used first (the box, outline, MrBeast and Hormozi looks dominate shorts).
const TEXT_STYLES = [
  ["yellowbox", "Yellow box"], ["box", "White box"], ["blackbox", "Black box"], ["classic", "Outline"],
  ["bold", "Bold caps"], ["highlight", "Highlight"], ["yellow", "Yellow"], ["plain", "Plain"],
];
/** A tile per look, each showing two words in it; picking one calls `onPick(value)`. */
function styleTiles(name, current, onPick) {
  return TEXT_STYLES.map(([value, label]) =>
    h("label", { class: "style-tile" },
      h("input", { type: "radio", name, value, checked: value === current, onchange: () => onPick(value) }),
      h("span", { class: `style-swatch look-preview ${value}` }, h("span", {}, "Fly ", h("b", { class: "kw" }, "calm"))),
      h("small", {}, label)));
}

function creatorView() {
  try { return localStorage.getItem("rollcut.creatorView") === "1"; } catch { return false; }
}
function applyAdminView() {
  const admin = state.status?.admin !== false;
  const asCreator = admin && creatorView();
  document.body.classList.toggle("admin", admin && !asCreator);
  document.querySelectorAll(".real-admin").forEach((el) => (el.hidden = !admin));
  const box = document.getElementById("view-as-admin");
  if (box) box.checked = !asCreator;
  const note = document.getElementById("view-as-note");
  if (note) note.textContent = asCreator ? "Off: you see the app the way creators do. Turn on to see everything again." : "You see everything. Turn off to see the app the way creators do.";
}
document.getElementById("view-as-admin")?.addEventListener("change", (e) => {
  try { localStorage.setItem("rollcut.creatorView", e.currentTarget.checked ? "0" : "1"); } catch {}
  applyAdminView();
});

async function loadStatus() {
  const s = (state.status = await api("/api/status"));
  $("#app-version").textContent = `Version ${s.version}`;
  const mix = s.settings.dailyMix;
  if (mix && !$("#daily-mix").contains(document.activeElement)) for (const k of ["fun", "educational", "inspirational"]) $("#daily-mix").querySelector(`[name=${k}]`).value = mix[k] ?? 0;
  renderFaq();
  renderSavedShots();
  $("#chip-google").classList.toggle("on", s.google.connected);
  $("#paused").hidden = !s.paused;
  $("#ai-credit").hidden = !s.aiOutOfCredit;
  // Admin-only pages (Labs, research, partners, spending, diagnostics) are hidden from everyone else.
  // An admin can switch to the creators' view and back (remembered on this device).
  applyAdminView();
  applyFeatures(s.settings?.features ?? {});
  $("#ai-budget").hidden = !s.claude?.enabled || !(s.spend && s.spend.usd >= s.spend.limit);
  const sp = s.spend;
  $("#spend-used").textContent = `$${sp.usd.toFixed(2)}`;
  $("#spend-limit").textContent = `$${sp.limit.toFixed(0)}`;
  // Older months were recorded before the split; count anything unlabelled as AI.
  const tiktok = sp.tiktok ?? 0;
  const ai = sp.ai ?? sp.usd - tiktok;
  $("#spend-calls").textContent = `· Claude AI $${ai.toFixed(2)} · Apify TikTok search $${tiktok.toFixed(2)}`;
  const pct = sp.limit > 0 ? Math.min(100, (sp.usd / sp.limit) * 100) : 100;
  $("#spend-bar").style.width = `${pct}%`;
  $("#spend-bar").className = pct >= 100 ? "full" : pct >= 75 ? "high" : "";
  if (document.activeElement?.form !== $("#budget-form")) $("#budget-form").aiMonthlyBudget.value = String(s.settings.aiMonthlyBudget);
  if (document.activeElement?.form !== $("#bandwidth-form")) $("#bandwidth-form").bandwidthGb.value = String(s.bandwidth?.includedGb ?? 5);
  $("#logout").hidden = !s.gate;
  $("#chip-ai").classList.toggle("on", s.claude.enabled);
  $("#chip-ai").title = s.claude.enabled ? `Using ${s.claude.model}` : "Set ANTHROPIC_API_KEY to enable";
  const form = $("#settings");
  if (document.activeElement?.form !== form) {
    form.petName.value = s.settings.petName;
    form.handle.value = s.settings.handle;
    if (document.activeElement !== form.instagramHandle) form.instagramHandle.value = s.settings.instagramHandle ? `@${s.settings.instagramHandle}` : "";
    if (document.activeElement !== form.story) form.story.value = s.settings.story ?? "";
  }
  if (document.activeElement?.form !== $("#limits")) $("#limits").maxVideosPerDay.value = String(s.settings.maxVideosPerDay);
  $("#limits").onlySituations.checked = s.settings.onlySituations !== false;
  renderSummaries();
  $("#videos-today").textContent = `${s.videosToday.made} of ${s.videosToday.limit} made today. Each day runs until you've kept one of each kind; this cap only stops a day of rejections from running up costs.`;
  const btn = $("#btn-google");
  // The picker needs Google Cloud credentials; the album link doesn't, so only show the picker when it's set up.
  $("#picker-box").hidden = !s.google.configured;
  btn.textContent = s.google.connected ? "Pick from Google Photos" : "Connect Google Photos";
  $("#google-hint").textContent = s.settings?.features?.albums ? "New videos you add to a shared album are picked up automatically every few hours." : "";
  const tpl = $("#templates");
  if (!tpl.children.length) {
    s.templates.forEach((t, i) =>
      tpl.append(h("label", { class: "tpl" }, h("input", { type: "radio", name: "template", value: t.id, checked: i === 0 }), h("b", {}, t.name), h("span", {}, t.description))),
    );
  }
  const autoTpl = $("#auto-template");
  if (!autoTpl.children.length) autoTpl.append(...s.templates.map((t) => h("option", { value: t.id }, t.name)));
  const music = $("#music");
  const current = music.value;
  music.replaceChildren(music.options[0], ...s.music.map((m) => h("option", { value: m.id }, m.name)));
  music.value = current;
  $("input[name=useAi]").disabled = !s.claude.enabled;
  if (!s.claude.enabled) $("input[name=useAi]").checked = false;
}

$("#settings").addEventListener("change", async (e) => {
  const f = e.currentTarget;
  state.status.settings = await api("/api/settings", { method: "PUT", body: { petName: f.petName.value, handle: f.handle.value, instagramHandle: f.instagramHandle.value, story: f.story.value } });
  renderSummaries();
});
$("#settings").addEventListener("submit", (e) => e.preventDefault());
$("#limits").addEventListener("change", async (e) => {
  const f = e.currentTarget;
  state.status.settings = await api("/api/settings", { method: "PUT", body: { maxVideosPerDay: Number(f.maxVideosPerDay.value), onlySituations: f.onlySituations.checked } });
  renderSummaries();
});
$("#limits").addEventListener("submit", (e) => e.preventDefault());

// ---- Settings: grouped rows that open sub-pages ---------------------------------

function openSubpage(id) {
  const page = document.getElementById(id);
  if (!page) return;
  page.hidden = false;
  page.scrollTop = 0;
  document.body.classList.add("no-scroll");
  if (id === "sp-vlog") loadVlogDays();
  if (id === "sp-search") loadSearchTopics(), refreshSoundsList();
}

// ---- What people search (TikTok search analytics → educational topics) -----------------

const THEME_LABEL = { airline: "Flights", destination: "Trips", prep: "Tricks", airport: "Tricks", gear: "Tricks" };

async function loadSearchTopics() {
  const { topics, at, googleAt, audience } = await api("/api/search-demand");
  $("#audience-at").textContent = audience
    ? `Read ${new Date(audience.at).toLocaleDateString()}: ${audience.posts} posts from the last ${audience.days} days, ${audience.questions} questions from ${audience.commentsRead} comments. Refreshed weekly.`
    : "Not read yet.";
  const when = (d) => new Date(d).toLocaleDateString();
  $("#search-at").textContent = at || googleAt
    ? [at && `TikTok: added ${when(at)}`, googleAt && `Google: added ${when(googleAt)}`].filter(Boolean).join(" · ")
    : "No export added yet.";
  const box = $("#search-topics");
  box.replaceChildren(
    ...Object.entries(THEME_LABEL).map(([k, label]) => {
      const mine = topics.filter((t) => t.pillar === k);
      if (!mine.length) return "";
      return h(
        "div",
        { class: "search-theme" },
        h("h3", { class: "theme-h" }, label),
        ...mine.map((t) =>
          h(
            "div",
            { class: "search-topic" + (t.used ? " used" : "") },
            h("b", {}, t.topic),
            h(
              "span",
              { class: "muted" },
              `${t.source === "google" ? `Google · ${t.impressions.toLocaleString()}/month` : t.source === "suggest" ? "Google & YouTube search suggestions" : t.source === "comments" ? `Your comments · ${t.queries.length} question${t.queries.length === 1 ? "" : "s"}` : `TikTok · ${t.impressions.toLocaleString()} seen`}` +
                `${t.used ? " · covered" : ""} · ${t.queries.slice(0, 3).join(", ")}`,
            ),
          ),
        ),
      );
    }),
  );
}

$("#audience-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  withBusy(f.querySelector("button"), "Reading… (a few minutes)", async () => {
    const r = await api("/api/audience/learn", { method: "POST", body: { days: Number(f.days.value) || 90 } });
    toast(`${r.posts} posts read: ${r.questions} questions, ${r.topics} topics`, "check");
    loadSearchTopics();
  });
});

$("#search-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const label = $("#search-upload-label");
  label.classList.add("busy");
  label.firstChild.textContent = "Sorting the searches…";
  try {
    const fd = new FormData();
    fd.append("file", file);
    const { topics, source } = await api("/api/search-demand", { method: "POST", body: fd });
    toast(`${topics.length} ${source === "google" ? "Google" : "TikTok"} search topics added`, "check");
    loadSearchTopics();
  } catch (err) {
    toast(err.message || "Couldn't read that file");
  } finally {
    label.classList.remove("busy");
    label.firstChild.textContent = "Add an export";
    e.target.value = "";
  }
});

// ---- Posts that worked well (by link) ---------------------------------------------------

$("#winners-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  withBusy(f.querySelector("button"), "Reading…", async () => {
    const out = await api("/api/posts/winners", { method: "POST", body: { urls: f.urls.value.split(/\s+/).filter(Boolean) } });
    const linked = out.filter((o) => o.matched).length;
    toast(`${out.length} post${out.length === 1 ? "" : "s"} read: ${linked} linked to their video${out.length - linked ? `, ${out.length - linked} kept as examples` : ""}`, "check");
    f.urls.value = "";
    refreshRenders();
  });
});

// ---- Scan everything since a date --------------------------------------------------------

{
  const f = $("#scan-form");
  f.since.value = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = f.querySelector("button");
    withBusy(btn, "Scanning…", async () => {
      const r = await api("/api/albums/scan", { method: "POST", body: { since: `${f.since.value}T00:00:00` } });
      toast(r.newItems ? `${r.newItems} video${r.newItems === 1 ? "" : "s"} to import${r.relooked ? `, ${r.relooked} clips get another AI look` : ""}` : "Everything since then is already in", "download");
      refreshClips();
    });
  });
}

// ---- Day vlog: one day's clips, in the order filmed (only on request) -------------------

async function loadVlogDays() {
  const box = $("#vlog-days");
  box.replaceChildren(h("p", { class: "muted" }, "Looking for days…"));
  const { days, made } = await api("/api/vlog/days");
  if (!days.length) return box.replaceChildren(h("p", { class: "muted" }, "No day has 15 or more vertical clips yet. A day vlog needs the whole day in quick moments."));
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  box.replaceChildren(
    ...days.map((d) => {
      const btn = h("button", { class: "btn small" + (made.includes(d.day) ? "" : " primary"), type: "button" }, "See clips");
      const panel = h("div", { class: "vlog-panel", hidden: true });
      btn.onclick = async () => {
        if (!panel.hidden) return void (panel.hidden = true);
        panel.hidden = false;
        panel.replaceChildren(h("p", { class: "muted" }, "Loading the day's clips…"));
        try {
          const clips = await api(`/api/vlog/day/${d.day}`);
          renderVlogClips(panel, d.day, clips, () => {
            btn.textContent = "Being made";
            panel.hidden = true;
          });
        } catch (err) {
          panel.replaceChildren(h("p", { class: "vlog-error" }, err.message || "Couldn't load the clips."));
        }
      };
      return h(
        "div",
        { class: "vlog-day" },
        h("div", { class: "vlog-thumbs" }, ...d.thumbs.map((id) => h("img", { src: `/media/thumb/${id}`, alt: "", loading: "lazy" }))),
        h(
          "div",
          { class: "vlog-meta" },
          h("b", {}, fmt(d.day)),
          h("span", { class: "muted" }, [`${d.clips} clips · ${d.minutes || "<1"} min`, ...d.places].join(" · ")),
        ),
        btn,
        panel,
      );
    }),
  );
}

/**
 * All of a day's clips, in the order filmed, each playable and in the vlog unless switched off.
 * "Make vlog" has the AI pick the best part of each kept clip and write the text.
 */
function renderVlogClips(panel, day, clips, onMade) {
  const use = new Set(clips.map((c) => c.id));
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const make = h("button", { class: "btn primary", type: "button" });
  const count = () => (make.textContent = `Make vlog from ${use.size} clip${use.size === 1 ? "" : "s"}`);
  count();
  make.onclick = (e) =>
    withBusy(e.currentTarget, "Making… (a minute or two)", async () => {
      try {
        await api("/api/vlog", { method: "POST", body: { day, clipIds: [...use] } });
        toast("Vlog is being made. It'll appear in Review.", "check");
        refreshRenders();
        onMade();
      } catch (err) {
        panel.append(h("p", { class: "vlog-error" }, err.message || "Couldn't make the vlog."));
      }
    });
  panel.replaceChildren(
    h("p", { class: "muted" }, `All ${clips.length} clips from this day, in the order filmed. Play any of them; switch off the ones you don't want.`),
    ...clips.map((c) => {
      const row = h("div", { class: "vlog-moment" },
        h("video", { src: playable(`/media/clip/${c.id}`), poster: `/media/thumb/${c.id}`, controls: true, playsinline: true, preload: "none" }),
        h("div", { class: "vlog-moment-side" },
          h("b", {}, [time(c.filmed), `${c.duration.toFixed(0)}s`].filter(Boolean).join(" · ")),
          c.summary ? h("span", { class: "muted" }, c.summary.slice(0, 140)) : null,
          h("label", { class: "check" },
            h("input", { type: "checkbox", checked: true, onchange: (e) => { e.target.checked ? use.add(c.id) : use.delete(c.id); row.classList.toggle("off", !e.target.checked); count(); } }),
            " Use it"),
        ),
      );
      return row;
    }),
    make,
  );
}

/**
 * A day vlog before it's made: each suggested moment plays on its own, with its line of text and
 * whether to use it; the day's other clips can be added. Then it's made from what's left.
 */
function renderVlogProposal(panel, p, onMade) {
  const draw = () => {
    const fmt = (t) => `${t.toFixed(1)}s`;
    const hook = h("input", { class: "vlog-hook", value: p.hook, maxlength: 120, oninput: (e) => (p.hook = e.target.value) });
    panel.replaceChildren(
      h("label", { class: "vlog-label" }, "Headline", hook),
      h("p", { class: "muted" }, "Play each moment, switch off the ones you don't want, and change the words if you like."),
      ...p.moments.map((m) =>
        h("div", { class: `vlog-moment${m.use ? "" : " off"}` },
          h("video", { src: playable(`/media/clip/${m.clipId}#t=${m.start.toFixed(1)},${m.end.toFixed(1)}`), poster: `/media/thumb/${m.clipId}`, controls: true, playsinline: true, preload: "none" }),
          h("div", { class: "vlog-moment-side" },
            h("span", { class: "muted" }, `${fmt(m.start)}–${fmt(m.end)}`),
            h("input", { value: m.text, maxlength: 80, placeholder: "Line for this moment", oninput: (e) => (m.text = e.target.value) }),
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: m.use, onchange: (e) => { m.use = e.target.checked; draw(); } }), " Use it"),
          ),
        ),
      ),
      p.others.length
        ? h("div", { class: "vlog-others" },
            h("p", { class: "muted" }, "More from this day: tap one to add it"),
            h("div", { class: "vlog-thumbs-row" },
              ...p.others.map((o) =>
                h("img", {
                  src: `/media/thumb/${o.clipId}`, alt: "", loading: "lazy", title: "Add this clip",
                  onclick: () => {
                    p.moments.push({ clipId: o.clipId, start: 0, end: Math.min(4, o.duration), text: "", use: true });
                    p.others = p.others.filter((x) => x.clipId !== o.clipId);
                    draw();
                  },
                }),
              ),
            ),
          )
        : null,
      h("button", {
        class: "btn primary", type: "button",
        onclick: (e) => withBusy(e.currentTarget, "Making…", async () => {
          await api("/api/vlog", { method: "POST", body: { day: p.day, proposal: p } });
          toast("Vlog is being made. It'll appear in Review.", "check");
          refreshRenders();
          onMade();
        }),
      }, `Make vlog (${p.moments.filter((m) => m.use).length} moments)`),
    );
  };
  draw();
}
function closeSubpages() {
  for (const p of document.querySelectorAll(".subpage")) p.hidden = true;
  document.body.classList.remove("no-scroll");
  renderSummaries();
}
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return openSubpage(open.dataset.open);
  if (e.target.closest(".sp-back")) closeSubpages();
});

/** The short value shown on the right of each settings row. */
function renderSummaries() {
  const s = state.status;
  if (!s) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const searchN = (s.settings?.searchTopics?.length ?? 0) + (s.settings?.keywordTopics?.length ?? 0);
  set("sum-search", searchN ? `${searchN} topics` : "add export");
  const n = state.albumCount ?? 0;
  set("sum-album", n ? `${n} album${n === 1 ? "" : "s"}` : "Not connected");
  const ready = state.clips.filter((c) => c.status === "ready").length;
  set("sum-clips", `${ready} clip${ready === 1 ? "" : "s"}`);
  const a = state.auto;
  set("sum-videos", a ? `${a.enabled ? `${a.dailyCount} per round` : "Off"} · max ${s.settings.maxVideosPerDay}/day` : "");
  const size = { small: "Small", medium: "Medium", large: "Large" }[s.settings.textSize] ?? "Medium";
  const style = Object.fromEntries(TEXT_STYLES)[s.settings.textStyle] ?? "";
  set("sum-look", `${style} · ${size}`);
  set("sum-scenes", s.tiktokSearch ? `${s.settings.scenes.length} situations` : "Apify not connected");
  set("sum-profile", s.settings.handle || s.settings.petName || "");
  set("sum-spend", `$${s.spend.usd.toFixed(2)} of $${s.spend.limit.toFixed(0)}`);
  if (s.bandwidth) {
    set("bw-used", `${s.bandwidth.usedGb} GB`);
    set("bw-included", `${s.bandwidth.includedGb} GB`);
    const bar = document.getElementById("bw-bar");
    if (bar) bar.style.width = `${Math.min(100, (s.bandwidth.usedGb / s.bandwidth.includedGb) * 100)}%`;
  }
  set("sum-user", s.user ?? "");
  const plan = s.settings?.billing;
  const planRow = document.getElementById("plan-row");
  if (planRow) planRow.hidden = !plan;
  if (plan) set("sum-plan", `Free trial until ${new Date(plan.trialEndsAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${plan.card.brand} •••• ${plan.card.last4}${plan.test ? " (test)" : ""}`);
}

// ---- Google Photos picker ---------------------------------------------------

$("#btn-google").addEventListener("click", async () => {
  const s = state.status;
  if (!s.google.configured) return banner("Google isn't set up on the server yet.");
  if (!s.google.connected) return (location.href = "/auth/google");
  const btn = $("#btn-google");
  // Phones: the picker opens in a tab of its own (or the Google Photos app) and stays open until you
  // tap Done; "/autoclose" there could close it as soon as it handed over to the app.
  const phone = matchMedia("(pointer: coarse)").matches;
  // Open the window synchronously so popup blockers allow it.
  const win = window.open("", "gphotos-picker", phone ? "" : "width=1100,height=800");
  try {
    btn.disabled = true;
    btn.textContent = "Waiting for your picks…";
    const session = await api("/api/google/picker", { method: "POST" });
    const url = phone ? session.pickerUri : `${session.pickerUri}/autoclose`;
    if (win) win.location.href = url;
    else window.open(url, "_blank");
    if (phone) banner("Pick your videos in Google Photos, tap Done, then come back to this tab.", "ok");
    const interval = Math.max(2000, parseFloat(session.pollInterval || "3") * 1000);
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const r = await api(`/api/google/picker/${encodeURIComponent(session.id)}`);
      if (r.done) {
        banner(`${r.imported} new item${r.imported === 1 ? "" : "s"} downloading now${r.picked - r.imported ? ` (${r.picked - r.imported} already in your clips)` : ""}. They appear in Clips as they're sorted.`, "ok");
        refreshClips();
        return;
      }
    }
    banner("Still waiting for your picks. If you already tapped Done, they're being imported in the background: check Clips in a minute.");
  } catch (err) {
    win?.close();
    banner(err.message);
  } finally {
    btn.disabled = false;
    loadStatus();
  }
});

// ---- Uploads ----------------------------------------------------------------

async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) {
    fd.append("files", f);
    fd.append("lastModified", String(f.lastModified || ""));
  }
  banner(`Uploading ${files.length} file(s)…`, "ok");
  try {
    await api("/api/clips/upload", { method: "POST", body: fd });
    banner(`Uploaded ${files.length} file(s). Analyzing…`, "ok");
  } catch (err) {
    banner(err.message);
  }
  refreshClips();
}
$("#file-input").addEventListener("change", (e) => uploadFiles([...e.target.files]).then(() => (e.target.value = "")));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  uploadFiles([...e.dataTransfer.files].filter((f) => /^(video|image)\//.test(f.type)));
});

$("#music-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  const { id } = await api("/api/music", { method: "POST", body: fd });
  await loadStatus();
  $("#music").value = id;
  e.target.value = "";
});

// ---- Library ----------------------------------------------------------------

async function refreshClips() {
  state.clips = await api("/api/clips");
  renderSummaries();
  for (const id of state.selected) if (!state.clips.some((c) => c.id === id)) state.selected.delete(id);
  renderClips();
}

function energyBars(curve = []) {
  const n = 28;
  const bins = Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * curve.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * curve.length) / n));
    return Math.max(0, ...curve.slice(a, b));
  });
  return h("div", { class: "energy", title: "Motion + sound energy" }, bins.map((v) => h("i", { style: { height: `${Math.max(4, v * 100)}%` } })));
}

function clipSort() {
  try {
    return localStorage.getItem("clipSort") || "filmed";
  } catch {
    return "filmed";
  }
}
{
  const sel = document.querySelector("#clip-sort");
  if (sel) {
    sel.value = clipSort();
    sel.addEventListener("change", () => {
      try {
        localStorage.setItem("clipSort", sel.value);
      } catch {}
      renderClips();
    });
  }
}

function renderClips() {
  // Don't rebuild the grid while the creator is typing a note.
  if (document.activeElement?.classList.contains("note")) return;
  const el = $("#clips");
  $("#clips-empty").hidden = state.clips.length > 0;
  // Clips that are never used automatically (off-topic, already edited, duplicates, landscape) fold
  // away at the bottom; their files are removed after 7 days.
  const st = state.status?.settings;
  const strict = st?.onlySituations && state.status?.claude?.enabled;
  const notUsed = (c) =>
    c.status === "ready" && !c.uses &&
    (c.width > c.height || c.edited || c.duplicateOf || (c.kind === "video" && c.duration < 3) || (strict && c.scene && !st.scenes.includes(c.scene)));
  // Sorted by when the video was filmed (Google Photos' date), or when it was added; clips whose
  // filming date isn't known go last when sorting by filming date.
  const sort = clipSort();
  const key = (c) => (sort === "added" ? c.importedAt ?? "" : c.capturedAt ?? "");
  const sorted = [...state.clips].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (!ka !== !kb) return ka ? -1 : 1;
    return sort === "filmed-old" ? ka.localeCompare(kb) : kb.localeCompare(ka);
  });
  // Downloads that failed fold away too: they're retried on their own, and aren't clips to pick from.
  const failed = sorted.filter((c) => c.status === "error");
  const main = sorted.filter((c) => c.status !== "error" && !notUsed(c));
  const parked = sorted.filter((c) => c.status !== "error" && notUsed(c));
  const card = (c) => {
      const tags = c.ai?.tags?.slice(0, 3) ?? [];
      const landscape = c.status === "ready" && c.width > c.height;
      const badge =
        c.status === "ready"
          ? landscape ? "landscape · not used" : c.kind === "photo" ? "photo" : null
          : c.status === "error" ? "error" : `${c.status}…`;
      return h(
        "div",
        {
          class: `clip ${landscape ? "landscape" : ""} ${c.status === "error" ? "failed" : ""}`,
          "data-clip": c.id,
          title: c.error || c.ai?.summary || c.filename,
        },
        c.status === "ready"
          ? h("div", { class: "thumb-wrap", title: "Play", onclick: (e) => playClip(e.currentTarget.closest(".clip"), c.id) },
              h("img", { class: "thumb", src: `/media/thumb/${c.id}`, loading: "lazy", alt: "" }))
          : h("div", { class: "thumb" }),
        badge && h("span", { class: `badge ${c.status === "error" ? "err" : ""}` }, badge),
        h("button", {
          class: "del", title: "Remove from library",
          onclick: async (e) => {
            e.stopPropagation();
            await api(`/api/clips/${c.id}`, { method: "DELETE" });
            refreshClips();
          },
        }, "×"),
        h("div", { class: "meta" },
          h("div", { class: "name" }, c.filename),
          h("div", { class: "sub" },
            h("span", {}, c.duration ? fmt(c.duration) : "–"),
            h("span", { title: c.capturedAt ? "Filmed (Google Photos date)" : "Filming date unknown" }, c.capturedAt ? new Date(c.capturedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "date unknown"),
            c.status === "ready" && !landscape
              ? c.duplicateOf
                ? h("span", { class: "use", title: "The same video is already in your library from another album" }, "duplicate")
                : c.edited
                ? h("span", { class: "use", title: "Already has text on it, so it isn't used automatically" }, "already edited")
                : h("span", { class: `use ${c.uses ? "" : "fresh"}` }, c.uses ? `used ${c.uses}×` : "not used yet")
              : null,
          ),
          c.energy?.length ? energyBars(c.energy) : null,
          tags.length ? h("div", { class: "tags" }, tags.map((t) => h("span", { class: "tag" }, t))) : null,
          c.status === "error" && c.error ? h("div", { class: "clip-err" }, c.error) : null,
          landscape || c.status !== "ready" ? null : h("select", {
            class: "scene-select note",
            title: "Situation",
            onclick: (e) => e.stopPropagation(),
            onchange: async (e) => {
              c.scene = e.target.value;
              await api(`/api/clips/${c.id}`, { method: "PATCH", body: { scene: e.target.value } });
              refreshScenes();
            },
          },
            h("option", { value: "", selected: !c.scene }, "— situation —"),
            ...(state.status?.settings.scenes ?? []).map((sc) => h("option", { value: sc, selected: c.scene === sc }, sc)),
            h("option", { value: "other", selected: c.scene === "other" }, "other"),
          ),
          landscape || c.status !== "ready" ? null : h("label", {
            class: "muted edited-toggle",
            title: "Videos that already have text or stickers on them are never used automatically",
            onclick: (e) => e.stopPropagation(),
          },
            h("input", {
              type: "checkbox",
              checked: !!c.edited,
              onchange: async (e) => {
                c.edited = e.target.checked;
                await api(`/api/clips/${c.id}`, { method: "PATCH", body: { edited: e.target.checked } });
                refreshClips();
              },
            }),
            " Has text already, don't use",
          ),
          landscape || c.status !== "ready" ? null : h("button", {
            class: "btn small make",
            title: "Make a video from this clip now; it appears under Create for review",
            onclick: (e) => {
              e.stopPropagation();
              makeFromClip(e.currentTarget, c.id);
            },
          }, "Make video"),
          landscape ? null : h("input", {
            class: "note",
            value: c.note || "",
            placeholder: "What's happening? (optional)",
            title: "Tell the AI what's on this footage, e.g. 'first time at the airport, very excited'",
            onclick: (e) => e.stopPropagation(),
            onchange: async (e) => {
              c.note = e.target.value;
              await api(`/api/clips/${c.id}`, { method: "PATCH", body: { note: e.target.value } });
            },
          }),
        ),
      );
  };
  el.replaceChildren(...[
    ...main.map(card),
    parked.length
      ? h("details", { class: "not-used", open: state.notUsedOpen, ontoggle: (e) => (state.notUsedOpen = e.currentTarget.open) },
          h("summary", {}, `Not used (${parked.length})`,
            h("span", { class: "muted" }, " · not from your situations, already edited, duplicates or landscape. Their files are deleted after 7 days; set a situation to keep one.")),
          h("div", { class: "clips" }, ...parked.map(card)))
      : null,
    failed.length
      ? h("details", { class: "not-used failed-clips", open: state.failedOpen, ontoggle: (e) => (state.failedOpen = e.currentTarget.open) },
          h("summary", {}, `Couldn't download (${failed.length})`,
            h("span", { class: "muted" }, " · Google wouldn't hand these videos over. Each is tried again on later album checks (up to 3 times).")),
          h("div", { class: "clips" }, ...failed.map(card)))
      : null,
  ].filter(Boolean));
  const n = state.selected.size;
  $("#selection-hint").textContent = state.clips.length
    ? n ? `${n} clip${n === 1 ? "" : "s"} selected — videos will only use these. Click again to deselect.` : "Click clips to restrict generation to them; otherwise the whole library is used."
    : "";
}

// ---- Create -----------------------------------------------------------------

function readForm() {
  const f = $("#create");
  return {
    template: f.template.value,
    targetSeconds: Number(f.targetSeconds.value),
    count: Number(f.count.value),
    brief: f.brief.value.trim() || undefined,
    useAi: f.useAi.checked,
    clipIds: state.selected.size ? [...state.selected] : undefined,
    options: {
      keepOriginalAudio: f.keepOriginalAudio.checked,
      musicId: f.musicId.value || undefined,
    },
  };
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (err) {
    banner(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$("#create").addEventListener("submit", (e) => {
  e.preventDefault();
  const btn = e.submitter || $("#create button[type=submit]");
  withBusy(btn, readForm().useAi ? "Directing…" : "Planning…", async () => {
    const r = await api("/api/generate", { method: "POST", body: readForm() });
    if (r.warning) banner(r.warning);
    $("#plans").hidden = true;
    await refreshRenders();
    showTab("review");
  });
});

$("#btn-plan").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Planning…", async () => {
    const req = readForm();
    const r = await api("/api/plan", { method: "POST", body: req });
    if (r.warning) banner(r.warning);
    state.plans = r.plans;
    state.planOptions = req.options;
    renderPlans();
  }),
);

function renderPlans() {
  const el = $("#plans");
  el.hidden = false;
  el.replaceChildren(
    ...state.plans.map((p, i) => {
      const total = p.segments.reduce((a, s) => a + (s.end - s.start) / (s.speed || 1), 0);
      return h("div", { class: "plan" },
        h("div", { class: "plan-head" },
          h("b", {}, `Video ${i + 1}: ${p.title}`),
          h("span", { class: "by" }, `${fmt(total)} · ${p.segments.length} cuts · ${p.plannedBy === "claude" ? "AI director" : "heuristic"}`),
        ),
        p.concept ? h("div", { class: "concept" }, p.concept) : null,
        basedOnLine(p),
        p.overlays?.length
          ? p.overlays.map((o, j) => h("input", { class: "hook", value: o.text, title: `On screen ${o.start.toFixed(1)}s →`, oninput: (e) => ((o.text = e.target.value), j === 0 && (p.hook = e.target.value)) }))
          : h("input", { class: "hook", value: p.hook, placeholder: "Hook text", oninput: (e) => (p.hook = e.target.value) }),
        h("div", { class: "segs" },
          p.segments.map((s) =>
            h("div", { class: "segcard" },
              h("img", { src: `/media/thumb/${s.clipId}`, alt: "", loading: "lazy" }),
              h("div", {}, `${s.start.toFixed(1)}–${s.end.toFixed(1)}s${s.speed && s.speed !== 1 ? ` @${s.speed}x` : ""}`),
              h("input", { value: s.caption || "", placeholder: "caption", oninput: (e) => (s.caption = e.target.value) }),
            ),
          ),
        ),
        h("textarea", { oninput: (e) => (p.postCaption = e.target.value) }, p.postCaption),
        h("div", { class: "by" }, p.hashtags.map((t) => `#${t}`).join(" ")),
      );
    }),
    h("div", { class: "actions end" },
      h("button", { class: "btn", onclick: () => ((el.hidden = true), (state.plans = null)) }, "Discard"),
      h("button", {
        class: "btn primary",
        onclick: (e) =>
          withBusy(e.currentTarget, "Queuing…", async () => {
            await api("/api/render", { method: "POST", body: { plans: state.plans, options: state.planOptions } });
            el.hidden = true;
            await refreshRenders();
            showTab("review");
          }),
      }, `Render ${state.plans.length} video${state.plans.length === 1 ? "" : "s"}`),
    ),
  );
}

// ---- Renders ----------------------------------------------------------------

async function refreshRenders() {
  state.renders = await api("/api/renders");
  renderRenders();
  renderBatch();
  renderHomeState();
  renderStack();
}

// ---- Swipe review -------------------------------------------------------------
// The Videos page is a stack, dating-app style: swipe right (or →, ✓) keeps a video,
// left (←, ✕) rejects it. At first you only see the video; tap it for the details
// (text, caption, hashtags, source). Every decision is fed back to the AI director.

const REASON_LABEL = { text: "the text", clip: "the clip", edit: "the cut", other: "" };
const stack = { shownId: null, node: null, history: [], whyFor: null };

// Spares are made in the background and kept out of sight until they step in.
const inProgress = (r) => !r.standby && (r.status === "queued" || r.status === "rendering");

function toReview() {
  return state.renders.filter((r) => r.status === "done" && r.review === "pending" && !r.standby).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Why there's nothing to make a round from, in plain numbers. */
function outOfClipsText(strict, st) {
  const ready = state.clips.filter((c) => c.status === "ready" && c.kind === "video");
  const inSituations = (c) => !strict || (c.scene && st.scenes.includes(c.scene));
  const used = ready.filter((c) => inSituations(c) && c.uses > 0).length;
  const other = ready.filter((c) => strict && c.scene && !st.scenes.includes(c.scene)).length;
  const skipped = ready.filter((c) => c.edited || c.duplicateOf || c.width > c.height || c.disliked).length;
  const waiting = (state.albums ?? []).reduce((n, a) => n + (a.waiting ?? 0), 0);
  const tooOld = (state.albums ?? []).reduce((n, a) => n + (a.tooOld ?? 0), 0);
  const parts = [];
  if (used) parts.push(`All ${used} clips from your situations are already in videos.`);
  else parts.push("No unused clips from your situations right now.");
  if (other || skipped) parts.push(`${[other && `${other} are from other moments`, skipped && `${skipped} are edited, duplicates, landscape or rejected`].filter(Boolean).join(", ")}.`);
  parts.push(
    waiting
      ? `${waiting} more are waiting in your albums and are being imported (up to 150 a day)${state.albums?.[0]?.importPaused ? `, on hold: ${state.albums[0].importPaused}` : ""}.`
      : tooOld
        ? `Older videos from your albums (${tooOld} outside the date range) are being brought in now, newest first.`
        : "New videos in your albums are picked up every few hours.",
  );
  return parts.join(" ");
}

/** "Today: ✓ Fun · Educational · Inspirational": which kinds of post were picked today. */
function renderTodayBar() {
  const mix = state.status?.settings?.dailyMix;
  const kinds = mix ? [["fun", mix.fun], ["tips", mix.educational], ["inspire", mix.inspirational]].filter(([, n]) => n > 0).map(([k]) => k) : [];
  const today = new Date().toDateString();
  const picked = new Set(
    state.renders.filter((r) => r.review === "approved" && r.reviewedAt && new Date(r.reviewedAt).toDateString() === today).map((r) => r.plan.format),
  );
  $("#today-bar").hidden = !kinds.length;
  $("#today-bar").replaceChildren(
    h("span", { class: "muted" }, "Today"),
    ...kinds.map((k) => h("span", { class: `slot ${picked.has(k) ? "done" : ""}` }, picked.has(k) ? `✓ ${KIND_LABEL[k]}` : KIND_LABEL[k])),
  );
}

function renderStack() {
  renderTodayBar();
  const queue = toReview();
  $("#stack").hidden = !queue.length && !stack.whyFor;
  $("#stack-undo").hidden = !stack.history.length;
  // A rejection needs its reason before the next video shows.
  const r = stack.whyFor ? null : queue.find((x) => x.id === stack.shownId) ?? queue[0];
  $(".stack-actions").hidden = !r;
  $("#stack-why").hidden = !stack.whyFor;
  const actions = $(".stack-actions");
  if (!r) {
    stack.shownId = null;
    $("#stack").append(actions); // park the buttons outside the card that's going away
    $("#stack-stage").replaceChildren();
    return;
  }
  // Keep the card (and its playing video / open details) across background refreshes.
  if (r.id === stack.shownId && stack.node?.isConnected) return;
  stack.shownId = r.id;
  $("#stack").append(actions);
  stack.node = stackCard(r);
  // The Reject / Post buttons float over the bottom of the video.
  stack.node.querySelector(".stack-media").append(actions);
  prefetchFile(r);
  $("#stack-stage").replaceChildren(stack.node);
}

function stackCard(r) {
  const video = h("video", { src: playable(`/media/render/${r.id}.mp4`), poster: `/media/render/${r.id}.jpg`, autoplay: true, muted: true, loop: true, playsinline: true });
  video.muted = true;
  const sound = h("button", { class: "stack-sound", "aria-label": "Sound", onclick: (e) => { video.muted = !video.muted; e.currentTarget.innerHTML = icon(video.muted ? "muted" : "sound"); } });
  sound.innerHTML = icon("muted");
  const card = h("div", { class: "stack-card" },
    h("div", { class: "stack-media" }, video, sound,
      h("span", { class: "stamp keep" }, "POST"),
      h("span", { class: "stamp nope" }, "NOPE"),
      h("span", { class: "stack-tap" }, "Tap for details"),
      r.plan.collab || KIND_LABEL[r.plan.format]
        ? h("span", { class: "collab-badge on-video" }, r.plan.collab ? `Collab · ${r.plan.collab.name}` : KIND_LABEL[r.plan.format])
        : null,
    ),
  );
  // Tap opens the details full screen (like a Tinder profile); swiping still decides.
  dragToSwipe(card, card.querySelector(".stack-media"), decide, () => openDetails(r, video.muted));
  return card;
}

/** Full-screen details for the video under review: player on top, everything else scrolls below, decide at the bottom. */
function openDetails(r, muted = true) {
  const sheet = $("#sheet");
  const video = h("video", { src: playable(`/media/render/${r.id}.mp4`), poster: `/media/render/${r.id}.jpg`, autoplay: true, loop: true, playsinline: true, controls: true });
  video.muted = muted;
  stack.node?.querySelector("video")?.pause();
  const close = () => {
    closeSheet();
    stack.node?.querySelector("video")?.play().catch(() => {});
  };
  const choose = (dir) => {
    closeSheet();
    decide(dir);
  };
  const iconButton = (cls, label, path, onclick) => {
    const b = h("button", { class: cls, "aria-label": label, onclick });
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    return b;
  };
  sheet.replaceChildren(
    h("div", { class: "details-view" },
      iconButton("details-close", "Back to swiping", "M6 9l6 6 6-6", close),
      h("div", { class: "details-media" }, video),
      h("div", { class: "details-body" }, detailsBody(r)),
      h("div", { class: "details-actions" },
        iconButton("round no", "Reject", "M6 6l12 12M18 6L6 18", () => choose("left")),
        iconButton("round yes", "Post", "M4.5 12.5l5 5L19.5 7", () => choose("right")),
      ),
    ),
  );
  sheet.classList.add("full");
  sheet.hidden = false;
  sheet.scrollTop = 0;
  document.body.classList.add("no-scroll");
}

/** Everything about a video except the player: made from, text on video, caption, hashtags. */
const KIND_LABEL = { fun: "Fun", tips: "Educational", inspire: "Inspirational", story: "Story" };

function detailsBody(r) {
  const plan = r.plan;
  // One line per overlay (" / " inside an overlay is its own line break, so it can't be the separator).
  const overlay = plan.overlays?.length ? plan.overlays.map((o) => o.text).join("\n") : plan.hook || plan.title;
  const caption = plan.postCaption || "";
  const tags = plan.hashtags ?? [];
  const posts = new Map((plan.hashtagInfo ?? []).map((t) => [t.tag, t.posts]));
  const fullCaption = () => [plan.postCaption, plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");

  // Headline: the text on the video, editable in place (re-makes the video).
  // Shown as the viewer reads it: a list that builds up on screen appears once (its last, full
  // state), and " / " is a line break.
  const texts = plan.overlays?.length ? plan.overlays.map((o) => o.text) : [plan.hook || plan.title];
  const screens = texts.filter((t, i) => !(texts[i + 1] && texts[i + 1].startsWith(t)));
  const headline = h("h2", { class: "d-title" },
    ...screens.map((t) => h("div", { class: "d-screen" }, ...t.split(" / ").flatMap((line, i) => (i ? [h("br"), line] : [line])))));
  const editText = h("div", { class: "d-edit", hidden: true });
  const textInput = h("textarea", { rows: 2 }, overlay);
  textInput.rows = Math.min(8, Math.max(2, (plan.overlays?.length ?? 1) + 1));
  editText.append(
    textInput,
    h("p", { class: "muted d-edit-hint" }, "One line per piece of text. The first line stays at the top; the others appear one after another in different spots. Add or remove lines and the video gets longer or shorter to fit."),
    h("div", { class: "d-edit-actions" },
      h("button", { class: "btn small", onclick: () => (editText.hidden = true) }, "Cancel"),
      h("button", { class: "btn small primary", onclick: (e) => withBusy(e.currentTarget, "Making…", async () => {
        await api(`/api/renders/${r.id}/rerender`, {
          method: "POST",
          body: { overlays: textInput.value.split("\n").map((t) => t.trim()).filter(Boolean) },
        });
        closeSheet();
        await refreshRenders();
        banner("Re-making the video with the new text. It comes back to Review when it's done.", "ok");
      }) }, "Re-make video"),
    ),
  );

  // Text style for this video only: size, look and font; re-makes the video, same text.
  const opts = r.options ?? {};
  const look = { textSize: opts.textSize ?? state.status.settings.textSize ?? "medium", textStyle: opts.textStyle ?? state.status.settings.textStyle, fontId: opts.fontId ?? state.status.settings.fontId };
  const segControl = (name, choices) =>
    h("div", { class: "seg" }, choices.map(([value, label]) =>
      h("label", {}, h("input", { type: "radio", name: `${name}-${r.id}`, value, checked: look[name] === value, onchange: () => { look[name] = value; applyLook.hidden = false; } }), label)));
  const fontSelect = h("select", { onchange: (e) => { look.fontId = e.target.value; applyLook.hidden = false; } });
  api("/api/fonts").then((fonts) => fontSelect.replaceChildren(...fonts.map((f) => h("option", { value: f.id, selected: f.id === look.fontId }, f.name)))).catch(() => {});
  const applyLook = h("button", { class: "btn small primary", hidden: true, onclick: (e) => withBusy(e.currentTarget, "Making…", async () => {
    await api(`/api/renders/${r.id}/rerender`, { method: "POST", body: { options: { ...look } } });
    closeSheet();
    await refreshRenders();
    banner("Re-making the video with the new text style. It comes back to Review in a minute or two.", "ok");
  }) }, "Apply to this video");
  const styleEdit = h("div", { class: "d-style", hidden: true },
    h("span", { class: "d-label" }, "Size"), segControl("textSize", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]]),
    h("span", { class: "d-label" }, "Look"), h("div", { class: "style-grid small" }, styleTiles(`textStyle-${r.id}`, look.textStyle, (v) => { look.textStyle = v; applyLook.hidden = false; })),
    h("span", { class: "d-label" }, "Font"), fontSelect,
    applyLook,
  );

  // Collab version: a variation of this video built around a brand partner.
  const partnerSelect = h("select", {}, ...(state.partners ?? []).map((p) => h("option", { value: p.id }, p.name)));
  const collabNote = h("input", { placeholder: "Anything to focus on? (optional)", maxlength: 500 });
  const collabEdit = h("div", { class: "d-style", hidden: true },
    ...((state.partners ?? []).length
      ? [
          h("span", { class: "d-label" }, "Brand"), partnerSelect,
          h("span", { class: "d-label" }, "Note"), collabNote,
          h("button", { class: "btn small primary", onclick: (e) => withBusy(e.currentTarget, "Writing… (about a minute)", async () => {
            await api(`/api/renders/${r.id}/collab`, { method: "POST", body: { partnerId: partnerSelect.value, note: collabNote.value } });
            closeSheet();
            await refreshRenders();
            banner(`Making the ${partnerSelect.selectedOptions[0]?.textContent} version. It shows up on Review, and this one stays as it is.`, "ok");
          }) }, "Make collab version"),
        ]
      : [h("p", { class: "muted" }, "Add your brand partners first: Settings → Brand partners.")]),
  );

  // Caption: readable text first; edit only when needed.
  const captionText = h("p", { class: "d-caption" }, caption || "No caption");
  const captionEdit = h("textarea", { class: "d-caption-edit", rows: 4, hidden: true }, caption);
  const saveCaption = async () => {
    plan.postCaption = captionEdit.value.trim();
    const updated = await api(`/api/renders/${r.id}`, { method: "PATCH", body: { postCaption: plan.postCaption, hashtags: plan.hashtags } });
    captionText.textContent = plan.postCaption || "No caption";
    // Corrected in Ready: it goes back to Review for a fresh yes or no.
    if (r.review === "approved" && updated.review === "pending") {
      r.review = "pending";
      banner("Description changed: the video is back in Review for a fresh yes or no.", "ok");
      refreshRenders();
    }
  };
  captionEdit.addEventListener("change", saveCaption);
  const copyBtn = h("button", { class: "d-link", onclick: async (e) => {
    await navigator.clipboard.writeText(fullCaption());
    e.currentTarget.textContent = "Copied ✓";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  } }, "Copy");
  const editCaptionBtn = h("button", { class: "d-link", onclick: () => {
    const editing = captionEdit.hidden;
    captionEdit.hidden = !editing;
    captionText.hidden = editing;
    editCaptionBtn.textContent = editing ? "Done" : "Edit";
    if (editing) captionEdit.focus();
    else saveCaption();
  } }, "Edit");

  // Ask the AI for a new description (the video stays as it is), optionally saying what to change.
  const newCaptionBtn = h("button", { class: "d-link", onclick: async (e) => {
    const note = prompt("New caption. Anything it should do differently? (optional)", "");
    if (note === null) return;
    await withBusy(e.currentTarget, "Writing…", async () => {
      const updated = await api(`/api/renders/${r.id}/caption`, { method: "POST", body: { note } });
      plan.postCaption = updated.plan.postCaption;
      plan.aiNote = undefined;
      captionText.textContent = plan.postCaption || "No caption";
      captionEdit.value = plan.postCaption;
      refreshRenders().catch(() => {});
    });
  } }, "New caption");

  // Performance: paste each post's link (TikTok, Instagram); stats are fetched now and daily for two weeks.
  const perf = h("section", { class: "d-sec" });
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const platformRow = (platform, label, placeholder) => {
    const p = (r.posts ?? []).find((x) => x.platform === platform);
    const s = p?.stats;
    const input = h("input", { class: "perf-input", value: p?.url ?? "", placeholder, inputmode: "url" });
    const go = h("button", { class: "btn small primary", onclick: (e) => withBusy(e.currentTarget, "Reading…", async () => {
      const updated = await api(`/api/renders/${r.id}/posted`, { method: "POST", body: { url: input.value, platform } });
      r.posts = updated.posts;
      if (updated.warning) banner(updated.warning);
      renderPerf();
      refreshRenders().catch(() => {});
    }) }, s ? "Refresh" : "Get stats");
    const stats = s
      ? [["views", platform === "instagram" ? "plays" : "views"], ["likes", "likes"], ["comments", "comments"], ["shares", "shares"], ["saves", "saves"]]
          .filter(([k]) => s[k] !== undefined)
      : [];
    return h("div", { class: "perf-platform" },
      h("span", { class: "d-label" }, label),
      stats.length ? h("div", { class: "perf-stats", style: { gridTemplateColumns: `repeat(${stats.length}, 1fr)` } },
        ...stats.map(([k, name]) => h("span", { class: "perf-stat" }, h("b", {}, fmtViews(s[k])), h("small", {}, name)))) : null,
      s && p.fetchedAt ? h("p", { class: "d-hint" }, `Updated ${ago(p.fetchedAt)}`) : null,
      p?.error && !s ? h("p", { class: "d-hint" }, p.error) : null,
      h("div", { class: "perf-row" }, input, go),
    );
  };
  const renderPerf = () =>
    perf.replaceChildren(
      h("div", { class: "d-sec-head" }, h("span", {}, "Performance")),
      platformRow("tiktok", "TikTok", "Posted? Paste the TikTok link"),
      platformRow("instagram", "Instagram", "Posted? Paste the Instagram Reel link"),
      h("p", { class: "d-hint" },
        "Found automatically on your profiles a few hours after you post (paste the description Rollcut wrote; small edits are fine), " +
        "or paste the link. Refreshed daily for 2 weeks; the AI learns from what performs. Instagram only shows plays, likes and comments publicly."),
    );
  renderPerf();

  const b = plan.basedOn;
  const seg = plan.segments?.[0];
  const clip = seg && state.clips.find((c) => c.id === seg.clipId);
  return h("div", { class: "d" },
    h("section", { class: "d-head" },
      headline,
      h("span", { class: "d-actions" },
        h("button", { class: "d-link", onclick: () => { editText.hidden = !editText.hidden; if (!editText.hidden) textInput.focus(); } }, "Edit text"),
        h("button", { class: "d-link", onclick: (e) => withBusy(e.currentTarget, "Reading…", async () => {
          const res = await api(`/api/renders/${r.id}/proofread`, { method: "POST" });
          if (!res.changed) return banner("The text reads fine as it is.", "ok");
          closeSheet();
          await refreshRenders();
          banner("Fixed the text. Re-making the video now; it comes back to Review in a minute or two.", "ok");
        }) }, "Fix the text"),
        h("button", { class: "d-link admin-only", onclick: (e) => withBusy(e.currentTarget, "Copying…", async () => {
          const d = await api(`/api/renders/${r.id}/diagnostics`);
          const text = JSON.stringify(d, null, 1);
          try {
            await navigator.clipboard.writeText(text);
            banner("This video's diagnostics are copied. Paste them into the chat.", "ok");
          } catch {
            h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: `video-${r.id}-diagnostics.txt` }).click();
          }
        }) }, "Copy diagnostics"),
        h("button", { class: "d-link", onclick: () => (styleEdit.hidden = !styleEdit.hidden) }, "Text style"),
        featureOn("collab") ? h("button", { class: "d-link", onclick: () => (collabEdit.hidden = !collabEdit.hidden) }, "Collab version") : null,
      ),
      plan.collab ? h("span", { class: "collab-badge" }, `Collab · ${plan.collab.name}`) : null,
      !plan.collab && KIND_LABEL[plan.format] ? h("span", { class: "collab-badge" }, KIND_LABEL[plan.format]) : null,
      editText,
      styleEdit,
      collabEdit,
    ),
    h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Caption"), h("span", { class: "d-actions" }, newCaptionBtn, editCaptionBtn, copyBtn)),
      captionText,
      captionEdit,
      tags.length ? h("div", { class: "d-chips" },
        tags.map((t) => h("span", { class: "chip" }, `#${t}`, posts.has(t) ? h("small", {}, ` ${fmtViews(posts.get(t))}`) : null))) : null,
      posts.size ? h("p", { class: "d-hint" }, "Numbers are how many TikTok posts use each hashtag.") : null,
    ),
    r.review === "approved" ? perf : null,
    seg ? h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Made from")),
      h("button", { class: "d-source", onclick: () => openClip(seg.clipId) },
        h("img", { src: `/media/thumb/${seg.clipId}`, alt: "", loading: "lazy" }),
        h("span", { class: "d-source-text" },
          h("b", {}, plan.scene || clip?.scene || "Your clip"),
          h("span", { class: "muted" }, `${mmss(seg.start)}–${mmss(seg.end)} of the original`)),
        h("span", { class: "d-play" }, "Play ›"),
      ),
    ) : null,
    r.status === "done" && !r.posts?.length && r.plan.segments?.length
      ? h("section", { class: "d-sec" },
          h("div", { class: "d-sec-head" }, h("span", {}, "Opening shot"),
            h("span", { class: "d-actions" },
              h("button", { class: "d-link", onclick: (e) =>
                withBusy(e.currentTarget, "Finding one…", async () => {
                  await api(`/api/renders/${r.id}/new-opening`, { method: "POST" });
                  banner("A new opening is being drawn. The video reappears in a minute with the same text.", "ok");
                  await refreshRenders();
                }) }, "New opening"))),
          h("p", { class: "d-hint" }, "Swaps the first seconds for different airport footage (check-in, terminal, gate, plane), the rest stays."),
          r.editor ? null : h("button", { class: "btn", onclick: (e) => {
            const note = prompt("Make it again. Anything it should do differently? (optional)", "");
            if (note === null) return;
            withBusy(e.currentTarget, "Starting…", async () => {
              await api(`/api/renders/${r.id}/redo-editor`, { method: "POST", body: { note } });
              banner("Making it again. The new version appears in Review.", "ok");
              await refreshRenders();
            });
          } }, "Make again"))
      : null,
    shotsSection(r),
    soundsSection(r),
    r.editor ? h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Editor's review")),
      h("div", { class: "muted" },
        `${{ passed: "Passed", text_fixed: "Text fixed, then checked again", remade: "Made again", let_through: "Let through with notes" }[r.editor.outcome] ?? ""} · ` +
          Object.entries(r.editor.scores).map(([k, v]) => `${{ hook: "first 3s", body: "body", ending: "ending" }[k] ?? k} ${v}/10`).join(" · ")),
      r.editor.dropOff?.length ? h("div", { class: "muted" }, `Most likely to lose viewers at ${r.editor.dropOff[0].at.toFixed(1)}s: ${r.editor.dropOff[0].why}`) : null,
      r.editor.issues?.length ? h("ul", { class: "editor-issues" }, ...r.editor.issues.map((x) => h("li", {}, x))) : null,
      r.editor.outcome !== "passed" && !(r.remadeAs && r.remadeAs !== "pending")
        ? h("button", { class: "btn", onclick: (e) =>
            withBusy(e.currentTarget, "Starting…", async () => {
              await api(`/api/renders/${r.id}/redo-editor`, { method: "POST", body: {} });
              banner("Making it again with the editor's notes. The new version appears in Review.", "ok");
              await refreshRenders();
            }) }, "Redo with this feedback")
        : null,
    ) : null,
    b ? h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Inspired by")),
      h("div", { class: "d-proof" },
        h("span", { class: "d-proof-icon" }, "🔥"),
        h("span", {},
          h("b", {}, b.views ? `${fmtViews(b.views)} views on TikTok` : "A popular TikTok"),
          h("span", { class: "d-proof-text" }, `“${b.text}”`),
          b.original && b.original !== b.text ? h("span", { class: "muted" }, ` (their video: “${b.original}”)`) : null,
          b.url ? h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, "Watch on TikTok ›") : null),
      ),
    ) : null,
  );
}

/** One trending sound: name, why or how fast it's growing, and a link to use it in TikTok. */
const soundRow = (x, note) =>
  h("li", { class: "sound" },
    h("div", { class: "grow" }, h("b", {}, x.name), x.author ? h("span", { class: "muted" }, ` · ${x.author}`) : null, note ? h("div", { class: "muted" }, note) : null),
    h("a", { class: "btn small", href: x.url, target: "_blank", rel: "noopener noreferrer" }, "Open in TikTok"));

/** Trending sounds that fit this video, loaded when the details open (TikTok adds the sound when posting). */
// The video's shots in order, like an editor's timeline: tap a shot to select it, and one bar
// under the strip swaps it, cuts it, or keeps that clip out for good (the same button again keeps
// it). Apply draws the video again with the same text.
const SHOT_LABEL = { swap: "Swap", remove: "Cut", never: "Never use" };
function shotsSection(r) {
  if (r.status !== "done" || r.posts?.length || !r.plan.segments?.length) return null;
  let shots = [];
  let sel = 0;
  const picks = [];
  const strip = h("div", { class: "shots", role: "listbox", "aria-label": "Shots" }, h("span", { class: "muted" }, "Loading shots…"));
  const bar = h("div", { class: "shot-bar" });
  const apply = h("button", { class: "btn primary shot-apply", hidden: true, onclick: (e) => {
    if (picks.every((a) => a === "remove")) return banner("Keep at least one shot.", "error");
    withBusy(e.currentTarget, "Starting…", async () => {
      await api(`/api/renders/${r.id}/shots`, { method: "POST", body: { actions: picks } });
      banner("Drawing it again with your changes. It reappears in a minute with the same text.", "ok");
      await refreshRenders();
    });
  } });
  const icon = (d) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const x of d) svg.appendChild(document.createElementNS(ns, "path")).setAttribute("d", x);
    return svg;
  };
  const ICONS = {
    play: ["M8 5v14l11-7z"],
    swap: ["M7 7h11l-3-3M17 17H6l3 3"],
    remove: ["M6 6l12 12M18 6L6 18"],
    never: ["M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M5.6 5.6l12.8 12.8"],
  };
  const draw = () => {
    for (const [i, card] of [...strip.children].entries()) {
      card.classList.toggle("sel", i === sel);
      card.setAttribute("aria-selected", String(i === sel));
      card.dataset.a = picks[i];
      const tag = card.querySelector(".shot-tag");
      tag.textContent = SHOT_LABEL[picks[i]] ?? "";
      tag.hidden = !SHOT_LABEL[picks[i]];
    }
    const s = shots[sel];
    const a = picks[sel];
    const act = (key, label, next) =>
      h("button", { class: `shot-btn${a === key ? " on" : ""}${key === "never" ? " danger" : ""}`, onclick: () => { picks[sel] = a === key ? "keep" : next; draw(); } }, icon(ICONS[key]), h("span", {}, label));
    bar.replaceChildren(
      h("div", { class: "shot-info" },
        h("b", {}, `Shot ${sel + 1} · ${s.from.toFixed(1)}–${s.to.toFixed(1)}s`),
        h("span", { class: "muted" }, s.summary || s.scene || "")),
      h("div", { class: "shot-btns" },
        h("button", { class: "shot-btn", onclick: () => openClip(s.clipId) }, icon(ICONS.play), h("span", {}, "Play")),
        act("swap", "Swap", "swap"),
        act("remove", "Cut", "remove"),
        act("never", "Never use", "never")));
    const n = picks.filter((x) => x !== "keep").length;
    apply.hidden = !n;
    apply.textContent = `Apply ${n} change${n > 1 ? "s" : ""}`;
  };
  api(`/api/renders/${r.id}/timeline`)
    .then((list) => {
      shots = list;
      list.forEach((s) => (picks[s.index] = "keep"));
      strip.replaceChildren(
        ...list.map((s) =>
          h("button", { class: "shot", role: "option", style: { flexBasis: `${Math.max(56, Math.min(120, (s.to - s.from) * 34))}px` }, onclick: () => { sel = s.index; draw(); } },
            h("img", { src: s.frame, alt: `Shot ${s.index + 1}`, loading: "lazy" }),
            h("span", { class: "shot-time" }, `${(s.to - s.from).toFixed(1)}s`),
            h("span", { class: "shot-tag", hidden: true }))));
      draw();
    })
    .catch(() => strip.replaceChildren(h("span", { class: "muted" }, "Couldn't load the shots.")));
  return h("section", { class: "d-sec" },
    h("div", { class: "d-sec-head" }, h("span", {}, "Shots")),
    strip,
    bar,
    apply);
}

function soundsSection(r) {
  if (r.status !== "done") return null;
  const list = h("ul", { class: "sounds" }, h("li", { class: "muted" }, "Finding sounds that fit…"));
  api(`/api/renders/${r.id}/sounds`)
    .then(({ sounds, trending }) =>
      list.replaceChildren(
        ...(sounds.length
          ? sounds.map((x) => soundRow(x, x.why))
          : [h("li", { class: "muted" }, trending ? "None of the trending sounds fit this one." : "No trending sounds yet: they're read every few days (Search page → Trending sounds).")]),
      ),
    )
    .catch(() => list.replaceChildren(h("li", { class: "muted" }, "Couldn't load sounds.")));
  return h("section", { class: "d-sec" },
    h("div", { class: "d-sec-head" }, h("span", {}, "Trending sounds that fit")),
    h("p", { class: "d-hint" }, "Picking up fast on TikTok right now. Open one in TikTok, tap Use this sound, and keep the video's own sound low."),
    list);
}

async function refreshSoundsList(force = false) {
  const el = document.getElementById("sounds-list");
  if (!el) return;
  const r = await api(force ? "/api/sounds/refresh" : "/api/sounds", force ? { method: "POST" } : undefined).catch((err) => ({ error: err.message }));
  if (r.error) return void el.replaceChildren(h("li", { class: "muted" }, r.error));
  document.getElementById("sounds-at").textContent = r.at ? `Read ${new Date(r.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "Not read yet";
  el.replaceChildren(
    ...(r.sounds.length
      ? r.sounds.map((x, i) => soundRow({ ...x, name: `${i + 1}. ${x.name}` }, `${x.recent} new posts in 3 days · ${x.growth}× faster than the 11 days before${x.original ? " · original audio" : ""}`))
      : [h("li", { class: "muted" }, r.at ? "Nothing is taking off in the sample right now." : "Not read yet: tap Read now.")]),
  );
}
document.getElementById("sounds-refresh")?.addEventListener("click", (e) => withBusy(e.currentTarget, "Reading TikTok…", () => refreshSoundsList(true)));

function dragToSwipe(card, handle, onSwipe, onTap) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, id = null;
  const keep = card.querySelector(".stamp.keep"), nope = card.querySelector(".stamp.nope");
  const paint = () => {
    card.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 18}deg)` : "";
    keep.style.opacity = String(Math.max(0, Math.min(1, dx / 90)));
    nope.style.opacity = String(Math.max(0, Math.min(1, -dx / 90)));
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a")) return;
    dragging = true; id = e.pointerId; startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
    handle.setPointerCapture(id);
    card.style.transition = "none";
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== id) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    // Mostly-vertical moves scroll the page, not swipe.
    if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dx) < 20) { dx = 0; return; }
    paint();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "";
    if (Math.abs(dx) > Math.min(110, window.innerWidth * 0.25)) {
      card.style.transition = "transform .25s ease-out";
      const dir = dx > 0 ? "right" : "left";
      dx = dir === "right" ? window.innerWidth : -window.innerWidth;
      paint();
      onSwipe(dir);
    } else {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) onTap();
      dx = 0;
      paint();
    }
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  card.flyOut = (dir) => {
    card.style.transition = "transform .25s ease-out";
    dx = dir === "right" ? window.innerWidth : -window.innerWidth;
    paint();
  };
}

// Keeping a video saves it right away. On phones that opens the share sheet
// ("Save Video", or straight to TikTok); elsewhere it downloads the file.
const files = new Map();
function fileName(r) {
  return `${(state.status?.settings.petName || "video")}-${r.createdAt.slice(0, 10)}-${r.id.slice(-4)}.mp4`;
}
function prefetchFile(r) {
  if (files.has(r.id) || !navigator.canShare) return;
  files.set(r.id, null);
  fetch(`/media/render/${r.id}.mp4?full=1`)
    .then((res) => res.blob())
    .then((b) => files.set(r.id, new File([b], fileName(r), { type: "video/mp4" })))
    .catch(() => files.delete(r.id));
}
function saveVideo(r) {
  const file = files.get(r.id);
  const markSaved = () => api(`/api/renders/${r.id}`, { method: "PATCH", body: { downloaded: true } }).then(() => (r.downloaded = true)).catch(() => {});
  // The caption + hashtags go on the clipboard, ready to paste into TikTok / Instagram.
  const caption = [r.plan.postCaption, r.plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  navigator.clipboard?.writeText(caption).catch(() => {});
  const isPhone = matchMedia("(pointer: coarse)").matches;
  if (isPhone && file && navigator.canShare?.({ files: [file] })) {
    // Opens the phone's share sheet: pick TikTok, Instagram, YouTube… (or Save Video).
    navigator.share({ files: [file], text: caption }).then(markSaved).catch(() => {});
    return;
  }
  const a = h("a", { href: `/media/render/${r.id}.mp4?dl=1`, download: fileName(r) });
  document.body.append(a);
  a.click();
  a.remove();
  markSaved();
}

function decide(dir) {
  const r = toReview().find((x) => x.id === stack.shownId);
  if (!r) return;
  // Must run inside the swipe/tap itself: browsers only open share sheets and downloads from a gesture.
  if (dir === "right") saveVideo(r);
  if (!stack.node.style.transform) stack.node.flyOut(dir);
  const review = dir === "right" ? "approved" : "rejected";
  stack.history.push(r.id);
  stack.whyFor = review === "rejected" ? r.id : null;
  r.review = review;
  if (!toReview().length) {
    state.nextRoundUntil = Date.now() + 6 * 60_000;
    state.roundStartedAt = new Date().toISOString();
  }
  if (review === "approved") banner("Caption copied. Pick the app to post to, then paste the caption. The video is also in Ready.", "ok");
  api(`/api/renders/${r.id}`, { method: "PATCH", body: { review } }).catch((err) => banner(err.message));
  setTimeout(() => { stack.shownId = null; renderStack(); renderBatch(); renderRenders(); renderHomeState(); }, 230);
}

$("#stack-why").addEventListener("click", (e) => {
  const reason = e.target.dataset?.reason;
  if (!reason || !stack.whyFor) return;
  // "Something else": say what, in a few words.
  if (reason === "other") {
    $("#why-note").hidden = false;
    $("#why-text").focus();
    return;
  }
  sendWhy(reason);
});
$("#why-send").addEventListener("click", () => sendWhy("other", $("#why-text").value.trim()));

function sendWhy(reason, note = "") {
  if (!stack.whyFor) return;
  api(`/api/renders/${stack.whyFor}`, { method: "PATCH", body: { rejectReason: reason, ...(note ? { rejectNote: note } : {}) } }).catch((err) => banner(err.message));
  banner(
    { text: "Got it. Making a new version with different text; it shows up here in a minute or two.",
      clip: "Got it. Making the same kind of video on other footage; it shows up here in a minute or two.",
      edit: "Got it. Making a new cut of that clip; it shows up here in a minute or two.",
      other: "Got it. Making a new version that fixes that; it shows up here in a minute or two." }[reason],
    "ok",
  );
  $("#why-note").hidden = true;
  $("#why-text").value = "";
  stack.whyFor = null;
  renderStack();
  renderBatch();
  renderRenders();
  renderHomeState();
}

$("#stack-undo").addEventListener("click", async () => {
  const id = stack.history.pop();
  if (!id) return;
  await api(`/api/renders/${id}`, { method: "PATCH", body: { review: "pending" } });
  const r = state.renders.find((x) => x.id === id);
  if (r) r.review = "pending";
  $("#stack-why").hidden = true;
  stack.whyFor = null;
  stack.shownId = id;
  stack.node = null;
  renderStack();
  renderBatch();
});

$("#stack-yes").addEventListener("click", () => decide("right"));
$("#stack-no").addEventListener("click", () => decide("left"));
document.addEventListener("keydown", (e) => {
  if ($("#stack").hidden || stack.whyFor || e.target.closest?.("input, textarea, select")) return;
  if (e.key === "ArrowRight") decide("right");
  else if (e.key === "ArrowLeft") decide("left");
});

const renderEls = new Map();
function renderRenders() {
  const el = $("#renders");
  // Ready tab, folded: rejected videos and ones that couldn't be made.
  // Attempts the editor's review set aside aren't shown: only what the creator rejected, and failures.
  const earlier = state.renders.filter((r) => (r.review === "rejected" && r.rejectedBy !== "editor") || r.status === "error");
  $("#renders-empty").hidden = earlier.length > 0;
  const nodes = earlier.map((r) => {
    const key = `${r.id}:${r.status}:${r.review}:${r.rejectReason}:${r.downloaded}:${r.status === "done" ? "" : Math.round(r.progress * 20)}`;
    const cached = renderEls.get(r.id);
    if (cached?.key === key) return cached.node;
    const node = tile(r);
    renderEls.set(r.id, { key, node });
    return node;
  });
  el.replaceChildren(...nodes);
}

/** A video in the Kept / Earlier lists: a framed thumbnail; tap to open it. */
function tile(r) {
  const label = r.plan.overlays?.map((o) => o.text).join(" / ") || r.plan.hook || r.plan.title;
  const badge =
    r.status === "error" ? h("span", { class: "badge err" }, "Couldn't make this")
    : r.status !== "done" ? h("span", { class: "badge" }, r.status === "queued" ? "Waiting…" : `Making… ${Math.round(r.progress * 100)}%`)
    : r.review === "rejected" ? h("span", { class: "badge no" }, `Rejected${r.rejectReason && r.rejectReason !== "other" ? ` · ${REASON_LABEL[r.rejectReason]}` : ""}`)
    : r.downloaded ? h("span", { class: "badge yes" }, "Saved ✓")
    : r.posts?.some((p) => p.stats) ? h("span", { class: "badge yes" }, `${fmtViews(r.posts.reduce((n, p) => n + (p.stats?.views ?? 0), 0))} views`)
    : r.review === "approved" ? h("span", { class: "badge yes" }, r.plan.collab ? `To post · ${r.plan.collab.name}` : "To post")
    : null;
  return h("div", { class: `tile ${r.status === "done" ? "openable" : ""}`, onclick: () => r.status === "done" && openSheet(r) },
    h("div", { class: "tile-media" },
      r.status === "done" ? h("img", { src: `/media/render/${r.id}.jpg`, alt: "", loading: "lazy" }) : h("div", { class: "tile-ph" }),
      badge,
    ),
    h("div", { class: "tile-text" }, label),
    r.status === "error"
      ? h("div", { class: "tile-actions" },
          h("button", { class: "btn small", onclick: (e) => withBusy(e.currentTarget, "…", async () => {
            await api(`/api/renders/${r.id}/retry`, { method: "POST" });
            await refreshRenders();
          }) }, "Try again"),
          h("button", { class: "btn small quiet-btn", onclick: () => deleteVideo(r) }, "Delete"),
        )
      : null,
  );
}

async function deleteVideo(r) {
  if (!confirm("Delete this video?")) return;
  await api(`/api/renders/${r.id}`, { method: "DELETE" });
  closeSheet();
  await refreshRenders();
}

function openSheet(r) {
  const sheet = $("#sheet");
  prefetchFile(r);
  const video = h("video", { src: playable(`/media/render/${r.id}.mp4`), poster: `/media/render/${r.id}.jpg`, controls: true, autoplay: true, loop: true, playsinline: true });
  const actions = h("div", { class: "sheet-actions" },
    r.review === "rejected"
      ? h("button", { class: "btn", onclick: async () => {
          await api(`/api/renders/${r.id}`, { method: "PATCH", body: { review: "pending" } });
          closeSheet();
          await refreshRenders();
          showTab("review");
        } }, "Review again")
      : h("button", { class: "btn primary", onclick: () => { saveVideo(r); setTimeout(refreshRenders, 1000); } }, r.downloaded ? "Save again" : "Save video"),
    h("button", { class: "btn quiet-btn", onclick: () => deleteVideo(r) }, "Delete"),
  );
  const details = detailsBody(r);
  sheet.replaceChildren(
    h("div", { class: "sheet-card" },
      h("button", { class: "sheet-close", "aria-label": "Close", onclick: closeSheet }, "✕"),
      h("div", { class: "sheet-media" }, video),
      details,
      actions,
    ),
  );
  sheet.hidden = false;
  document.body.classList.add("no-scroll");
}

function closeSheet() {
  const sheet = $("#sheet");
  sheet.querySelector("video")?.pause();
  sheet.classList.remove("full");
  sheet.hidden = true;
  sheet.replaceChildren();
  document.body.classList.remove("no-scroll");
}
$("#sheet").addEventListener("click", (e) => e.target.id === "sheet" && closeSheet());
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("#sheet").hidden && closeSheet());

// ---- Story videos -------------------------------------------------------------------
// One input: plain text is the voiceover, a line starting with "/" is the scene for the words after
// it. Rollcut finds a clip for every line (the asked-for scene, or the best match), then the creator
// records the lines or lets their cloned voice read them.

/** Fills the brand partner picker (called again when partners change). */
function renderStoryMode() {
  $("#story-form").partnerId.replaceChildren(h("option", { value: "" }, "None"), ...(state.partners ?? []).map((p) => h("option", { value: p.id }, p.name)));
}
renderStoryMode();

$("#story-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const mode = f.rough.checked ? "talk" : "script";
  const text = editorText();
  withBusy($("#story-go"), mode === "talk" ? "Writing & finding clips… (1–2 min)" : "Finding the clips… (1–2 min)", async () => {
    state.draft = await api("/api/story/drafts", { method: "POST", body: { mode, text, partnerId: f.partnerId.value } });
    // The scenes used are saved on the server as reusable tags; mirror that here.
    const used = [...editor.querySelectorAll(".shot-chip")].map((c) => c.dataset.shot);
    setShotTags([...used.reverse(), ...shotTags()], false);
    try { localStorage.setItem("rollcut.draft", state.draft.id); } catch {}
    renderDraft();
    $("#story-draft").scrollIntoView({ behavior: "smooth" });
  });
});

// ---- Voiceover editor: text is spoken, "/scene" turns into a scene chip -------------------

const editor = $("#vo-editor");
const SLASH_LINE = /^\s*\/\s*(\S.*?)\s*$/;
const shotTags = () => state.status?.settings?.shotTags ?? [];

async function setShotTags(tags, save = true) {
  const seen = new Set();
  const list = tags.filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 60);
  if (state.status?.settings) state.status.settings.shotTags = list;
  renderSavedShots();
  if (save) await api("/api/settings", { method: "PUT", body: { shotTags: list } }).catch((e) => banner(e.message));
}

function chipEl(shot) {
  return h("span", { class: "shot-chip", contenteditable: "false", "data-shot": shot },
    h("span", { class: "shot-chip-slash", "aria-hidden": "true" }, "/"),
    h("span", {}, shot),
    h("button", { type: "button", class: "shot-chip-x", "aria-label": `Remove scene ${shot}`, onclick: (e) => { e.preventDefault(); e.currentTarget.parentElement.remove(); } }, "×"));
}

/** Text as the server reads it: chips become "/ scene" lines. */
function editorText() {
  let out = "";
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent.replace(/\u00a0/g, " ");
      else if (c.classList?.contains("shot-chip")) {
        const shot = c.dataset.shot ?? draftText(c);
        if (shot) out += `\n/ ${shot}\n`;
      }
      else if (c.nodeName === "BR") out += "\n";
      else {
        if (/^(DIV|P)$/.test(c.nodeName) && out && !out.endsWith("\n")) out += "\n";
        walk(c);
      }
    }
  };
  walk(editor);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text (pasted, or a saved story) as editor content, "/ scene" lines as chips. */
function fragmentFromText(text) {
  const frag = document.createDocumentFragment();
  text.replace(/\r/g, "").split("\n").forEach((line, i, all) => {
    const m = line.match(SLASH_LINE);
    if (m) frag.append(chipEl(m[1]), document.createTextNode("\u00a0"));
    else {
      frag.append(document.createTextNode(line));
      if (i < all.length - 1) frag.append(h("br"));
    }
  });
  return frag;
}

let lastRange = null;
document.addEventListener("selectionchange", () => {
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
});

function insertAtCaret(node) {
  let range = lastRange && editor.contains(lastRange.startContainer) ? lastRange : null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const last = node.lastChild ?? node;
  range.insertNode(node);
  const r = document.createRange();
  r.setStartAfter(last);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  lastRange = r.cloneRange();
}

/** A "/" just typed at the start of a word, right before the caret. */
function justTypedSlash() {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (node?.nodeType !== Node.TEXT_NODE || !editor.contains(node) || node.parentElement.closest(".shot-chip")) return null;
  const before = node.textContent.slice(0, sel.anchorOffset);
  return /(^|[\s\u00a0])\/$/.test(before) ? { node, at: sel.anchorOffset - 1 } : null;
}

/** The chip being typed (the caret is inside it), if any. */
function draftChip() {
  const sel = getSelection();
  const n = sel.rangeCount ? sel.anchorNode : null;
  const el = n && (n.nodeType === Node.TEXT_NODE ? n.parentElement : n);
  const chip = el?.closest?.(".shot-chip.drafting");
  return chip && editor.contains(chip) ? chip : null;
}
const draftText = (chip) => chip.textContent.replace(/[\u200b\u00a0]/g, " ").replace(/\s+/g, " ").trim();

function caretInto(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Typing "/" starts a chip right there; what's typed next goes inside it. */
function startDraftChip({ node, at }) {
  const rest = node.splitText(at);
  rest.textContent = rest.textContent.slice(1); // drop the typed "/"
  const text = document.createTextNode("\u200b");
  const chip = h("span", { class: "shot-chip drafting" }, text);
  rest.before(chip);
  caretInto(text, 1);
  showSuggest(chip);
}

let suggest = null; // { chip, options, active }

function hideSuggest() {
  suggest = null;
  $("#vo-suggest").hidden = true;
}

function showSuggest(chip = draftChip()) {
  if (!chip) return hideSuggest();
  const typed = draftText(chip);
  const needle = typed.toLowerCase();
  const matches = shotTags().filter((t) => !needle || t.toLowerCase().includes(needle)).slice(0, 6);
  const options = [...matches];
  if (needle && !matches.some((t) => t.toLowerCase() === needle)) options.push(typed);
  const active = suggest?.chip === chip && suggest.active < options.length ? suggest.active : 0;
  suggest = { chip, options, active };
  const box = $("#vo-suggest");
  box.hidden = false;
  box.replaceChildren(
    ...(options.length
      ? options.map((t, i) =>
          h("button", { type: "button", class: `vo-opt ${i === active ? "on" : ""}`, onpointerdown: (e) => { e.preventDefault(); commitChip(chip, t); } },
            h("span", { class: "shot-chip small" }, h("span", { class: "shot-chip-slash" }, "/"), h("span", {}, t)),
            i === options.length - 1 && !matches.includes(t) ? h("span", { class: "muted" }, " new scene") : null))
      : [h("p", { class: "muted vo-hint" }, "Type the scene, e.g. Lex inside airplane, then press Enter.")]),
  );
}

/** Finish the chip being typed: a fixed chip with this scene, the caret right after it. */
function commitChip(chip, shot = draftText(chip)) {
  hideSuggest();
  if (!chip.isConnected) return;
  if (!shot.trim()) return chip.remove();
  const done = chipEl(shot.trim());
  const space = document.createTextNode("\u00a0");
  chip.replaceWith(done, space);
  caretInto(space, 1);
  lastRange = getSelection().getRangeAt(0).cloneRange();
}

/** Escape: keep what was typed as plain words, slash included. */
function cancelChip(chip) {
  hideSuggest();
  const text = document.createTextNode(`/${chip.textContent.replace(/\u200b/g, "")}`);
  chip.replaceWith(text);
  caretInto(text, text.length);
}

editor.addEventListener("input", () => {
  const slash = justTypedSlash();
  if (slash) return startDraftChip(slash);
  const chip = draftChip();
  // Backspaced the whole scene away: the chip goes too.
  if (chip && !chip.textContent.replace(/\u200b/g, "")) {
    chip.remove();
    return hideSuggest();
  }
  showSuggest(chip);
});
editor.addEventListener("blur", () =>
  setTimeout(() => {
    if (editor.contains(document.activeElement) || document.activeElement === editor) return;
    for (const c of editor.querySelectorAll(".shot-chip.drafting")) commitChip(c);
    hideSuggest();
  }, 150));
editor.addEventListener("keydown", (e) => {
  const chip = draftChip();
  if (!chip) return;
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggest?.options.length) {
    e.preventDefault();
    const n = suggest.options.length;
    suggest.active = (suggest.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    showSuggest(chip);
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    commitChip(chip, suggest?.options[suggest.active] ?? draftText(chip));
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelChip(chip);
  }
});
// Phone keyboards don't always send Enter as a key: catch the new line itself.
editor.addEventListener("beforeinput", (e) => {
  const chip = draftChip();
  if (chip && (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak")) {
    e.preventDefault();
    commitChip(chip, suggest?.options[suggest.active] ?? draftText(chip));
  }
});
editor.addEventListener("paste", (e) => {
  e.preventDefault();
  insertAtCaret(fragmentFromText(e.clipboardData.getData("text/plain")));
});

/** Scenes used before: tap to add one where the cursor is; × forgets it. */
function renderSavedShots() {
  const tags = shotTags();
  $("#vo-saved").replaceChildren(
    ...(tags.length
      ? [h("span", { class: "muted vo-saved-title" }, "Your scenes"),
         ...tags.map((t) =>
           h("span", { class: "shot-chip saved" },
             h("button", { type: "button", class: "shot-chip-add", onpointerdown: (e) => e.preventDefault(), onclick: () => { insertAtCaret(chipEl(t)); insertAtCaret(document.createTextNode("\u00a0")); } },
               h("span", { class: "shot-chip-slash" }, "/"), t),
             h("button", { type: "button", class: "shot-chip-x", "aria-label": `Forget scene ${t}`, onclick: () => setShotTags(shotTags().filter((x) => x !== t)) }, "×")))]
      : []),
  );
}
renderSavedShots();

/** The shot list: each spoken line with its clip (or what's missing), and recording. */
function renderDraft() {
  const d = state.draft;
  const box = $("#story-draft");
  box.hidden = !d;
  if (!d) return;
  const missing = d.lines.filter((l) => !l.clipId).length;
  const recorded = d.lines.filter((l) => l.recorded).length;
  const clipOptions = state.clips.filter((c) => c.status === "ready" && c.height >= c.width);
  box.replaceChildren(
    h("div", { class: "d-sec-head" }, h("span", {}, d.title || "Your story")),
    h("p", { class: "muted" },
      `${d.lines.length} lines · ${d.lines.length - missing} with a clip${missing ? ` · ${missing} need footage` : ""} · ${recorded} recorded`),
    ...d.lines.map((l, i) =>
      h("div", { class: `draft-line ${l.clipId ? "" : "missing"}` },
        l.clipId ? h("img", { class: "draft-thumb", src: `/media/thumb/${l.clipId}`, alt: "" }) : h("div", { class: "draft-thumb ph" }, "?"),
        h("div", { class: "draft-body" },
          h("p", { class: "draft-text" }, l.text),
          l.shot ? h("p", { class: "draft-shot" }, `Your shot: ${l.shot}`) : null,
          !l.clipId ? h("p", { class: "draft-missing" }, `Needs: ${l.missing || "a clip"}`) : null,
          h("select", { class: "draft-clip", onchange: async (e) => {
            state.draft = await api(`/api/story/drafts/${d.id}/lines/${i}`, { method: "PATCH", body: { clipId: e.target.value } });
            renderDraft();
          } },
            h("option", { value: "", selected: !l.clipId }, l.clipId ? "Change clip…" : "Pick a clip…"),
            ...clipOptions.map((c) => h("option", { value: c.id }, `${c.scene || "clip"} · ${c.capturedAt ? c.capturedAt.slice(0, 10) : ""} · ${Math.round(c.duration)}s`))),
          h("div", { class: "draft-actions" },
            h("button", { class: `btn small ${l.recorded ? "" : "primary"}`, type: "button", onclick: () => recordLine(i) }, l.recorded ? "Re-record" : "Record"),
            l.recorded ? h("button", { class: "btn small", type: "button", onclick: () => new Audio(`/api/story/drafts/${d.id}/lines/${i}/audio?t=${Date.now()}`).play() }, `Play${l.audioBy === "clone" ? " (clone)" : ""} · ${l.audioSeconds?.toFixed(1)}s`) : null,
          ),
        ),
      ),
    ),
    h("div", { class: "draft-final" },
      state.voice?.voice
        ? h("button", { class: "btn", type: "button", onclick: (e) => speakDraft(e.currentTarget, recorded === d.lines.length) },
            recorded === d.lines.length ? "Re-read every line in my cloned voice" : recorded ? "Read the other lines in my cloned voice" : "Read it in my cloned voice")
        : null,
      h("button", { class: "btn primary", type: "button", disabled: !!missing || recorded < d.lines.length, onclick: (e) => makeFromDraft(e.currentTarget, true) },
        recorded < d.lines.length ? `Record all lines (${recorded}/${d.lines.length})` : "Make video with my voice"),
      h("button", { class: "btn", type: "button", disabled: !!missing, onclick: (e) => makeFromDraft(e.currentTarget, false) }, "Captions only, no voice"),
    ),
  );
}

async function speakDraft(btn, all) {
  await withBusy(btn, "Reading the lines… (about 30s)", async () => {
    state.draft = await api(`/api/story/drafts/${state.draft.id}/speak`, { method: "POST", body: { all } });
    renderDraft();
  });
}

async function makeFromDraft(btn, voice) {
  await withBusy(btn, "Making…", async () => {
    await api(`/api/story/drafts/${state.draft.id}/render`, { method: "POST", body: { voice } });
    await refreshRenders();
    closeSubpages();
    showTab("review");
    banner("Making your story video. It shows up on Review in a minute or two.", "ok");
  });
}

/** Teleprompter: the text big on screen while the microphone records; resolves with the recording on Stop. */
async function recordAudio(hint, text, minSeconds = 0) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    banner("Rollcut needs the microphone to record. Allow it in your browser and try again.");
    return null;
  }
  const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const timer = h("span", {}, "0:00");
  const prompter = h("div", { class: "prompter" },
    h("p", { class: "prompter-hint" }, hint, " · ", timer),
    h("p", { class: `prompter-text ${text.length > 200 ? "long" : ""}` }, text),
    h("button", { class: "round no prompter-stop", type: "button", "aria-label": "Stop" }, h("span", {}, "Stop")),
  );
  document.body.append(prompter);
  const began = Date.now();
  const tick = setInterval(() => {
    const t = Math.floor((Date.now() - began) / 1000);
    timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}${minSeconds && t < minSeconds ? ` (keep going to ${minSeconds}s)` : ""}`;
  }, 250);
  const stopped = new Promise((resolve) => (rec.onstop = resolve));
  prompter.querySelector(".prompter-stop").addEventListener("click", () => rec.state !== "inactive" && rec.stop());
  rec.start(1000);
  await stopped;
  clearInterval(tick);
  stream.getTracks().forEach((t) => t.stop());
  prompter.remove();
  const mime = rec.mimeType || type || "audio/webm";
  return { blob: new Blob(chunks, { type: mime }), ext: mime.includes("mp4") ? "m4a" : "webm" };
}

async function recordLine(i) {
  const d = state.draft;
  const r = await recordAudio(`Line ${i + 1} of ${d.lines.length} · recording`, d.lines[i].text);
  if (!r) return;
  const form = new FormData();
  form.append("file", r.blob, `line-${i}.${r.ext}`);
  try {
    state.draft = await api(`/api/story/drafts/${d.id}/lines/${i}/audio`, { method: "POST", body: form });
    renderDraft();
  } catch (err) {
    banner(err.message);
  }
}

// ---- The creator's cloned voice ---------------------------------------------------------

const VOICE_PASSAGE =
  "Hi, it's me. I travel the world with my dog, and people always ask me the same things. Is flying stressful for him? " +
  "Honestly, he's usually calmer than I am. We've done airports, trains, buses and boats, and every trip teaches us something new. " +
  "The first flight was the scariest. I packed way too much, I triple-checked every document, and he just fell asleep under the seat. " +
  "Now we have a routine: a long walk before the airport, a quiet corner at the gate, and his favourite blanket in the bag. " +
  "Would I do it again? Absolutely. Seeing the world with him is the best decision I ever made. " +
  "So if you're nervous about travelling with your dog, start small, stay calm, and trust them a little more. They often surprise you. " +
  "Okay, that's enough from me. Let's go somewhere new!";

async function refreshVoice() {
  state.voice = await api("/api/voice").catch(() => null);
  const box = $("#my-voice");
  const v = state.voice;
  if (!v) return box.replaceChildren();
  box.replaceChildren(h("div", {},
    h("div", { class: "row-title" }, "My voice"),
    !v.enabled
      ? h("p", { class: "muted" }, "To let Rollcut read your voiceovers in your own voice, add an ElevenLabs API key (ELEVENLABS_API_KEY) on Render. You can always record the lines yourself.")
      : v.voice
        ? h("p", { class: "muted" }, `Your cloned voice is ready (made ${v.voice.createdAt.slice(0, 10)} from ${v.voice.sampleSeconds}s of you talking). Stories get a "Read it in my cloned voice" button.`)
        : h("p", { class: "muted" }, "Read a short passage out loud (about a minute, in a quiet room, the way you talk in your videos). Rollcut makes a copy of your voice from it that can read any voiceover."),
    v.enabled
      ? h("div", { class: "draft-actions" },
          h("button", { class: `btn small ${v.voice ? "" : "primary"}`, type: "button", onclick: (e) => makeVoice(e.currentTarget) }, v.voice ? "Make it again" : "Make my voice"),
          v.voice ? h("button", { class: "btn small", type: "button", onclick: async () => {
            if (!confirm("Remove your cloned voice?")) return;
            await api("/api/voice", { method: "DELETE" });
            refreshVoice();
            renderDraft();
          } }, "Remove") : null)
      : null,
  ));
}

async function makeVoice(btn) {
  const r = await recordAudio("Read this out loud · recording", VOICE_PASSAGE, 45);
  if (!r) return;
  const form = new FormData();
  form.append("files", r.blob, `voice.${r.ext}`);
  await withBusy(btn, "Making your voice…", async () => {
    await api("/api/voice", { method: "POST", body: form });
    await refreshVoice();
    renderDraft();
    banner("Your voice is ready. Stories can now be read in it.", "ok");
  });
}
refreshVoice();

// Pick up an unfinished story where it was left.
(async () => {
  let id;
  try { id = localStorage.getItem("rollcut.draft"); } catch {}
  if (!id) return;
  state.draft = await api(`/api/story/drafts/${id}`).catch(() => null);
  if (state.draft) {
    $("#story-form").rough.checked = state.draft.mode === "talk";
    if (!editorText()) editor.replaceChildren(fragmentFromText(state.draft.source));
    renderDraft();
  }
})();

$("#btn-story-empty").addEventListener("click", () => {
  showTab("settings");
  openSubpage("sp-story");
});

// ---- Questions people ask (answered by educational videos) --------------------

function renderFaq() {
  const faq = state.status?.settings?.faq ?? [];
  $("#sum-faq").textContent = faq.length ? `${faq.filter((f) => f.a?.trim()).length} of ${faq.length} answered` : "";
  if ($("#faq-list").contains(document.activeElement)) return; // don't rebuild while typing
  $("#faq-list").replaceChildren(
    ...faq.map((f, i) =>
      h("div", { class: "faq-item" },
        h("div", { class: "faq-q" },
          h("textarea", { class: "faq-question", rows: 2, maxlength: 200, onchange: (e) => saveFaq((list) => (list[i].q = e.target.value.replace(/\s+/g, " "))) }, f.q),
          h("button", { class: "d-link", type: "button", onclick: () => saveFaq((list) => list.splice(i, 1)) }, "Remove"),
        ),
        h("textarea", { rows: 3, maxlength: 1500, placeholder: "Your answer, e.g. the exact bag, airline or places",
          onchange: (e) => saveFaq((list) => (list[i].a = e.target.value)) }, f.a ?? ""),
      ),
    ),
  );
}

async function saveFaq(change) {
  const list = (state.status.settings.faq ?? []).map((f) => ({ ...f }));
  change(list);
  state.status.settings = await api("/api/settings", { method: "PUT", body: { faq: list.filter((f) => f.q.trim()) } });
  if (!$("#faq-list").contains(document.activeElement)) renderFaq();
  else $("#sum-faq").textContent = `${state.status.settings.faq.filter((f) => f.a?.trim()).length} of ${state.status.settings.faq.length} answered`;
}

$("#faq-add").addEventListener("click", async () => {
  const q = prompt("The question people ask:");
  if (!q?.trim()) return;
  await saveFaq((list) => list.push({ q: q.trim(), a: "" }));
  renderFaq();
});

// ---- Brand partners -----------------------------------------------------------

async function refreshPartners() {
  state.partners = await api("/api/partners");
  const n = state.partners.length;
  $("#sum-partners").textContent = n ? `${n}` : "";
  const picked = $("#story-form").partnerId.value;
  renderStoryMode();
  $("#story-form").partnerId.value = picked;
  const form = $("#partner-form");
  $("#partners").replaceChildren(
    ...state.partners.map((p) =>
      h("li", {},
        h("div", { class: "grow" },
          h("b", {}, p.name), p.handle ? h("span", { class: "muted" }, ` ${p.handle}`) : null,
          p.about ? h("div", { class: "muted" }, p.about) : null,
          p.mustInclude ? h("div", { class: "muted" }, `Always: ${p.mustInclude}`) : null,
        ),
        h("button", { class: "btn small primary", title: "Picks the clip with the best angle on this brand and makes a collab video from it", onclick: (e) =>
          withBusy(e.currentTarget, "Finding a clip…", async () => {
            const r = await api(`/api/partners/${p.id}/collab`, { method: "POST", body: {} });
            await refreshRenders();
            banner(`Making a ${p.name} video. Picked: ${r.reason} It shows up on Review in a minute or two.`, "ok");
          }) }, "Find a clip & make it"),
        h("button", { class: "btn small", title: "An educational video in this brand's area, with the brand as the practical answer in one point", onclick: (e) =>
          withBusy(e.currentTarget, "Finding a clip…", async () => {
            const r = await api(`/api/partners/${p.id}/educational`, { method: "POST", body: {} });
            await refreshRenders();
            banner(`Making an educational ${p.name} video. Picked: ${r.reason} It shows up on Review in a minute or two.`, "ok");
          }) }, "Educational video"),
        h("button", { class: "btn small", onclick: () => {
          form.partnerId.value = p.id;
          for (const k of ["name", "handle", "about", "mustInclude"]) form[k].value = p[k] ?? "";
          form.name.focus();
        } }, "Edit"),
        h("button", { class: "btn small", onclick: async () => {
          if (!confirm(`Remove ${p.name}? Videos already made stay.`)) return;
          await api(`/api/partners/${p.id}`, { method: "DELETE" });
          refreshPartners();
        } }, "Remove"),
      ),
    ),
  );
}

$("#partner-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  withBusy(f.querySelector("button[type=submit]"), "Saving…", async () => {
    const saved = await api("/api/partners", { method: "POST", body: { id: f.partnerId.value || undefined, ...Object.fromEntries(["name", "handle", "about", "mustInclude"].map((k) => [k, f[k].value])) } });
    f.reset();
    f.partnerId.value = "";
    await refreshPartners();
    banner(
      saved.educationalVideo
        ? `${saved.name} added. An educational video about it is being made now; it shows up on Review in a few minutes.`
        : "Partner saved. Open any video and tap Collab version.",
      "ok",
    );
  });
});

// ---- Shared albums ----------------------------------------------------------

async function refreshAlbums() {
  const albums = await api("/api/albums");
  state.albumCount = albums.length;
  state.albums = albums;
  renderSummaries();
  // Once one album is connected, make it obvious the box adds another rather than replacing it.
  const input = $("#album-form").url;
  input.placeholder = albums.length ? "Paste another shared-album link" : "Paste a shared-album link (photos.google.com/share/… works best)";
  $("#albums").replaceChildren(
    ...albums.map((a, i) =>
      h("li", {},
        h("div", { class: "grow" },
          h("b", {}, a.title || `Album ${i + 1}`), " ",
          h("a", { href: a.url, target: "_blank", rel: "noopener", class: "muted" }, "open"),
          h("div", { class: "muted" },
            `${a.videoCount} video${a.videoCount === 1 ? "" : "s"} imported · `,
            a.lastSyncAt ? `checked ${new Date(a.lastSyncAt).toLocaleString()}` : "reading the album…",
          ),
          h("label", { class: "muted recent" }, "Import ",
            h("select", {
              onchange: async (e) => {
                const select = e.currentTarget;
                select.disabled = true;
                try {
                  await api(`/api/albums/${a.id}`, { method: "PATCH", body: { recentDays: Number(select.value) } });
                  const r = await api(`/api/albums/${a.id}/sync`, { method: "POST" });
                  await Promise.all([refreshAlbums(), refreshClips()]);
                  const now = (state.albums ?? []).find((x) => x.id === a.id);
                  const waiting = now?.waiting ?? 0;
                  banner(
                    r.error ? `Saved, but reading the album failed: ${r.error}`
                    : r.newItems ? `Importing ${r.newItems} video(s) now${waiting ? `; ${waiting} more follow (up to 150 a day)` : ""}.`
                    : waiting ? `Saved. ${waiting} video(s) are now in range; they're being imported (up to 150 a day).`
                    : "Saved. No new videos in that range.",
                    r.error ? undefined : "ok",
                  );
                } finally {
                  select.disabled = false;
                }
              },
            }, ...[[30, "videos from the last 30 days"], [60, "videos from the last 60 days"], [90, "videos from the last 90 days"], [120, "videos from the last 120 days"], [180, "videos from the last 180 days"], [0, "all videos"]].map(([v, t]) =>
              h("option", { value: v, selected: (a.recentDays ?? 0) === v }, t))),
          ),
          a.itemsSeen ? h("div", { class: "muted" },
            a.listingComplete === false
              ? `Sees the newest ${a.itemsSeen} items only: Google wouldn't load the rest of this big album${a.listingError ? ` (${a.listingError})` : ""}.`
              : `${a.itemsSeen} items in the album.`) : null,
          a.tooOld || a.waiting ? h("div", { class: "muted" },
            [a.reachedBack ? `${a.reachedBack} older video(s) brought in because the date range was used up` : "", a.tooOld ? `${a.tooOld} older item(s) not imported yet; more come in when the date range runs out` : "", a.waiting ? `${a.waiting} more being imported (up to 150 a day)${a.importPaused ? `, on hold: ${a.importPaused}` : ""}` : ""].filter(Boolean).join(" · ")) : null,
          a.lastError ? h("div", { class: "err" }, a.lastError) : null,
          a.skipped && Object.keys(a.skipped).length
            ? h("div", { class: "muted", title: "What Google returned for items that weren't recognized as videos" },
                `Skipped ${Object.values(a.skipped).reduce((x, y) => x + y, 0)} item(s) as not video: `,
                Object.entries(a.skipped).map(([k, n]) => `${k} ×${n}`).join(" · "))
            : null,
        ),
        h("button", {
          class: "btn small",
          onclick: (e) => withBusy(e.currentTarget, "Checking…", async () => {
            const r = await api(`/api/albums/${a.id}/sync`, { method: "POST" });
            banner(r.newItems ? `Found ${r.newItems} new item(s). Importing videos…` : "No new items in this album.", "ok");
            await Promise.all([refreshAlbums(), refreshClips()]);
          }),
        }, "Check now"),
        h("button", {
          class: "btn small",
          onclick: async () => {
            if (!confirm("Stop watching this album? Imported videos stay in your library.")) return;
            await api(`/api/albums/${a.id}`, { method: "DELETE" });
            refreshAlbums();
          },
        }, "Remove"),
      ),
    ),
  );
}

/** Add an album. It's saved straight away; if Google is slow to answer, reading it carries on in the background. */
async function addAlbum(form, busyLabel) {
  if (!form.url.value.trim()) {
    form.url.focus();
    return banner("Paste the album's share link first.");
  }
  await withBusy(form.querySelector("button"), busyLabel, async () => {
    const r = await api("/api/albums", { method: "POST", body: { url: form.url.value } });
    form.reset();
    await Promise.all([refreshAlbums(), refreshClips()]);
    const n = state.albumCount;
    const name = `“${r.album.title || "album"}”${n > 1 ? `, now watching ${n} albums` : ""}`;
    if (r.error) banner(`Added ${name}, but reading it failed: ${r.error}`);
    else if (r.pending) banner(`Added ${name}. Google is slow to answer; it keeps reading the album in the background.`, "ok");
    else banner(`Added ${name}. ${r.newItems} item(s) found; videos are importing now.`, "ok");
    // Pick up the result of a check that's still running.
    if (r.pending) for (const ms of [15_000, 45_000, 90_000]) setTimeout(() => Promise.all([refreshAlbums(), refreshClips()]).catch(() => {}), ms);
    renderHomeState();
  });
}

$("#album-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addAlbum(e.currentTarget, "Adding…");
});

// ---- Daily batch --------------------------------------------------------------

async function loadAuto() {
  const a = (state.auto = await api("/api/auto"));
  renderSummaries();
  const f = $("#auto");
  f.enabled.checked = a.enabled;
  f.dailyTime.value = a.dailyTime;
  f.dailyCount.value = a.dailyCount;
  f.targetSeconds.value = String(a.targetSeconds);
  if (![...f.targetSeconds.options].some((o) => o.value === String(a.targetSeconds))) f.targetSeconds.append(h("option", { value: a.targetSeconds }, `${a.targetSeconds}s`)), (f.targetSeconds.value = String(a.targetSeconds));
  f.template.value = a.template;
  f.syncEveryHours.value = String(a.syncEveryHours);
}

$("#daily-mix").addEventListener("change", async () => {
  const f = $("#daily-mix");
  const mix = Object.fromEntries(["fun", "educational", "inspirational"].map((k) => [k, Number(f.querySelector(`[name=${k}]`).value) || 0]));
  state.status.settings = await api("/api/settings", { method: "PUT", body: { dailyMix: mix } });
  await loadAuto();
  loadStatus().catch(() => {});
});

$("#auto").addEventListener("change", async (e) => {
  const f = e.currentTarget;
  state.auto = await api("/api/auto", {
    method: "PUT",
    body: {
      enabled: f.enabled.checked,
      dailyTime: f.dailyTime.value,
      dailyCount: Number(f.dailyCount.value),
      targetSeconds: Number(f.targetSeconds.value),
      template: f.template.value,
      syncEveryHours: Number(f.syncEveryHours.value),
    },
  });
  renderSummaries();
});

$("#btn-batch-empty").addEventListener("click", () => $("#btn-batch").click());
$("#btn-batch").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Starting…", async () => {
    // The round runs on the server; show its progress instead of waiting on this request.
    state.nextRoundUntil = Date.now() + 6 * 60_000;
    state.roundStartedAt = new Date().toISOString();
    const req = api("/api/batch/run", { method: "POST" });
    setTimeout(() => loadStatus().then(renderHomeState).catch(() => {}), 1500);
    const r = await req.catch((err) => {
      // Already being made: just show its progress.
      if (/already being made/.test(err.message)) return { renders: [], already: true };
      state.nextRoundUntil = 0;
      throw err;
    });
    if (r.skipped === "daily video limit reached") banner("That's today's video limit, plus 3 extra. Raise it in Settings → Schedule & limits for more.");
    else if (r.skipped) banner(`Nothing new was started: ${r.skipped}.`);
    else if (r.warning) banner(r.warning);
    else if (r.renders.length) banner(`Making ${r.renders.length} video${r.renders.length === 1 ? "" : "s"}. They appear here as they finish.`, "ok");
    await Promise.all([refreshRenders(), loadStatus()]);
    renderHomeState();
  }),
);


const batchEls = new Map();
function latestBatch() {
  return [...new Set(state.renders.map((r) => r.batch).filter(Boolean))].sort().reverse()[0];
}

/** Ready tab filter: all kept videos, or one kind. */
const READY_KINDS = [["all", "All"], ["tips", "Edu"], ["fun", "Fun"], ["inspire", "Inspo"], ["other", "Other"]];
let readyKind = "all";
try {
  readyKind = localStorage.getItem("readyKind") || "all";
} catch {}
const kindOfRender = (r) => (["tips", "fun", "inspire"].includes(r.plan.format) ? r.plan.format : "other");

function renderBatch() {
  // Ready tab: every kept video, newest first, filtered by kind.
  const allKept = state.renders.filter((r) => r.status === "done" && r.review === "approved").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts = Object.fromEntries(READY_KINDS.map(([k]) => [k, k === "all" ? allKept.length : allKept.filter((r) => kindOfRender(r) === k).length]));
  if (readyKind !== "all" && !counts[readyKind]) readyKind = "all";
  $("#ready-filter").hidden = allKept.length === 0;
  $("#ready-filter").replaceChildren(
    ...READY_KINDS.filter(([k]) => k === "all" || counts[k]).map(([k, label]) =>
      h("button", {
        type: "button",
        class: `kind-chip${readyKind === k ? " on" : ""}`,
        role: "tab",
        "aria-selected": readyKind === k ? "true" : "false",
        onclick: () => {
          readyKind = k;
          try {
            localStorage.setItem("readyKind", k);
          } catch {}
          renderBatch();
        },
      }, `${label} ${counts[k]}`),
    ),
  );
  const kept = readyKind === "all" ? allKept : allKept.filter((r) => kindOfRender(r) === readyKind);
  $("#ready-empty").hidden = allKept.length > 0;
  const unsaved = allKept.filter((r) => !r.downloaded).length;
  $("#ready-count").hidden = !unsaved;
  $("#ready-count").textContent = String(unsaved);
  $("#batch").replaceChildren(
    ...kept.map((r) => {
      const key = `${r.id}:${r.status}:${r.review}:${r.downloaded}`;
      const cached = batchEls.get(r.id);
      if (cached?.key === key) return cached.node;
      const node = tile(r);
      batchEls.set(r.id, { key, node });
      return node;
    }),
  );
  const n = toReview().length;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("#batch-date").textContent = n ? `${today} · ${n} to review` : today;
}

function reviewCard(r) {
  const media =
    r.status === "done"
      ? h("video", { src: playable(`/media/render/${r.id}.mp4`), poster: `/media/render/${r.id}.jpg`, controls: true, loop: true, playsinline: true, preload: "none" })
      : h("div", { class: "ph" },
          h("div", {},
            r.status === "error" ? "Couldn't make this one" : r.status === "queued" ? "Waiting…" : `Making… ${Math.round(r.progress * 100)}%`,
            r.status === "rendering" ? h("div", { class: "bar" }, h("i", { style: { width: `${r.progress * 100}%` } })) : null,
          ),
        );
  const texts = r.plan.overlays?.length ? r.plan.overlays.map((o) => o.text) : [r.plan.hook];
  const update = h("button", { class: "btn small", hidden: true, title: "Make the video again with this text" }, "Update");
  const overlayInputs = texts.map((t) => h("input", { value: t, oninput: () => (update.hidden = false) }));
  update.addEventListener("click", (e) =>
    withBusy(e.currentTarget, "…", async () => {
      await api(`/api/renders/${r.id}/rerender`, {
        method: "POST",
        body: { overlays: overlayInputs.map((i) => i.value) },
      });
      await refreshRenders();
    }),
  );
  const captionText = [r.plan.postCaption, r.plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  const caption = h("textarea", { rows: 3 }, captionText);
  const saveCaption = async () => {
    const tags = caption.value.match(/#[\w\u00C0-\uFFFF]+/g) ?? [];
    const text = caption.value.replace(/(^|\s)#[\w\u00C0-\uFFFF]+/g, "").trim();
    await api(`/api/renders/${r.id}`, { method: "PATCH", body: { postCaption: text, hashtags: tags } });
    r.plan.postCaption = text;
    r.plan.hashtags = tags.map((t) => t.slice(1));
  };
  caption.addEventListener("change", saveCaption);
  const setReview = async (review) => {
    await saveCaption();
    await api(`/api/renders/${r.id}`, { method: "PATCH", body: { review } });
    await refreshRenders();
  };
  const done = r.status === "done";
  return h("div", { class: `render ${r.review}` },
    media,
    h("div", { class: "body" },
      r.status === "error"
        ? h("div", { class: "err-box" },
            h("span", {}, r.error || "Something went wrong."),
            h("button", {
              class: "btn small",
              onclick: (e) => withBusy(e.currentTarget, "…", async () => {
                await api(`/api/renders/${r.id}/retry`, { method: "POST" });
                await refreshRenders();
              }),
            }, "Try again"),
          )
        : null,
      sourceLine(r.plan),
      h("span", { class: "field-label" }, "Text on video"),
      ...overlayInputs.map((inp) => h("div", { class: "overlay-edit" }, inp)),
      update,
      h("span", { class: "field-label with-action" }, "Caption",
        h("button", {
          class: "link-btn",
          onclick: async (e) => {
            await navigator.clipboard.writeText(caption.value);
            e.target.textContent = "Copied ✓";
            setTimeout(() => (e.target.textContent = "Copy"), 1500);
          },
        }, "Copy"),
      ),
      caption,
      basedOnLine(r.plan),
      h("div", { class: "card-actions" },
        r.review === "rejected"
          ? [
              h("span", { class: "muted grow" }, `Rejected${r.rejectReason && r.rejectReason !== "other" ? ` · ${REASON_LABEL[r.rejectReason]}` : ""}`),
              h("button", { class: "btn small", onclick: () => setReview("pending") }, "Undo"),
            ]
          : [
              done
                ? h("a", {
                    class: `btn primary grow ${r.downloaded ? "done" : ""}`,
                    href: `/media/render/${r.id}.mp4?dl=1`,
                    onclick: () => api(`/api/renders/${r.id}`, { method: "PATCH", body: { downloaded: true, ...(r.review === "pending" ? { review: "approved" } : {}) } }).then(refreshRenders),
                  }, r.downloaded ? "Downloaded ✓" : r.review === "approved" ? "Kept · Download" : "Download")
                : null,
              h("button", { class: "btn quiet-btn", title: "Don't post this one", onclick: () => setReview("rejected") }, "Reject"),
            ],
      ),
    ),
  );
}

// ---- Clip preview -----------------------------------------------------------

/** Swap a clip card's thumbnail for the playing video. */
function playClip(card, clipId) {
  const wrap = card?.querySelector(".thumb-wrap");
  if (!wrap || card.classList.contains("playing")) return;
  card.classList.add("playing");
  wrap.replaceChildren(h("video", { class: "thumb", src: playable(`/media/clip/${clipId}`), poster: `/media/thumb/${clipId}`, controls: true, autoplay: true, playsinline: true }));
}

/** Jump to a clip on the Clips tab and play it. */
/** Play a source clip on top of the current page. */
function openClip(clipId) {
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return banner("That clip is no longer in your library.");
  const sheet = $("#sheet");
  sheet.replaceChildren(
    h("div", { class: "sheet-card" },
      h("button", { class: "sheet-close", "aria-label": "Close", onclick: closeSheet }, "✕"),
      h("div", { class: "sheet-media" }, h("video", { src: playable(`/media/clip/${clipId}`), poster: `/media/thumb/${clipId}`, controls: true, autoplay: true, playsinline: true })),
      h("div", { class: "body" }, h("b", {}, "Original clip"), h("span", { class: "muted" }, [clip.scene, clip.capturedAt?.slice(0, 10)].filter(Boolean).join(" · "))),
    ),
  );
  sheet.hidden = false;
  document.body.classList.add("no-scroll");
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** "Made from" line on a video card: which clip, which situation, which seconds. */
function sourceLine(plan) {
  const seg = plan.segments?.[0];
  if (!seg) return null;
  const clip = state.clips.find((c) => c.id === seg.clipId);
  const more = new Set(plan.segments.map((s) => s.clipId)).size - 1;
  return h("button", { class: "source", title: "Play the original clip", onclick: () => openClip(seg.clipId) },
    h("img", { src: `/media/thumb/${seg.clipId}`, alt: "", loading: "lazy" }),
    h("span", {}, "Made from ", h("b", {}, plan.scene || clip?.scene || "your clip"),
      ` · ${mmss(seg.start)}–${mmss(seg.end)}${more > 0 ? ` + ${more} more` : ""}`),
  );
}

// ---- Suggestions ------------------------------------------------------------

async function makeFromClip(btn, clipId) {
  return withBusy(btn, "Creating…", async () => {
    const r = await api("/api/generate", { method: "POST", body: { template: "auto", count: 1, clipIds: [clipId], useAi: true, batch: "today" } });
    if (r.warning) banner(r.warning);
    else banner("Making your video. It appears under Videos in a minute or two.", "ok");
    await Promise.all([refreshRenders(), refreshSuggestions()]);
  });
}

async function refreshSuggestions() {
  const list = await api("/api/suggestions");
  $("#suggestions-empty").hidden = list.length > 0 || state.clips.length === 0;
  $("#suggestions").replaceChildren(
    ...list.map((sg) =>
      h("div", { class: "sugg", title: sg.summary || "" },
        h("img", { src: `/media/thumb/${sg.clipId}`, alt: "", loading: "lazy", title: "Play", onclick: () => openClip(sg.clipId) }),
        h("div", { class: "body" },
          h("span", { class: "scene-tag" }, sg.scene || "unsorted"),
          sg.caption
            ? h("span", { class: "cap" }, `“${sg.caption.text}”`, sg.caption.views ? [" · ", h("b", {}, `${fmtViews(sg.caption.views)} views`)] : null)
            : h("span", { class: "cap" }, sg.note ? sg.note : "Caption will be written from the footage"),
          h("button", { class: "btn small primary", onclick: (e) => makeFromClip(e.currentTarget, sg.clipId) }, "Create"),
        ),
      ),
    ),
  );
}

// ---- Situations & proven captions -------------------------------------------

const fmtViews = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function basedOnLine(plan) {
  const b = plan.basedOn;
  if (!b) return null;
  return h("div", { class: "based", title: plan.scene ? `Situation: ${plan.scene}` : "" },
    `Inspired by “${b.text}”`,
    b.views ? ` · ${fmtViews(b.views)} views` : "",
    b.url ? [" · ", h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, "source")] : null,
  );
}

const openScenes = new Set();
async function refreshScenes() {
  const list = await api("/api/scenes");
  $("#research-source").textContent = state.status?.tiktokSearch
    ? "Captions come from TikTok search (via Apify): the most-viewed videos for each situation, with real view counts."
    : "Captions come only from TikTok search via Apify, and Apify isn't connected yet: add APIFY_TOKEN on Render.";
  $("#scenes").replaceChildren(
    ...list.map((s) => {
      const r = s.research;
      const caps = r?.captions ?? [];
      const status = s.scene === "other"
        ? "clips that don't fit a situation"
        : r?.updatedAt
          ? `${caps.length} proven caption${caps.length === 1 ? "" : "s"} · ${r.source === "tiktok" ? `searched on TikTok ${new Date(r.updatedAt).toLocaleDateString()}` : "old web results, not used; search TikTok again"}`
          : caps.length ? `${caps.length} caption(s) you added · not researched yet` : "not researched yet";
      const details = h("details", { class: "scene", open: openScenes.has(s.scene), ontoggle: (e) => (e.target.open ? openScenes.add(s.scene) : openScenes.delete(s.scene)) },
        h("summary", {},
          h("b", {}, s.scene),
          h("span", { class: "muted grow" }, `${s.clips} clip${s.clips === 1 ? "" : "s"} (${s.unused} unused) · ${status}`),
          s.scene === "other" ? null : h("button", {
            class: "btn small",
            disabled: !state.status?.claude.enabled,
            title: state.status?.claude.enabled ? "Search TikTok for captions in this situation with lots of views (~1–2 min)" : "Needs ANTHROPIC_API_KEY",
            onclick: (e) => {
              e.preventDefault();
              withBusy(e.currentTarget, "Searching TikTok…", async () => {
                await api(`/api/scenes/${encodeURIComponent(s.scene)}/research`, { method: "POST" });
                openScenes.add(s.scene);
                await refreshScenes();
              });
            },
          }, r?.updatedAt ? "Research again" : "Research TikTok"),
          s.scene === "other" ? null : h("button", {
            class: "btn small",
            title: "Remove this situation",
            onclick: async (e) => {
              e.preventDefault();
              if (!confirm(`Remove “${s.scene}”? Its clips move to "other"; researched captions are kept.`)) return;
              const scenes = state.status.settings.scenes.filter((x) => x !== s.scene);
              state.status.settings = await api("/api/scenes", { method: "PUT", body: { scenes } });
              await refreshScenes();
              renderClips();
            },
          }, "×"),
        ),
        r?.error ? h("div", { class: "err" }, `Last research failed: ${r.error}`) : null,
        s.scene === "other" || !(r?.hashtags?.length || r?.hashtagNote) ? null : h("p", { class: "tags" },
          h("b", {}, "Hashtags: "),
          (r.hashtags ?? []).map((t) => h("span", { class: "tag", title: `${t.tier} tag` }, `#${t.tag} `, h("span", { class: "muted" }, `${fmtViews(t.posts)} posts`))),
          r.hashtagNote ? h("span", { class: "muted" }, ` ${r.hashtagNote}`) : null,
        ),
        s.scene === "other" ? null : h("ul", { class: "caps" },
          caps.length ? caps.map((c) =>
            h("li", {},
              h("span", { class: "v" }, c.views ? fmtViews(c.views) : "–"),
              h("span", { class: "t" }, `“${c.text}”`, " ",
                h("span", { class: "muted" }, c.kind === "creator" ? "· added by you" : `· ${c.kind}`),
                c.note ? h("span", { class: "muted" }, ` · ${c.note}`) : null,
                c.url ? [" · ", h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", class: "muted" }, "source")] : null,
              ),
              h("button", {
                class: "btn small", title: "Don't use this caption",
                onclick: async () => {
                  await api(`/api/scenes/${encodeURIComponent(s.scene)}/captions/${c.id}`, { method: "DELETE" });
                  refreshScenes();
                },
              }, "×"),
            ),
          ) : h("li", { class: "muted" }, "No captions yet."),
        ),
        s.scene === "other" ? null : h("form", {
          class: "cap-form",
          onsubmit: async (e) => {
            e.preventDefault();
            const f = e.currentTarget;
            await api(`/api/scenes/${encodeURIComponent(s.scene)}/captions`, {
              method: "POST",
              body: { text: f.text.value, views: f.views.value, url: f.url.value },
            });
            openScenes.add(s.scene);
            refreshScenes();
          },
        },
          h("input", { name: "text", placeholder: "A caption you found that did well", required: true, maxlength: 200 }),
          h("input", { name: "views", placeholder: "Views", inputmode: "numeric" }),
          h("input", { name: "url", placeholder: "TikTok link (optional)", type: "url" }),
          h("button", { class: "btn small", type: "submit" }, "Add"),
        ),
      );
      return details;
    }),
  );
}

$("#scene-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.currentTarget.scene.value.trim();
  if (!name) return;
  state.status.settings = await api("/api/scenes", { method: "PUT", body: { scenes: [...state.status.settings.scenes, name] } });
  e.currentTarget.reset();
  await refreshScenes();
  renderClips();
});

// ---- Text look (fonts) ------------------------------------------------------

const loadedFonts = new Set();
function fontFamily(f) {
  const fam = `pc-${f.id.replace(/[^\w-]/g, "_")}`;
  if (!loadedFonts.has(fam)) {
    loadedFonts.add(fam);
    new FontFace(fam, `url(/media/font/${encodeURIComponent(f.id)})`).load().then((ff) => document.fonts.add(ff)).catch(() => {});
  }
  return fam;
}

async function loadFonts() {
  const fonts = await api("/api/fonts");
  const { fontId, textStyle, textSize = "medium", petName } = state.status.settings;
  // The highlight look turns one word yellow (the server picks the same kind of word).
  $("#look-sample").replaceChildren(`POV: the energy shift when ${petName || "Lex"} realizes we're at the `, h("b", { class: "kw" }, "airport"));
  if (!$("#text-style").childElementCount) $("#text-style").append(...styleTiles("textStyle", textStyle, () => {}));
  const current = fonts.find((f) => f.id === fontId) ?? fonts.find((f) => f.id === "tiktok-sans");
  $("#look-sample").style.fontFamily = `"${fontFamily(current)}"`;
  $("#look-preview").className = `look-preview ${textStyle} size-${textSize}`;
  for (const r of document.querySelectorAll("#text-style input")) r.checked = r.value === textStyle;
  for (const r of document.querySelectorAll("#text-size input")) r.checked = r.value === textSize;
  renderSummaries();
  // Font names in the dropdown are shown in their own typeface where the browser supports it.
  $("#font-select").replaceChildren(
    ...fonts.map((f) =>
      h("option", { value: f.id, selected: f.id === current?.id, style: { fontFamily: `"${fontFamily(f)}", sans-serif` } }, `${f.name} — ${f.vibe}`),
    ),
  );
}

$("#font-select").addEventListener("change", async (e) => {
  state.status.settings = await api("/api/settings", { method: "PUT", body: { fontId: e.target.value } });
  loadFonts();
});

$("#text-size").addEventListener("change", async (e) => {
  state.status.settings = await api("/api/settings", { method: "PUT", body: { textSize: e.target.value } });
  loadFonts();
});

$("#text-style").addEventListener("change", async (e) => {
  state.status.settings = await api("/api/settings", { method: "PUT", body: { textStyle: e.target.value } });
  loadFonts();
});

$("#font-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  try {
    await api("/api/fonts", { method: "POST", body: fd });
    state.status.settings = (await api("/api/status")).settings;
    await loadFonts();
    banner(`Added ${f.name} and selected it.`, "ok");
  } catch (err) {
    banner(err.message);
  }
  e.target.value = "";
});

// ---- Examples that worked ---------------------------------------------------

async function refreshExamples() {
  const list = await api("/api/examples");
  state.examplesBusy = list.some((e) => e.status === "analyzing");
  $("#examples").replaceChildren(
    ...list.map((e) =>
      h("div", { class: "example" },
        e.duration ? h("img", { src: `/media/example/${e.id}.jpg`, alt: "" }) : h("div", { class: "noimg" }),
        h("div", {},
          h("b", {}, `“${e.overlayText || e.analysis?.overlayText || (e.status === "analyzing" ? "reading…" : "no overlay text")}”`),
          e.views ? h("div", { class: "muted" }, `${e.views.toLocaleString()} views`) : null,
          e.analysis ? h("div", {}, e.analysis.whyItWorks) : null,
          e.note ? h("div", { class: "muted" }, e.note) : null,
          e.status === "error" ? h("div", { class: "err" }, e.error) : null,
          h("button", {
            class: "btn small x",
            onclick: async () => {
              await api(`/api/examples/${e.id}`, { method: "DELETE" });
              refreshExamples();
            },
          }, "Remove"),
        ),
      ),
    ),
  );
}

$("#example-form").file.addEventListener("change", (e) => ($("#example-file").textContent = e.target.files[0]?.name || "optional"));
$("#example-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector("button[type=submit]"), "Adding…", async () => {
    await api("/api/examples", { method: "POST", body: new FormData(form) });
    form.reset();
    $("#example-file").textContent = "optional";
    await refreshExamples();
  });
});

// ---- Diagnostics --------------------------------------------------------------

$("#btn-refresh-design").addEventListener("click", async () => {
  if (!confirm("Re-make every video waiting for review or in Ready with the current look?\n\nSame footage and music, the current design, and any text that doesn't add up is fixed. Takes a minute or two per video.")) return;
  try {
    await api("/api/videos/refresh-design", { method: "POST" });
    banner("Re-making your videos with the current look. They come back one by one.", "ok");
  } catch (err) {
    banner(err.message);
  }
});

$("#btn-clear-videos").addEventListener("click", async () => {
  if (!confirm("Delete all videos?\n\nEvery video (to review and in Ready) is removed. Your clips stay and can all be used again, and what the AI learned from your reviews is kept. New videos are made right after.")) return;
  try {
    await api("/api/videos/clear", { method: "POST", body: { confirm: "delete videos" } });
  } catch (err) {
    return banner(err.message);
  }
  location.reload();
});

$("#btn-reset").addEventListener("click", async () => {
  const ok = confirm(
    "Start over?\n\nThis permanently removes all your albums, every imported clip and every video (to review and ready to post). " +
    "Your settings, situations, TikTok caption research and spending history are kept.\n\nYou can then add your albums again.",
  );
  if (!ok) return;
  try {
    await api("/api/reset", { method: "POST", body: { confirm: "start over" } });
  } catch (err) {
    return banner(err.message);
  }
  location.reload();
});

$("#btn-diag").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Copying…", async () => {
    const d = await api("/api/diagnostics");
    const text = JSON.stringify(d, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      banner("Diagnostics copied. Paste them into the chat.", "ok");
    } catch {
      // Clipboard can be blocked; fall back to a download.
      const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "lex-studio-diagnostics.txt" });
      a.click();
    }
  }),
);

// ---- Budget & recovery ------------------------------------------------------

$("#budget-form").addEventListener("change", async (e) => {
  await api("/api/settings", { method: "PUT", body: { aiMonthlyBudget: Number(e.currentTarget.aiMonthlyBudget.value) } });
  await loadStatus();
  banner("Monthly AI limit saved.", "ok");
});
$("#budget-form").addEventListener("submit", (e) => e.preventDefault());
$("#bandwidth-form").addEventListener("change", async (e) => {
  await api("/api/settings", { method: "PUT", body: { bandwidthGb: Number(e.currentTarget.bandwidthGb.value) } });
  await loadStatus();
  playable.told = false;
  await refreshRenders();
  banner("Bandwidth limit saved.", "ok");
});
$("#bandwidth-form").addEventListener("submit", (e) => e.preventDefault());

$("#btn-resume").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "…", async () => {
    await api("/api/resume", { method: "POST" });
    await loadStatus();
    banner("Resumed. Interrupted work is being picked up again.", "ok");
  }),
);

// ---- Onboarding & activity ---------------------------------------------------

/** A single progress bar for the round being made; the videos themselves stay hidden until done. */
function renderMaking(planning, importing = 0) {
  const busy = state.renders.filter(inProgress);
  const box = $("#making");
  // Only once there's nothing left to swipe: then it says "more are on the way".
  box.hidden = (!busy.length && !planning && !importing) || toReview().length > 0 || !!stack.whyFor;
  if (box.hidden) return;
  const n = busy.length;
  if (!n && !planning) {
    // Clips go one at a time (~30–60 s each); the first videos start once 3 are sorted.
    const today = new Date().toDateString();
    const doneToday = state.clips.filter((c) => c.status !== "importing" && c.status !== "analyzing" && new Date(c.importedAt).toDateString() === today).length;
    const total = doneToday + importing;
    const pctImport = total ? Math.round((doneToday / total) * 100) : 0;
    $("#making-title").textContent = `Importing clips: ${doneToday} of ${total} done`;
    box.classList.toggle("indeterminate", pctImport === 0);
    $("#making-fill").style.width = `${Math.max(4, pctImport)}%`;
    $("#making-sub").textContent = `About ${Math.max(1, Math.round(importing * 0.75))} min left. The first videos start as soon as 3 clips are sorted into your situations.`;
    return;
  }
  const pct = n ? Math.round((busy.reduce((sum, r) => sum + (r.status === "rendering" ? r.progress : 0), 0) / n) * 100) : 0;
  $("#making-title").textContent = n ? `Making ${n} new video${n === 1 ? "" : "s"}…` : "Getting the next videos ready…";
  box.classList.toggle("indeterminate", !n || pct === 0);
  $("#making-fill").style.width = `${Math.max(4, pct)}%`;
  $("#making-sub").textContent = n
    ? `${pct ? `${pct}% · ` : ""}They'll appear here when they're finished. You can leave this page.`
    : state.status?.roundStage || "Picking clips and writing the text (1–3 min).";
}

/** A small pill at the top that fades out on its own. */
function toast(text, iconName) {
  const el = $("#activity");
  el.innerHTML = iconName ? icon(iconName) : "";
  el.append(text);
  el.hidden = false;
  el.classList.remove("out");
  clearTimeout(toast.t1);
  clearTimeout(toast.t2);
  toast.t1 = setTimeout(() => el.classList.add("out"), 3500);
  toast.t2 = setTimeout(() => (el.hidden = true), 4000);
}

function renderHomeState() {
  const noSource = state.albumCount === 0 && state.clips.length === 0;
  $("#onboard").hidden = !noSource;
  const importing = state.clips.filter((c) => c.status === "importing" || c.status === "analyzing").length;
  const making = state.renders.filter(inProgress).length;
  const reviewing = toReview().length > 0 || !!stack.whyFor;
  const planning = !making && (state.nextRoundUntil > Date.now() || !!state.status?.roundStage);
  renderMaking(planning, importing);
  // Nothing new can start while a round is being made or reviewed.
  $("#btn-batch").hidden = noSource || making > 0 || planning || reviewing;
  // While swiping, new imports only get a small pill that fades away by itself.
  if (importing > (state.lastImporting ?? 0) && reviewing) toast(`${importing} new clip${importing === 1 ? "" : "s"} importing`, "download");
  state.lastImporting = importing;

  // Nothing to review and nothing being made: say what's next.
  $("#batch-empty").hidden = noSource || reviewing || making > 0 || planning || importing > 0;
  const vt = state.status?.videosToday;
  const atLimit = vt && vt.made >= vt.limit;
  const keptCount = state.renders.filter((r) => r.status === "done" && r.review === "approved" && !r.downloaded).length;
  // Only clips a round can actually use (same rules as the server): unused, not already an edit or
  // a duplicate, and, with "only my situations" on, sorted into one of them.
  const st = state.status?.settings;
  const strict = st?.onlySituations && state.status?.claude?.enabled;
  const fresh = state.clips.filter((c) => c.status === "ready" && c.height >= c.width && !c.disliked && !c.edited && !c.duplicateOf && !c.uses);
  const readyClips = fresh.filter((c) => !strict || (c.scene && st.scenes.includes(c.scene)));
  const unsorted = strict ? fresh.filter((c) => !c.scene).length : 0;
  const n = readyClips.length;
  const time = state.auto?.dailyTime ?? "08:00";
  const caughtUp = vt?.made > 0;
  $("#batch-empty-title").textContent = caughtUp ? "All caught up" : n ? `${n} clip${n === 1 ? "" : "s"} ready to turn into videos` : "No videos yet";
  $("#batch-empty-text").textContent = atLimit
    ? `That's today's ${vt.limit} videos. The next round comes tomorrow at ${time}.${keptCount ? " Your videos to post are in Ready." : ""}`
    : n
      ? `${caughtUp ? "" : `Videos are made every morning at ${time}. `}Want ${caughtUp ? "more" : "them now"}? Make the next round.`
      : importing
        ? "Your clips are being imported. Videos will follow."
        : unsorted
          ? `${unsorted} clip${unsorted === 1 ? " is" : "s are"} still being sorted into your situations.`
          : outOfClipsText(strict, st);
  // The day's set: one of each kind kept, and the day is done.
  const mix = st?.dailyMix;
  const dayKinds = mix ? [["fun", mix.fun], ["tips", mix.educational], ["inspire", mix.inspirational]].filter(([, k]) => k > 0).map(([k]) => k) : [];
  const todayStr = new Date().toDateString();
  const keptKinds = new Set(state.renders.filter((r) => r.review === "approved" && r.reviewedAt && new Date(r.reviewedAt).toDateString() === todayStr).map((r) => r.plan.format));
  const setDone = dayKinds.length > 0 && dayKinds.every((k) => keptKinds.has(k));
  if (setDone) {
    $("#batch-empty-title").textContent = "Today's set is done";
    $("#batch-empty-text").textContent = `One of each kept. The next ones are made after midnight, ready in the morning.${keptCount ? " Your videos to post are in Ready." : ""}`;
  }
  $("#btn-batch-empty").hidden = !n || atLimit || setDone;
  $("#btn-batch-empty").textContent = "Make the next ones";
  $("#btn-batch").hidden ||= !$("#batch-empty").hidden;
  $("#ready-strip").hidden = caughtUp;
  $("#ready-strip").replaceChildren(
    ...readyClips.slice(0, 8).map((c) => h("img", { src: `/media/thumb/${c.id}`, alt: "", title: c.scene || c.filename, loading: "lazy" })),
  );
}

$("#onboard-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addAlbum(e.currentTarget, "Connecting…");
});

// ---- Tabs -------------------------------------------------------------------

const TABS = ["review", "ready", "settings"];
function showTab(name) {
  if (["captions", "style", "clips"].includes(name)) {
    name = "settings";
    if (location.hash === "#clips") setTimeout(() => openSubpage("sp-clips"));
  }
  if (!TABS.includes(name)) name = "review";
  for (const sec of document.querySelectorAll("main > section[data-tab]")) sec.hidden = sec.dataset.tab !== name;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  window.scrollTo(0, 0);
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

// ---- Boot & polling ---------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.get("google") === "connected") banner("Google Photos connected. Now pick the clips you want to use.", "ok");
if (params.get("google_error")) banner(`Google sign-in failed: ${params.get("google_error")}`);
if (params.size) history.replaceState(null, "", `/${location.hash}`);

// ---- Onboarding ----------------------------------------------------------------------------
// New creators, story-style: full-screen, image first, using their own footage as soon as it's in.
// It tells the story (the camera roll nobody sees, why people don't post), asks one question
// (what holds you back), then explains how Rollcut works WHILE it does it: watching their clips,
// suggesting topics, making their first video. The free trial comes after that first video
// (test mode: nothing is charged).

const ONB_STEPS = ["roll", "why", "answer", "photos", "watch", "topics", "look", "making", "trial", "ready"];
const onb = { step: "roll", topics: [], picked: new Set(), blocks: new Set(), timer: 0, waited: 0 };
const onbEl = () => document.getElementById("onboarding");
const BLOCKS = [
  ["words", "I don't know what to say", "It writes the words, from openings that already got views on TikTok."],
  ["editing", "Editing takes forever", "It edits for you: the best seconds of each clip, a new shot every 2 seconds."],
  ["shy", "I'm shy about posting", "Nothing goes out without your ✓. You pick what's worth sharing."],
  ["what-works", "I don't know what works", "It learns from what gets views, on your posts and across TikTok."],
  ["time", "I don't have time", "New videos every morning. Two minutes to pick, save and post."],
];
const fmtBig = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function openOnboarding() {
  try { const saved = localStorage.getItem("rollcut.onbStep"); if (ONB_STEPS.includes(saved)) onb.step = saved; } catch {}
  onbEl().hidden = false;
  document.body.classList.add("no-scroll");
  onbGo(onb.step);
}
function closeOnboarding() {
  clearInterval(onb.timer);
  clearTimeout(onb.timer);
  onbEl().hidden = true;
  onbEl().replaceChildren();
  document.body.classList.remove("no-scroll");
  try { localStorage.removeItem("rollcut.onbStep"); } catch {}
}
async function onbGo(step) {
  onb.step = step;
  try { localStorage.setItem("rollcut.onbStep", step); } catch {}
  clearInterval(onb.timer);
  clearTimeout(onb.timer);
  const st = await api("/api/onboarding").catch(() => null);
  onbRender(st);
}
const onbNext = () => onbGo(ONB_STEPS[ONB_STEPS.indexOf(onb.step) + 1]);

/** One screen: the visual on top (most of the screen), the words and the action below. */
function onbScreen({ visual, kicker, title, sub, body, cta, skip, dark = true }) {
  const i = ONB_STEPS.indexOf(onb.step);
  return h("div", { class: `onb-screen${dark ? " dark" : ""}` },
    h("div", { class: "onb-bars" }, ONB_STEPS.slice(0, -1).map((_, j) => h("i", { class: j < i ? "done" : j === i ? "on" : "" }))),
    i > 0 && onb.step !== "ready" ? h("button", { class: "onb-back", "aria-label": "Back", onclick: () => onbGo(ONB_STEPS[i - 1]) }, "‹") : null,
    h("div", { class: "onb-visual" }, visual),
    h("div", { class: "onb-text" },
      kicker ? h("p", { class: "onb-kicker" }, kicker) : null,
      h("h1", {}, title),
      sub ? h("p", { class: "onb-sub" }, sub) : null,
      body ?? null,
      h("div", { class: "onb-actions" }, cta ?? null, skip ? h("button", { class: "onb-skip", onclick: skip[1] }, skip[0]) : null)));
}
const onbBtn = (label, onclick, disabled = false) => h("button", { class: "onb-cta", disabled, onclick }, label);

/** A phone with something on its screen (a video, a frame, a mock). */
const phone = (...screen) => h("div", { class: "onb-phone" }, h("div", { class: "onb-phone-screen" }, ...screen));
const thumb = (id) => h("img", { src: `/media/thumb/${id}`, alt: "", loading: "lazy" });

/** Placeholder tiles for a camera roll before any footage is in: the kinds of moments people film. */
const ROLL_TILES = ["✈️", "🐶", "🍜", "🏔️", "🎂", "🏖️", "🛠️", "🎸", "👶", "🌆", "🐈", "🚐", "🎨", "⚽", "🌮", "🎄", "🏃", "🌅"];
function cameraRoll(ids = []) {
  const tiles = ids.length ? ids : ROLL_TILES;
  const col = (k) => h("div", { class: "onb-roll-col", style: { animationDelay: `${-k * 4}s` } },
    [...tiles, ...tiles].filter((_, j) => j % 3 === k).map((t, j) =>
      ids.length ? h("div", { class: "onb-tile" }, thumb(t)) : h("div", { class: `onb-tile g${(j + k) % 6}` }, h("span", {}, t))));
  return h("div", { class: "onb-roll" }, col(0), col(1), col(2));
}

function onbRender(st) {
  const el = onbEl();
  const ids = (st?.footage ?? []).filter((f) => f.thumb).map((f) => f.id);
  const show = st?.showcase;

  if (onb.step === "roll") {
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-roll-wrap" }, cameraRoll(ids), h("div", { class: "onb-roll-count" }, h("b", {}, "2,000+"), h("span", {}, "photos and videos on the average phone"))),
      kicker: "Rollcut",
      title: "Your camera roll is full of stories.",
      sub: "A trip, a pet, a skill, a funny moment. Real things people would love to see. Most of it never leaves your phone.",
      cta: onbBtn("Why is that?", onbNext),
    }));
  }

  if (onb.step === "why") {
    const chips = h("div", { class: "onb-chips" });
    const cta = onbBtn("That's me", async () => {
      await api("/api/onboarding", { method: "PUT", body: { blocks: [...onb.blocks] } });
      onbNext();
    }, true);
    const draw = () => {
      chips.replaceChildren(...BLOCKS.map(([k, label]) =>
        h("button", { class: `onb-chip${onb.blocks.has(k) ? " on" : ""}`, onclick: () => { onb.blocks.has(k) ? onb.blocks.delete(k) : onb.blocks.add(k); draw(); } }, label)));
      cta.disabled = !onb.blocks.size;
    };
    for (const b of st?.blocks ?? []) onb.blocks.add(b);
    draw();
    return el.replaceChildren(onbScreen({
      visual: phone(h("div", { class: "onb-blank" },
        h("div", { class: "onb-blank-text" }, "What do I even say", h("i", { class: "onb-caret" })),
        h("div", { class: "onb-blank-bar" }, h("span", {}, "Post"), h("span", { class: "muted" }, "Drafts (37)")))),
      kicker: "It's not the footage",
      title: "So why don't we post?",
      sub: "Psychologists even have a name for it: posting anxiety, the fear of how others will see what we share. Pick what sounds like you.",
      body: chips,
      cta,
      skip: ["Skip", onbNext],
    }));
  }

  if (onb.step === "answer") {
    const picked = BLOCKS.filter(([k]) => onb.blocks.has(k) || (st?.blocks ?? []).includes(k));
    const list = (picked.length ? picked : BLOCKS.slice(0, 3)).map(([, label, answer]) => h("li", {}, h("s", {}, label), h("span", {}, answer)));
    const visual = show
      ? h("div", { class: "onb-proof" },
          phone(h("video", { src: `/media/render/${show.id}.mp4`, poster: `/media/render/${show.id}.jpg`, autoplay: true, muted: true, loop: true, playsinline: true })),
          show.views ? h("div", { class: "onb-badge" }, `▶ ${fmtBig(show.views)} views`) : null,
          h("p", { class: "onb-proof-note" }, "Made with Rollcut from a clip in a camera roll"))
      : phone(cameraRoll(ids));
    return el.replaceChildren(onbScreen({
      visual,
      kicker: "That's the part Rollcut does",
      title: "You film. It does the rest.",
      body: h("ul", { class: "onb-answers" }, list),
      cta: onbBtn("Show me, with my videos", onbNext),
    }));
  }

  if (onb.step === "photos") {
    const connected = st?.google?.connected;
    const total = st?.clips?.total ?? 0;
    const count = h("p", { class: "onb-live" }, total ? `${total} video${total === 1 ? "" : "s"} picked` : "");
    // Their picks arrive in the background: move on by itself once the first ones are in.
    onb.timer = setInterval(async () => {
      const s2 = await api("/api/onboarding").catch(() => null);
      if (s2?.clips.total && !total) onbGo("watch");
    }, 4000);
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-connect" },
        h("div", { class: "onb-gphotos" }, h("i", { class: "p1" }), h("i", { class: "p2" }), h("i", { class: "p3" }), h("i", { class: "p4" })),
        h("div", { class: "onb-arrow" }, "→"),
        phone(cameraRoll(ids))),
      kicker: "Step 1 of 3 · Your footage",
      title: "Pick 20 videos you love.",
      sub: "Trips, your pet, your work, your cooking: anything you'd show a friend. Rollcut only sees the videos you pick, never the rest of your library.",
      body: count,
      cta: connected
        ? onbBtn(total ? "Pick more videos" : "Pick from Google Photos", () => $("#btn-google").click())
        : onbBtn("Connect Google Photos", () => (location.href = "/auth/google")),
      skip: total ? ["Continue", () => onbGo("watch")] : ["Skip for now", () => onbGo("topics")],
    }));
  }

  if (onb.step === "watch") {
    const f = st?.footage ?? [];
    const looked = f.filter((x) => x.looked).length;
    const SCIENCE = [
      ["Motion and sound", "Every clip gets an energy curve, second by second. The jumps, the laughs, the zoomies stand out."],
      ["AI watches every second", "It names what's happening in each shot, so it can tell a story with them."],
      ["The first second decides", "Most viewers choose in a moment whether to keep watching. The clearest, strongest shot goes first."],
    ];
    const card = SCIENCE[Math.floor(Date.now() / 5000) % SCIENCE.length];
    onb.timer = setTimeout(() => onbGo("watch"), 3500);
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-scan" },
        ...(f.length ? f.slice(0, 9) : Array.from({ length: 9 }, () => null)).map((x) =>
          h("div", { class: `onb-scan-tile${x?.looked ? " seen" : ""}` },
            x?.thumb ? thumb(x.id) : null,
            x?.looked ? h("span", { class: "onb-tag" }, x.scene || "✓") : h("i", { class: "onb-scanline" })))),
      kicker: "Step 2 of 3 · Getting to know your footage",
      title: f.length ? `Watching your videos… ${looked} of ${f.length}` : "Waiting for your videos…",
      body: h("div", { class: "onb-science" }, h("b", {}, card[0]), h("span", {}, card[1])),
      cta: onbBtn("Continue", () => onbGo("topics"), f.length > 0 && looked < Math.min(3, f.length) && (onb.waited = (onb.waited ?? 0) + 1) < 25),
    }));
  }

  if (onb.step === "topics") {
    const list = h("div", { class: "onb-topic-grid" }, h("p", { class: "onb-sub" }, "Reading your footage…"));
    const cta = onbBtn("These are mine", async () => {
      await api("/api/onboarding", { method: "PUT", body: { topics: onb.topics.filter((t) => onb.picked.has(t.title)) } });
      onbNext();
    }, true);
    const draw = () => {
      list.replaceChildren(...onb.topics.map((t) =>
        h("button", { class: `onb-topic-card${onb.picked.has(t.title) ? " on" : ""}`, onclick: () => {
          if (onb.picked.has(t.title)) onb.picked.delete(t.title);
          else if (onb.picked.size < 3) onb.picked.add(t.title);
          draw();
        } },
          t.clipId ? thumb(t.clipId) : h("div", { class: "onb-topic-ph" }),
          h("span", { class: "onb-topic-label" }, h("b", {}, t.title), t.why ? h("small", {}, t.why) : null),
          h("i", { class: "onb-check" }, "✓"))));
      cta.disabled = !onb.picked.size;
    };
    const own = h("input", { type: "text", maxlength: "40", placeholder: "Or type your own: Home cooking, Van life…" });
    const add = h("form", { class: "onb-own", onsubmit: (e) => {
      e.preventDefault();
      const t = own.value.trim();
      if (!t || onb.topics.some((x) => x.title.toLowerCase() === t.toLowerCase())) return;
      onb.topics.push({ title: t, why: "", audience: "niche", clipId: ids[onb.topics.length % Math.max(1, ids.length)] });
      if (onb.picked.size < 3) onb.picked.add(t);
      own.value = "";
      draw();
    } }, own, h("button", {}, "Add"));
    if (!onb.topics.length)
      api("/api/onboarding/topics/suggest", { method: "POST" }).then((topics) => {
        onb.topics = topics;
        for (const t of st?.topics ?? []) if (!onb.topics.some((x) => x.title === t.title)) onb.topics.push({ ...t, why: "" });
        onb.picked = new Set((st?.topics ?? []).map((t) => t.title));
        if (!onb.picked.size && onb.topics[0]) onb.picked.add(onb.topics[0].title);
        draw();
      }).catch(() => list.replaceChildren(h("p", { class: "onb-sub" }, "Couldn't read your footage: type your topics below.")));
    else draw();
    return el.replaceChildren(onbScreen({
      dark: false,
      visual: list,
      kicker: "Step 3 of 3 · What you can teach or show",
      title: "Here's what your footage is about.",
      sub: "Pick up to 3. Every video is written for them: the opening line, the text, the caption.",
      body: add,
      cta,
    }));
  }

  if (onb.step === "look") {
    let style = st?.textStyle ?? "yellowbox";
    const topic = ((st?.topics ?? [])[0]?.title ?? "travel").toLowerCase();
    const bg = ids[0] ? thumb(ids[0]) : null;
    const text = h("div", { class: `onb-overlay look-preview ${style}` }, h("span", {}, "Nobody tells you this about ", h("b", { class: "kw" }, topic)));
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-look-phone" }, phone(bg, text)),
      kicker: "Your look",
      title: "How should your text look?",
      sub: "Your videos start in this style. You can change it on any video before you post.",
      body: h("div", { class: "style-grid onb-styles" }, styleTiles("onb-style", style, (v) => { style = v; text.className = `onb-overlay look-preview ${v}`; })),
      cta: onbBtn("Make my first video", async () => {
        await api("/api/onboarding", { method: "PUT", body: { textStyle: style } });
        state.status.settings.textStyle = style;
        if ((st?.clips?.ready ?? 0) > 0) await api("/api/onboarding/first-video", { method: "POST" }).catch(() => {});
        onbNext();
      }),
    }));
  }

  if (onb.step === "making") {
    const v = st?.firstVideo;
    if (!v) return onbGo("trial");
    const p = v.status === "done" ? 1 : v.status === "rendering" ? 0.35 + 0.6 * (v.progress ?? 0) : v.hook ? 0.3 : 0.12;
    const STAGES = [
      [0.1, "Picking your strongest clips", "The ones with the most energy and the clearest moment."],
      [0.3, "Writing the opening line", v.hook ? `“${v.hook}”` : "From openings that already got views on TikTok, in your topic."],
      [0.5, "Cutting for attention", "A new shot every 2 seconds, so nobody scrolls away."],
      [0.7, "Placing the text", "Where it reads at a glance and never covers a face."],
      [0.9, "Finishing in full HD", "1080 × 1920, ready for TikTok and Reels."],
    ];
    if (v.status !== "done") onb.timer = setTimeout(() => onbGo("making"), 3000);
    const done = v.status === "done";
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-making" },
        phone(done
          ? h("video", { src: `/media/render/${v.id}.mp4`, poster: `/media/render/${v.id}.jpg`, autoplay: true, muted: true, loop: true, playsinline: true })
          : [ids[0] ? thumb(ids[0]) : null, h("div", { class: "onb-progress" }, h("i", { style: { width: `${Math.round(p * 100)}%` } }))])),
      kicker: "Behind the scenes",
      title: done ? "Your first video is ready." : "Making your first video…",
      body: h("ol", { class: "onb-stages" }, STAGES.map(([at, t, d]) =>
        h("li", { class: p >= at + 0.1 || done ? "done" : p >= at ? "now" : "" }, h("b", {}, t), h("span", {}, d)))),
      cta: onbBtn(done ? "Keep it" : "Continue: it finishes in the background", onbNext),
    }));
  }

  if (onb.step === "trial") {
    if (st?.billing) return onbGo("ready");
    const v = st?.firstVideo;
    const err = h("p", { class: "onb-err", hidden: true });
    const f = (name, label, attrs) => h("label", { class: "onb-field" }, h("span", {}, label), h("input", { name, required: true, ...attrs }));
    const form = h("form", { class: "onb-pay", onsubmit: async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.currentTarget));
      err.hidden = true;
      const btn = e.currentTarget.querySelector(".onb-cta");
      btn.disabled = true;
      try {
        await api("/api/onboarding/trial", { method: "POST", body: d });
        onbGo("ready");
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        btn.disabled = false;
      }
    } },
      h("p", { class: "onb-test" }, "Test mode: nothing is charged and the number isn't stored. Use 4242 4242 4242 4242, any future date, any 3 digits."),
      f("number", "Card number", { inputmode: "numeric", autocomplete: "off", placeholder: "4242 4242 4242 4242", maxlength: "23" }),
      h("div", { class: "onb-row" },
        f("exp", "Expiry", { inputmode: "numeric", autocomplete: "off", placeholder: "MM/YY", maxlength: "5" }),
        f("cvc", "CVC", { inputmode: "numeric", autocomplete: "off", placeholder: "123", maxlength: "4" })),
      err,
      h("button", { class: "onb-cta" }, "Start my free week"));
    return el.replaceChildren(onbScreen({
      dark: false,
      visual: h("div", { class: "onb-plan" },
        v ? h("img", { src: `/media/render/${v.id}.jpg`, alt: "", onerror: (e) => e.currentTarget.remove() }) : null,
        h("div", { class: "onb-plan-text" },
          h("b", {}, "7 days free"),
          h("span", {}, "New videos every morning, made from your footage."),
          h("ul", {}, h("li", {}, "Today: your first videos"), h("li", {}, "Every morning: new ones to pick from"), h("li", {}, "After 7 days: $19 a month, or cancel before")))),
      kicker: "Keep them coming",
      title: "A week of videos, on us.",
      body: form,
    }));
  }

  if (onb.step === "ready") {
    const n = st?.clips?.total ?? 0;
    return el.replaceChildren(onbScreen({
      visual: h("div", { class: "onb-ready" }, phone(cameraRoll(ids)), h("div", { class: "onb-ready-check" }, "✓")),
      kicker: "You're a creator now",
      title: "See you in the morning.",
      sub: n
        ? "Your first videos are in Review. Every morning there are new ones: ✓ the ones you love, save them, post them."
        : "Pick videos in Settings → Google Photos, and the first ones will be ready the next morning.",
      cta: onbBtn("Go to my videos", async (e) => {
        e.currentTarget.disabled = true;
        await api("/api/onboarding", { method: "PUT", body: { done: true } });
        if (st?.clips?.ready) api("/api/batch/run", { method: "POST" }).catch(() => {});
        closeOnboarding();
        await loadStatus();
        await refreshRenders();
      }),
    }));
  }
}

document.getElementById("btn-onboarding")?.addEventListener("click", async () => {
  await api("/api/onboarding", { method: "PUT", body: { done: false } });
  try { localStorage.removeItem("rollcut.onbStep"); } catch {}
  Object.assign(onb, { step: "roll", topics: [], picked: new Set(), blocks: new Set(), waited: 0 });
  openOnboarding();
});

await loadStatus();
if (state.status.onboarded === false) openOnboarding();
await Promise.all([refreshClips(), refreshRenders(), refreshAlbums(), loadAuto(), loadFonts(), refreshExamples(), refreshScenes(), refreshPartners()]);
await refreshSuggestions();
renderHomeState();

setInterval(async () => {
  const busyClips = state.clips.some((c) => c.status === "importing" || c.status === "analyzing");
  const busyRenders = state.renders.some((r) => r.status === "queued" || r.status === "rendering");
  if (busyClips) await Promise.all([refreshClips(), refreshAlbums(), refreshScenes(), refreshSuggestions()]).catch(() => {});
  if (busyClips || busyRenders) renderHomeState();
  if (busyRenders) await refreshRenders().catch(() => {});
  if (state.examplesBusy) await refreshExamples().catch(() => {});
  // After the last swipe the server plans the next round; check every 10s until its videos show up.
  if (!busyRenders && state.nextRoundUntil > Date.now() && ++state.roundTicks % 5 === 0) {
    await Promise.all([refreshRenders(), loadStatus()]).catch(() => {});
    if (state.renders.some((r) => r.status === "queued" || r.status === "rendering")) state.nextRoundUntil = 0;
    // The round couldn't be made: stop the spinner and say why.
    // One kind couldn't be made while the others were: say which and why.
    for (const [k, issue] of Object.entries(state.status?.kindIssues ?? {}))
      if (issue.at > (state.roundStartedAt ?? "") && issue.at !== state.kindIssueShown) {
        state.kindIssueShown = issue.at;
        banner(`The ${{ tips: "educational", fun: "fun", inspire: "inspirational" }[k] ?? k} video couldn't be made: ${issue.message}`);
      }
    const err = state.status?.lastRoundError;
    if (err && err.at > (state.roundStartedAt ?? "")) {
      state.nextRoundUntil = 0;
      banner(`Couldn't make the next round: ${err.message}`);
    }
    renderHomeState();
  }
}, 2000);
state.roundTicks = 0;

// ---- Themes for videos -----------------------------------------------------------------

async function refreshThemes() {
  const t = await api("/api/themes").catch(() => null);
  if (!t) return;
  state.themes = t;
  const off = new Set([...t.travel, ...t.outside].filter((x) => !x.on).map((x) => x.name));
  for (const p of t.places ?? []) if (!p.on) off.add(p.key);
  const chip = (x, removable) =>
    h("span", { class: `theme-chip ${x.on ? "on" : ""}` },
      h("button", { type: "button", class: "theme-toggle", onclick: async () => {
        x.on ? off.add(x.name) : off.delete(x.name);
        await api("/api/themes", { method: "PUT", body: { themesOff: [...off] } });
        refreshThemes();
      } }, x.on ? "✓ " : "", x.name, h("span", { class: "theme-count" }, ` ${x.unused}/${x.clips}`)),
      removable ? h("button", { type: "button", class: "theme-x", "aria-label": `Remove ${x.name}`, onclick: async () => {
        if (!confirm(`Remove the theme “${x.name}”? Its clips go back to unsorted.`)) return;
        await api("/api/themes", { method: "PUT", body: { outsideThemes: t.outside.map((o) => o.name).filter((n) => n !== x.name) } });
        refreshThemes();
      } }, "×") : null);
  $("#themes-travel").replaceChildren(...t.travel.map((x) => chip(x, false)));
  $("#themes-outside").replaceChildren(...t.outside.map((x) => chip(x, true)));
  $("#themes-unsorted").textContent = t.unsorted ? `${t.unsorted} clip(s) don't fit any theme yet.` : "";
  // Places: dynamic, from where the footage was filmed.
  $("#themes-places").replaceChildren(
    ...(t.places ?? []).map((p) =>
      h("span", { class: `theme-chip ${p.on ? "on" : ""}`, title: p.cities.join(", ") },
        h("button", { type: "button", class: "theme-toggle", onclick: async () => {
          p.on ? off.add(p.key) : off.delete(p.key);
          await api("/api/themes", { method: "PUT", body: { themesOff: [...off] } });
          refreshThemes();
        } }, p.on ? "✓ " : "", p.name, h("span", { class: "theme-count" }, ` ${p.unused}/${p.clips}`)))),
  );
  if (!(t.places ?? []).length) $("#themes-places").replaceChildren(h("p", { class: "muted" }, "No places found yet: they appear as clips are looked at (it needs the position your phone saves, or a recognizable place)."));
  // Suggested from the footage itself: tap to add.
  api("/api/themes/suggestions").then((sugg) => {
    $("#themes-suggested").replaceChildren(
      ...(sugg.length
        ? [h("p", { class: "muted theme-sub" }, "Suggested from your footage:"),
           h("div", { class: "theme-chips" }, ...sugg.map((s) =>
             h("button", { type: "button", class: "theme-chip suggest", title: s.why, onclick: async () => {
               await api("/api/themes", { method: "PUT", body: { outsideThemes: [...t.outside.map((o) => o.name), s.name] } });
               banner(`Added “${s.name}”. Clips that fit it are being sorted in; give it a minute.`, "ok");
               setTimeout(refreshThemes, 1500);
             } }, `+ ${s.name}`)))]
        : []),
    );
  }).catch(() => {});
  const on = [...t.travel, ...t.outside].filter((x) => x.on).length;
  $("#sum-themes").textContent = `${on} on`;
}
$("#theme-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.currentTarget.theme.value.trim().toLowerCase();
  if (!name || !state.themes) return;
  await api("/api/themes", { method: "PUT", body: { outsideThemes: [...state.themes.outside.map((o) => o.name), name] } });
  e.currentTarget.reset();
  banner(`Added “${name}”. Clips that fit it are being sorted in; give it a minute.`, "ok");
  setTimeout(refreshThemes, 1500);
});
refreshThemes();
