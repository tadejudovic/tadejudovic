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
  $("#chip-google").classList.toggle("on", s.google.connected);
  $("#paused").hidden = !s.paused;
  const sp = s.spend;
  $("#spend-used").textContent = `$${sp.usd.toFixed(2)}`;
  $("#spend-limit").textContent = `$${sp.limit.toFixed(0)}`;
  $("#spend-calls").textContent = sp.calls ? `· ${sp.calls} AI calls` : "";
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
    form.maxVideosPerDay.value = String(s.settings.maxVideosPerDay);
  }
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
  await api("/api/settings", { method: "PUT", body: { petName: f.petName.value, handle: f.handle.value, maxVideosPerDay: Number(f.maxVideosPerDay.value) } });
});
$("#settings").addEventListener("submit", (e) => e.preventDefault());

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
  el.replaceChildren(
    ...state.clips.map((c) => {
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
              ? h("span", { class: `use ${c.uses ? "" : "fresh"}` }, c.uses ? `used ${c.uses}×` : "not used yet")
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
    }),
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
  // While reviewing, only the card is on screen; kept and earlier videos show once you're through.
  $('section[data-tab="review"]').classList.toggle("reviewing", queue.length > 0 || !!stack.whyFor);
  $("#stack-undo").hidden = !stack.history.length;
  // A rejection needs its reason before the next video shows.
  const r = stack.whyFor ? null : queue.find((x) => x.id === stack.shownId) ?? queue[0];
  $(".stack-actions").hidden = !r;
  $("#stack-why").hidden = !stack.whyFor;
  if (!r) {
    stack.shownId = null;
    $("#stack-stage").replaceChildren();
    return;
  }
  // Keep the card (and its playing video / open details) across background refreshes.
  if (r.id === stack.shownId && stack.node?.isConnected) return;
  stack.shownId = r.id;
  stack.node = stackCard(r);
  prefetchFile(r);
  $("#stack-stage").replaceChildren(stack.node);
}

function stackCard(r) {
  const video = h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, autoplay: true, muted: true, loop: true, playsinline: true });
  video.muted = true;
  const sound = h("button", { class: "stack-sound", "aria-label": "Sound", onclick: (e) => { video.muted = !video.muted; e.currentTarget.textContent = video.muted ? "🔇" : "🔊"; } }, "🔇");
  const details = h("div", { class: "stack-details", hidden: true }, detailsBody(r));
  const card = h("div", { class: "stack-card" },
    h("div", { class: "stack-media" }, video, sound,
      h("span", { class: "stamp keep" }, "KEEP"),
      h("span", { class: "stamp nope" }, "NOPE"),
      h("span", { class: "stack-tap" }, "Tap for details"),
    ),
    details,
  );
  dragToSwipe(card, card.querySelector(".stack-media"), decide, () => {
    details.hidden = !details.hidden;
    card.classList.toggle("open", !details.hidden);
  });
  return card;
}

/** Everything about a video except the player: made from, text on video, caption, hashtags. */
function detailsBody(r) {
  const body = reviewCard(r).querySelector(".body");
  body.querySelector(".card-actions")?.remove();
  const info = r.plan.hashtagInfo ?? [];
  if (info.length) {
    body.append(
      h("span", { class: "field-label" }, "Hashtags"),
      h("div", { class: "tag-info" },
        info.map((t) => h("span", {}, h("b", {}, `#${t.tag}`), ` ${fmtViews(t.posts)} posts`))),
    );
  }
  body.append(h("a", { class: "btn small", href: `/media/render/${r.id}.mp4?dl=1` }, "Download"));
  return body;
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
  const isPhone = matchMedia("(pointer: coarse)").matches;
  if (isPhone && file && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).then(markSaved).catch(() => {});
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
  if (!toReview().length) state.nextRoundUntil = Date.now() + 6 * 60_000;
  if (review === "approved") banner("Kept and saved. It's under “Kept” if you need it again.", "ok");
  api(`/api/renders/${r.id}`, { method: "PATCH", body: { review } }).catch((err) => banner(err.message));
  setTimeout(() => { stack.shownId = null; renderStack(); renderBatch(); renderHomeState(); }, 230);
}

$("#stack-why").addEventListener("click", (e) => {
  const reason = e.target.dataset?.reason;
  if (!reason || !stack.whyFor) return;
  api(`/api/renders/${stack.whyFor}`, { method: "PATCH", body: { rejectReason: reason } }).catch((err) => banner(err.message));
  stack.whyFor = null;
  renderStack();
  renderBatch();
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
  // Everything except the batch shown at the top of Review.
  const latest = latestBatch();
  // Everything not shown above: older batches and rejected videos, minus what's waiting in the swipe stack.
  const inStack = new Set(toReview().map((r) => r.id));
  const earlier = state.renders.filter((r) => !inStack.has(r.id) && !inProgress(r) && (!latest || r.batch !== latest || r.review === "rejected"));
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
    : r.review === "approved" ? h("span", { class: "badge yes" }, "Kept")
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
          window.scrollTo({ top: 0, behavior: "smooth" });
        } }, "Review again")
      : h("button", { class: "btn primary", onclick: () => { saveVideo(r); setTimeout(refreshRenders, 1000); } }, r.downloaded ? "Save again" : "Save video"),
    h("button", { class: "btn quiet-btn", onclick: () => deleteVideo(r) }, "Delete"),
  );
  const details = detailsBody(r);
  details.querySelector(':scope > a.btn[href*="dl=1"]')?.remove();
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
  sheet.hidden = true;
  sheet.replaceChildren();
  document.body.classList.remove("no-scroll");
}
$("#sheet").addEventListener("click", (e) => e.target.id === "sheet" && closeSheet());
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("#sheet").hidden && closeSheet());

// ---- Shared albums ----------------------------------------------------------

async function refreshAlbums() {
  const albums = await api("/api/albums");
  state.albumCount = albums.length;
  $("#albums").replaceChildren(
    ...albums.map((a) =>
      h("li", {},
        h("div", { class: "grow" },
          h("b", {}, a.title || "Shared album"), " ",
          h("a", { href: a.url, target: "_blank", rel: "noopener", class: "muted" }, "open"),
          h("div", { class: "muted" },
            `${a.videoCount} video${a.videoCount === 1 ? "" : "s"} imported · `,
            a.lastSyncAt ? `checked ${new Date(a.lastSyncAt).toLocaleString()}` : "not checked yet",
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
            [a.tooOld ? `${a.tooOld} older item(s) left out` : "", a.waiting ? `${a.waiting} more will import at the next checks` : ""].filter(Boolean).join(" · ")) : null,
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

$("#album-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector("button"), "Reading album…", async () => {
    const r = await api("/api/albums", { method: "POST", body: { url: form.url.value } });
    if (r.error) banner(`Album saved, but reading it failed: ${r.error}`);
    else banner(`Watching “${r.album.title || "album"}”. ${r.newItems} item(s) found; videos are importing now.`, "ok");
    form.reset();
    await Promise.all([refreshAlbums(), refreshClips()]);
  });
});

// ---- Daily batch --------------------------------------------------------------

async function loadAuto() {
  const a = (state.auto = await api("/api/auto"));
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
  await api("/api/auto", {
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
});

$("#btn-batch-empty").addEventListener("click", () => $("#btn-batch").click());
$("#btn-batch").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Making… (1–3 min)", async () => {
    const r = await api("/api/batch/run", { method: "POST" });
    if (r.warning) banner(r.warning);
    else banner(`Making ${r.renders.length} videos. They appear below as they finish.`, "ok");
    await refreshRenders();
  }),
);

async function loadTrends() {
  const t = await api("/api/trends");
  $("#trends-src").textContent = t.source === "claude_web_search" ? `· researched ${new Date(t.updatedAt).toLocaleDateString()}` : "· evergreen starter set";
  const pet = state.status?.settings.petName || "Lex";
  $("#trends").replaceChildren(...t.formats.map((f) => h("li", {}, f.example.replaceAll("{pet}", pet), " ", h("span", {}, `— ${f.fits}`))));
  $("#btn-trends").disabled = !state.status?.claude.enabled;
  $("#btn-trends").title = state.status?.claude.enabled ? "" : "Needs ANTHROPIC_API_KEY";
}
$("#btn-trends").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Searching the web…", async () => {
    await api("/api/trends/refresh", { method: "POST" });
    await loadTrends();
    banner("Trend list updated.", "ok");
  }),
);

const batchEls = new Map();
function latestBatch() {
  return [...new Set(state.renders.map((r) => r.batch).filter(Boolean))].sort().reverse()[0];
}

function renderBatch() {
  const latest = latestBatch();
  const all = state.renders.filter((r) => r.batch && r.batch === latest);
  const inStack = new Set(toReview().map((r) => r.id));
  // Kept videos first; rejected ones are under "Earlier videos".
  const items = all.filter((r) => !inStack.has(r.id) && r.review !== "rejected" && !inProgress(r))
    .sort((a, b) => (b.review === "approved") - (a.review === "approved"));
  $("#batch-empty").hidden = all.length > 0;
  $("#kept-title").hidden = !items.some((r) => r.review === "approved");
  const approved = all.filter((r) => r.review === "approved").length;
  const when = latest
    ? new Date(`${latest}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : "";
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("#batch-date").textContent = latest
    ? `${when} · ${approved} kept · ${inStack.size} to review`
    : today;
  $("#batch").replaceChildren(
    ...items.map((r) => {
      const key = `${r.id}:${r.status}:${r.review}:${r.downloaded}:${r.status === "done" ? "" : Math.round(r.progress * 20)}`;
      const cached = batchEls.get(r.id);
      if (cached?.key === key) return cached.node;
      const node = tile(r);
      batchEls.set(r.id, { key, node });
      return node;
    }),
  );
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
        body: { overlays: overlayInputs.map((i) => i.value), options: { fontId: state.status.settings.fontId, textStyle: state.status.settings.textStyle } },
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
function openClip(clipId) {
  showTab("clips");
  const card = document.querySelector(`.clip[data-clip="${clipId}"]`);
  if (!card) return banner("That clip is no longer in your library.");
  for (const el of document.querySelectorAll(".clip.highlight")) el.classList.remove("highlight");
  card.classList.add("highlight");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  playClip(card, clipId);
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
    : "Captions come from web search, which rarely shows view counts. Add an APIFY_TOKEN on Render to search TikTok directly.";
  $("#scenes").replaceChildren(
    ...list.map((s) => {
      const r = s.research;
      const caps = r?.captions ?? [];
      const status = s.scene === "other"
        ? "clips that don't fit a situation"
        : r?.updatedAt
          ? `${caps.length} proven caption${caps.length === 1 ? "" : "s"} · ${r.source === "tiktok" ? "searched on TikTok" : "web search"} ${new Date(r.updatedAt).toLocaleDateString()}`
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
  const { fontId, textStyle, petName } = state.status.settings;
  $("#look-sample").textContent = `POV: the energy shift when ${petName || "Lex"} realizes we're at the airport`;
  const current = fonts.find((f) => f.id === fontId) ?? fonts.find((f) => f.id === "tiktok-sans");
  $("#look-sample").style.fontFamily = `"${fontFamily(current)}"`;
  $("#look-preview").className = `look-preview ${textStyle}`;
  for (const r of document.querySelectorAll("#text-style input")) r.checked = r.value === textStyle;
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
function renderMaking(planning) {
  const busy = state.renders.filter(inProgress);
  const box = $("#making");
  box.hidden = !busy.length && !planning;
  if (box.hidden) return;
  const n = busy.length;
  const pct = n ? Math.round((busy.reduce((sum, r) => sum + (r.status === "rendering" ? r.progress : 0), 0) / n) * 100) : 0;
  $("#making-title").textContent = n ? `Making ${n} new video${n === 1 ? "" : "s"}…` : "Getting the next videos ready…";
  box.classList.toggle("indeterminate", !n || pct === 0);
  $("#making-fill").style.width = `${Math.max(4, pct)}%`;
  $("#making-sub").textContent = n
    ? `${pct ? `${pct}% · ` : ""}They'll appear here when they're finished. You can leave this page.`
    : "Picking clips and writing the text (1–3 min).";
}

function renderHomeState() {
  const noSource = state.albumCount === 0 && state.clips.length === 0;
  $("#onboard").hidden = !noSource;
  $("#btn-batch").hidden = noSource;
  const latest = latestBatch();
  const hasToday = state.renders.some((r) => r.batch && r.batch === latest);
  $("#batch-empty").hidden = noSource || hasToday;
  const importing = state.clips.filter((c) => c.status === "importing" || c.status === "analyzing").length;
  const making = state.renders.filter((r) => r.status === "queued" || r.status === "rendering").length;
  const parts = [];
  if (importing) parts.push(`Importing ${importing} clip${importing === 1 ? "" : "s"} from your album…`);
  const reviewing = state.renders.some((r) => r.status === "done" && r.review === "pending");
  const vt = state.status?.videosToday;
  const planning = !making && state.nextRoundUntil > Date.now();
  if (!making && !planning && !reviewing && state.renders.length && vt && vt.made >= vt.limit) {
    parts.push(`All reviewed. That's today's ${vt.limit} videos; the next round comes tomorrow at ${state.auto?.dailyTime ?? "08:00"}.`);
  }
  renderMaking(planning);
  // Nothing new can start while a round is being made or reviewed.
  $("#btn-batch").hidden = noSource || making > 0 || planning;
  $("#activity").textContent = parts.join(" ");
  $("#activity").hidden = !parts.length;
  // Clips are raw footage; show them so "ready" means something, and offer to make videos right away.
  const readyClips = state.clips.filter((c) => c.status === "ready" && c.height >= c.width);
  const n = readyClips.length;
  $("#batch-empty-title").textContent = n ? `${n} clip${n === 1 ? "" : "s"} ready to turn into videos` : "No videos yet today";
  $("#batch-empty-text").textContent = n
    ? `Videos are made automatically every morning at ${state.auto?.dailyTime ?? "08:00"}. Don't want to wait? Make them now.`
    : importing
      ? "Your clips are being imported. Videos will follow."
      : "Add videos to your Google Photos album; new ones are picked up every few hours.";
  $("#btn-batch-empty").hidden = !n;
  $("#btn-batch-empty").textContent = n === 1 ? "Make a video now" : `Make ${Math.min(n, state.auto?.dailyCount ?? 4)} videos now`;
  $("#ready-strip").replaceChildren(
    ...readyClips.slice(0, 8).map((c) => h("img", { src: `/media/thumb/${c.id}`, alt: "", title: c.scene || c.filename, loading: "lazy" })),
  );
}

$("#onboard-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector("button"), "Connecting…", async () => {
    const r = await api("/api/albums", { method: "POST", body: { url: form.url.value } });
    if (r.error) banner(`Couldn't read the album: ${r.error}`);
    else banner(`Connected “${r.album.title || "your album"}”. Importing videos now.`, "ok");
    form.reset();
    await Promise.all([refreshAlbums(), refreshClips()]);
    renderHomeState();
  });
});

// ---- Tabs -------------------------------------------------------------------

const TABS = ["review", "clips", "settings"];
function showTab(name) {
  if (["captions", "style"].includes(name)) name = "settings";
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
await Promise.all([refreshClips(), refreshRenders(), refreshAlbums(), loadAuto(), loadTrends(), loadFonts(), refreshExamples(), refreshScenes()]);
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
    renderHomeState();
  }
}, 2000);
state.roundTicks = 0;
