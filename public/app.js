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

async function loadStatus() {
  const s = (state.status = await api("/api/status"));
  $("#app-version").textContent = `Version ${s.version}`;
  $("#chip-google").classList.toggle("on", s.google.connected);
  $("#paused").hidden = !s.paused;
  $("#ai-credit").hidden = !s.aiOutOfCredit;
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
  $("#logout").hidden = !s.gate;
  $("#chip-ai").classList.toggle("on", s.claude.enabled);
  $("#chip-ai").title = s.claude.enabled ? `Using ${s.claude.model}` : "Set ANTHROPIC_API_KEY to enable";
  const form = $("#settings");
  if (document.activeElement?.form !== form) {
    form.petName.value = s.settings.petName;
    form.handle.value = s.settings.handle;
    if (document.activeElement !== form.story) form.story.value = s.settings.story ?? "";
  }
  if (document.activeElement?.form !== $("#limits")) $("#limits").maxVideosPerDay.value = String(s.settings.maxVideosPerDay);
  $("#limits").onlySituations.checked = s.settings.onlySituations !== false;
  renderSummaries();
  $("#videos-today").textContent = `${s.videosToday.made} of ${s.videosToday.limit} made today. Nothing more is made once the limit is reached, including by hand.`;
  const btn = $("#btn-google");
  // The picker needs Google Cloud credentials; the album link doesn't, so only show the picker when it's set up.
  btn.hidden = !s.google.configured;
  btn.textContent = s.google.connected ? "Pick from Google Photos" : "Connect Google Photos";
  $("#google-hint").textContent = "New videos you add to the album are picked up automatically every few hours.";
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
  state.status.settings = await api("/api/settings", { method: "PUT", body: { petName: f.petName.value, handle: f.handle.value, story: f.story.value } });
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
  const n = state.albumCount ?? 0;
  set("sum-album", n ? `${n} album${n === 1 ? "" : "s"}` : "Not connected");
  const ready = state.clips.filter((c) => c.status === "ready").length;
  set("sum-clips", `${ready} clip${ready === 1 ? "" : "s"}`);
  const a = state.auto;
  set("sum-videos", a ? `${a.enabled ? `${a.dailyCount} per round` : "Off"} · max ${s.settings.maxVideosPerDay}/day` : "");
  const size = { small: "Small", medium: "Medium", large: "Large" }[s.settings.textSize] ?? "Medium";
  const style = { yellow: "Yellow", classic: "Outline", box: "Box", plain: "Plain" }[s.settings.textStyle] ?? "";
  set("sum-look", `${style} · ${size}`);
  set("sum-scenes", s.tiktokSearch ? `${s.settings.scenes.length} situations` : "Apify not connected");
  set("sum-profile", s.settings.handle || s.settings.petName || "");
  set("sum-spend", `$${s.spend.usd.toFixed(2)} of $${s.spend.limit.toFixed(0)}`);
  set("sum-user", s.user ?? "");
}

// ---- Google Photos picker ---------------------------------------------------

$("#btn-google").addEventListener("click", async () => {
  const s = state.status;
  if (!s.google.configured) return banner("Add Google OAuth credentials to .env first (see README).");
  if (!s.google.connected) return (location.href = "/auth/google");
  const btn = $("#btn-google");
  // Open the window synchronously so popup blockers allow it.
  const win = window.open("", "gphotos-picker", "width=1100,height=800");
  try {
    btn.disabled = true;
    btn.textContent = "Waiting for your picks…";
    const session = await api("/api/google/picker", { method: "POST" });
    if (win) win.location.href = `${session.pickerUri}/autoclose`;
    else window.open(`${session.pickerUri}/autoclose`, "_blank");
    const interval = Math.max(2000, parseFloat(session.pollInterval || "3") * 1000);
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const r = await api(`/api/google/picker/${encodeURIComponent(session.id)}`);
      if (r.done) {
        banner(`Imported ${r.imported} new item${r.imported === 1 ? "" : "s"} (${r.picked - r.imported} already in your library). Analyzing…`, "ok");
        refreshClips();
        return;
      }
    }
    banner("The Google Photos picker timed out. Try again.");
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
    (c.width > c.height || c.edited || c.duplicateOf || (strict && c.scene && !st.scenes.includes(c.scene)));
  const main = state.clips.filter((c) => !notUsed(c));
  const parked = state.clips.filter(notUsed);
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
          class: `clip ${landscape ? "landscape" : ""}`,
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
            h("span", {}, c.capturedAt ? new Date(c.capturedAt).toLocaleDateString() : ""),
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
  el.replaceChildren(
    ...main.map(card),
    parked.length
      ? h("details", { class: "not-used", open: state.notUsedOpen, ontoggle: (e) => (state.notUsedOpen = e.currentTarget.open) },
          h("summary", {}, `Not used (${parked.length})`,
            h("span", { class: "muted" }, " · not from your situations, already edited, duplicates or landscape. Their files are deleted after 7 days; set a situation to keep one.")),
          h("div", { class: "clips" }, ...parked.map(card)))
      : null,
  );
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

const inProgress = (r) => r.status === "queued" || r.status === "rendering";

function toReview() {
  return state.renders.filter((r) => r.status === "done" && r.review === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderStack() {
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
  const video = h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, autoplay: true, muted: true, loop: true, playsinline: true });
  video.muted = true;
  const sound = h("button", { class: "stack-sound", "aria-label": "Sound", onclick: (e) => { video.muted = !video.muted; e.currentTarget.innerHTML = icon(video.muted ? "muted" : "sound"); } });
  sound.innerHTML = icon("muted");
  const card = h("div", { class: "stack-card" },
    h("div", { class: "stack-media" }, video, sound,
      h("span", { class: "stamp keep" }, "POST"),
      h("span", { class: "stamp nope" }, "NOPE"),
      h("span", { class: "stack-tap" }, "Tap for details"),
      r.plan.collab || r.plan.format === "tips"
        ? h("span", { class: "collab-badge on-video" }, r.plan.collab ? `Collab · ${r.plan.collab.name}` : "Tips")
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
  const video = h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, autoplay: true, loop: true, playsinline: true, controls: true });
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
function detailsBody(r) {
  const plan = r.plan;
  // One line per overlay (" / " inside an overlay is its own line break, so it can't be the separator).
  const overlay = plan.overlays?.length ? plan.overlays.map((o) => o.text).join("\n") : plan.hook || plan.title;
  const caption = plan.postCaption || "";
  const tags = plan.hashtags ?? [];
  const posts = new Map((plan.hashtagInfo ?? []).map((t) => [t.tag, t.posts]));
  const fullCaption = () => [plan.postCaption, plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");

  // Headline: the text on the video, editable in place (re-makes the video).
  const headline = h("h2", { class: "d-title" }, overlay);
  const editText = h("div", { class: "d-edit", hidden: true });
  const textInput = h("textarea", { rows: 2 }, overlay);
  editText.append(
    textInput,
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
    banner("Re-making the video with the new text style. It's back in a minute or two.", "ok");
  }) }, "Apply to this video");
  const styleEdit = h("div", { class: "d-style", hidden: true },
    h("span", { class: "d-label" }, "Size"), segControl("textSize", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]]),
    h("span", { class: "d-label" }, "Look"), segControl("textStyle", [["yellow", "Yellow"], ["classic", "White"], ["box", "Box"], ["plain", "Plain"]]),
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
    await api(`/api/renders/${r.id}`, { method: "PATCH", body: { postCaption: plan.postCaption, hashtags: plan.hashtags } });
    captionText.textContent = plan.postCaption || "No caption";
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

  const b = plan.basedOn;
  const seg = plan.segments?.[0];
  const clip = seg && state.clips.find((c) => c.id === seg.clipId);
  return h("div", { class: "d" },
    h("section", { class: "d-head" },
      headline,
      h("span", { class: "d-actions" },
        h("button", { class: "d-link", onclick: () => { editText.hidden = !editText.hidden; if (!editText.hidden) textInput.focus(); } }, "Edit text"),
        h("button", { class: "d-link", onclick: () => (styleEdit.hidden = !styleEdit.hidden) }, "Text style"),
        h("button", { class: "d-link", onclick: () => (collabEdit.hidden = !collabEdit.hidden) }, "Collab version"),
      ),
      plan.collab ? h("span", { class: "collab-badge" }, `Collab · ${plan.collab.name}`) : null,
      plan.format === "tips" ? h("span", { class: "collab-badge" }, "Tips") : null,
      editText,
      styleEdit,
      collabEdit,
    ),
    h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Caption"), h("span", { class: "d-actions" }, editCaptionBtn, copyBtn)),
      captionText,
      captionEdit,
      tags.length ? h("div", { class: "d-chips" },
        tags.map((t) => h("span", { class: "chip" }, `#${t}`, posts.has(t) ? h("small", {}, ` ${fmtViews(posts.get(t))}`) : null))) : null,
      posts.size ? h("p", { class: "d-hint" }, "Numbers are how many TikTok posts use each hashtag.") : null,
    ),
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
    b ? h("section", { class: "d-sec" },
      h("div", { class: "d-sec-head" }, h("span", {}, "Inspired by")),
      h("div", { class: "d-proof" },
        h("span", { class: "d-proof-icon" }, "🔥"),
        h("span", {},
          h("b", {}, b.views ? `${fmtViews(b.views)} views on TikTok` : "A popular TikTok"),
          h("span", { class: "d-proof-text" }, `“${b.text}”`),
          b.url ? h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, "Watch on TikTok ›") : null),
      ),
    ) : null,
  );
}

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
  fetch(`/media/render/${r.id}.mp4`)
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
  api(`/api/renders/${stack.whyFor}`, { method: "PATCH", body: { rejectReason: reason } }).catch((err) => banner(err.message));
  stack.whyFor = null;
  renderStack();
  renderBatch();
  renderRenders();
  renderHomeState();
});

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
  const earlier = state.renders.filter((r) => r.review === "rejected" || r.status === "error");
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
  const video = h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, controls: true, autoplay: true, loop: true, playsinline: true });
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

// ---- Brand partners -----------------------------------------------------------

async function refreshPartners() {
  state.partners = await api("/api/partners");
  const n = state.partners.length;
  $("#sum-partners").textContent = n ? `${n}` : "";
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
    await api("/api/partners", { method: "POST", body: { id: f.partnerId.value || undefined, ...Object.fromEntries(["name", "handle", "about", "mustInclude"].map((k) => [k, f[k].value])) } });
    f.reset();
    f.partnerId.value = "";
    await refreshPartners();
    banner("Partner saved. Open any video and tap Collab version.", "ok");
  });
});

// ---- Shared albums ----------------------------------------------------------

async function refreshAlbums() {
  const albums = await api("/api/albums");
  state.albumCount = albums.length;
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
                await api(`/api/albums/${a.id}`, { method: "PATCH", body: { recentDays: Number(e.target.value) } });
                const r = await api(`/api/albums/${a.id}/sync`, { method: "POST" });
                banner(r.newItems ? `Found ${r.newItems} video(s) to import…` : "Saved.", "ok");
                await Promise.all([refreshAlbums(), refreshClips()]);
              },
            }, ...[[30, "videos from the last 30 days"], [60, "videos from the last 60 days"], [0, "all videos"]].map(([v, t]) =>
              h("option", { value: v, selected: (a.recentDays ?? 0) === v }, t))),
          ),
          a.tooOld || a.waiting ? h("div", { class: "muted" },
            [a.tooOld ? `${a.tooOld} older item(s) left out` : "", a.waiting ? `${a.waiting} more waiting; imported as new rounds need them` : ""].filter(Boolean).join(" · ")) : null,
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
    if (r.skipped === "daily video limit reached") banner("That's today's video limit. Raise it in Settings → Schedule & limits for more.");
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

function renderBatch() {
  // Ready tab: every kept video, newest first.
  const kept = state.renders.filter((r) => r.status === "done" && r.review === "approved").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#ready-empty").hidden = kept.length > 0;
  const unsaved = kept.filter((r) => !r.downloaded).length;
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
      ? h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, controls: true, loop: true, playsinline: true, preload: "none" })
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
  wrap.replaceChildren(h("video", { class: "thumb", src: `/media/clip/${clipId}`, controls: true, autoplay: true, playsinline: true }));
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
      h("div", { class: "sheet-media" }, h("video", { src: `/media/clip/${clipId}`, controls: true, autoplay: true, playsinline: true })),
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
  $("#look-sample").textContent = `POV: the energy shift when ${petName || "Lex"} realizes we're at the airport`;
  const current = fonts.find((f) => f.id === fontId) ?? fonts.find((f) => f.id === "tiktok-sans");
  $("#look-sample").style.fontFamily = `"${fontFamily(current)}"`;
  $("#look-preview").className = `look-preview ${textStyle} size-${textSize}`;
  for (const r of document.querySelectorAll("#text-style input")) r.checked = r.value === textStyle;
  for (const r of document.querySelectorAll("#text-size input")) r.checked = r.value === textSize;
  const tips = String(state.status.settings.tipsPerRound ?? 1);
  for (const r of document.querySelectorAll("#tips-per-round input")) r.checked = r.value === tips;
  const audience = state.status.settings.captionAudience ?? "mix";
  for (const r of document.querySelectorAll("#caption-audience input")) r.checked = r.value === audience;
  $("#audience-hint").textContent = {
    pets: "Text written for dog lovers.",
    mix: "Every other video speaks to everyone (travel, everyday moments) with Lex as the punchline, so you reach beyond dog lovers.",
    everyone: "Text about the moment anyone recognizes (travel stress, waiting, tiny seats), with Lex as the punchline.",
  }[audience];
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

$("#tips-per-round").addEventListener("change", async (e) => {
  state.status.settings = await api("/api/settings", { method: "PUT", body: { tipsPerRound: Number(e.target.value) } });
  loadFonts();
});

$("#caption-audience").addEventListener("change", async (e) => {
  state.status.settings = await api("/api/settings", { method: "PUT", body: { captionAudience: e.target.value } });
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
          : "None of your clips are from your situations yet. New videos in your albums are picked up every few hours.";
  $("#btn-batch-empty").hidden = !n || atLimit;
  $("#btn-batch-empty").textContent = "Make the next round";
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

await loadStatus();
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
    const err = state.status?.lastRoundError;
    if (err && err.at > (state.roundStartedAt ?? "")) {
      state.nextRoundUntil = 0;
      banner(`Couldn't make the next round: ${err.message}`);
    }
    renderHomeState();
  }
}, 2000);
state.roundTicks = 0;
