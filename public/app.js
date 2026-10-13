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
  $("#logout").hidden = !s.gate;
  $("#chip-ai").classList.toggle("on", s.claude.enabled);
  $("#chip-ai").title = s.claude.enabled ? `Using ${s.claude.model}` : "Set ANTHROPIC_API_KEY to enable";
  const form = $("#settings");
  if (document.activeElement?.form !== form) {
    form.petName.value = s.settings.petName;
    form.handle.value = s.settings.handle;
  }
  const btn = $("#btn-google");
  btn.textContent = s.google.connected ? "Import from Google Photos" : "Connect Google Photos";
  $("#google-hint").textContent = !s.google.configured
    ? "Google Photos isn't configured yet — add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to .env (see README). Uploading files works now."
    : s.google.connected
      ? "You'll pick clips in Google Photos' own picker. Tip: search “Lex” or a pet-face group there to grab everything at once."
      : "";
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
  await api("/api/settings", { method: "PUT", body: { petName: f.petName.value, handle: f.handle.value } });
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
          class: `clip ${state.selected.has(c.id) ? "selected" : ""} ${landscape ? "landscape" : ""}`,
          title: c.error || c.ai?.summary || c.filename,
          onclick: () => {
            if (c.status !== "ready" || landscape) return;
            state.selected.has(c.id) ? state.selected.delete(c.id) : state.selected.add(c.id);
            renderClips();
          },
        },
        c.status === "ready" ? h("img", { class: "thumb", src: `/media/thumb/${c.id}`, loading: "lazy", alt: "" }) : h("div", { class: "thumb" }),
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
            c.uses ? h("span", { title: "Used in this many videos" }, `×${c.uses}`) : null,
          ),
          c.energy?.length ? energyBars(c.energy) : null,
          tags.length ? h("div", { class: "tags" }, tags.map((t) => h("span", { class: "tag" }, t))) : null,
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
    $("#renders").scrollIntoView({ behavior: "smooth", block: "start" });
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
            $("#renders").scrollIntoView({ behavior: "smooth", block: "start" });
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
}

const renderEls = new Map();
function renderRenders() {
  const el = $("#renders");
  $("#renders-empty").hidden = state.renders.length > 0;
  const nodes = state.renders.map((r) => {
    const key = `${r.id}:${r.status}:${r.status === "done" ? "" : Math.round(r.progress * 20)}`;
    const cached = renderEls.get(r.id);
    if (cached?.key === key) return cached.node;
    const node = renderCard(r);
    renderEls.set(r.id, { key, node });
    return node;
  });
  el.replaceChildren(...nodes);
}

function renderCard(r) {
  const caption = [r.plan.postCaption, r.plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  const media =
    r.status === "done"
      ? h("video", { src: `/media/render/${r.id}.mp4`, poster: `/media/render/${r.id}.jpg`, controls: true, loop: true, playsinline: true, preload: "none" })
      : h("div", { class: "ph" },
          h("div", {},
            r.status === "error" ? "Render failed" : r.status === "queued" ? "Queued…" : `Rendering… ${Math.round(r.progress * 100)}%`,
            r.status === "rendering" ? h("div", { class: "bar" }, h("i", { style: { width: `${r.progress * 100}%` } })) : null,
          ),
        );
  return h("div", { class: "render" },
    media,
    h("div", { class: "body" },
      h("div", { class: "title" }, r.plan.hook || r.plan.title),
      r.error ? h("div", { class: "err" }, r.error) : null,
      h("div", { class: "caption" }, caption),
      h("div", { class: "row" },
        r.status === "done" ? h("a", { class: "btn small primary", href: `/media/render/${r.id}.mp4?dl=1` }, "Download") : null,
        h("button", {
          class: "btn small",
          onclick: async (e) => {
            await navigator.clipboard.writeText(caption);
            e.target.textContent = "Copied!";
            setTimeout(() => (e.target.textContent = "Copy caption"), 1500);
          },
        }, "Copy caption"),
        h("button", {
          class: "btn small", title: "Delete",
          onclick: async () => {
            await api(`/api/renders/${r.id}`, { method: "DELETE" });
            renderEls.delete(r.id);
            refreshRenders();
          },
        }, "Delete"),
      ),
    ),
  );
}

// ---- Shared albums ----------------------------------------------------------

async function refreshAlbums() {
  const albums = await api("/api/albums");
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
  const a = await api("/api/auto");
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

$("#btn-batch").addEventListener("click", (e) =>
  withBusy(e.currentTarget, "Preparing… (checking albums, writing overlays)", async () => {
    const r = await api("/api/batch/run", { method: "POST" });
    if (r.warning) banner(r.warning);
    else banner(`Queued ${r.renders.length} videos for review.`, "ok");
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
function renderBatch() {
  const batches = [...new Set(state.renders.map((r) => r.batch).filter(Boolean))].sort().reverse();
  const latest = batches[0];
  const items = state.renders.filter((r) => r.batch && r.batch === latest);
  $("#batch-empty").hidden = items.length > 0;
  const approved = items.filter((r) => r.review === "approved").length;
  $("#batch-date").textContent = latest ? `${latest} · ${approved}/${items.length} approved` : "";
  $("#batch").replaceChildren(
    ...items.map((r) => {
      const key = `${r.id}:${r.status}:${r.review}:${r.status === "done" ? "" : Math.round(r.progress * 20)}`;
      const cached = batchEls.get(r.id);
      if (cached?.key === key) return cached.node;
      const node = reviewCard(r);
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
            r.status === "error" ? "Render failed" : r.status === "queued" ? "Queued…" : `Rendering… ${Math.round(r.progress * 100)}%`,
            r.status === "rendering" ? h("div", { class: "bar" }, h("i", { style: { width: `${r.progress * 100}%` } })) : null,
          ),
        );
  const overlayInputs = (r.plan.overlays?.length ? r.plan.overlays.map((o) => o.text) : [r.plan.hook]).map((t, i) =>
    h("input", { value: t, title: i === 0 ? "On-screen overlay text" : "Second overlay (appears later)" }),
  );
  const captionText = [r.plan.postCaption, r.plan.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  const caption = h("textarea", { title: "Post caption" }, captionText);
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
  return h("div", { class: `render ${r.review}` },
    media,
    h("div", { class: "body" },
      h("span", { class: `pill ${r.review}` }, r.review === "pending" ? "needs review" : r.review),
      r.error ? h("div", { class: "err" }, r.error) : null,
      r.plan.concept ? h("div", { class: "concept" }, r.plan.concept) : null,
      h("div", { class: "overlay-edit" },
        overlayInputs[0],
        h("button", {
          class: "btn small", title: "Render again with this overlay text and the current font/style",
          onclick: (e) => withBusy(e.currentTarget, "…", async () => {
            await api(`/api/renders/${r.id}/rerender`, {
              method: "POST",
              body: { overlays: overlayInputs.map((i) => i.value), options: { fontId: state.status.settings.fontId, textStyle: state.status.settings.textStyle } },
            });
            await refreshRenders();
          }),
        }, "Re-render"),
      ),
      ...overlayInputs.slice(1).map((inp) => h("div", { class: "overlay-edit" }, inp)),
      caption,
      h("div", { class: "row" },
        r.status === "done" ? h("a", { class: "btn small primary", href: `/media/render/${r.id}.mp4?dl=1`, onclick: () => r.review !== "approved" && setReview("approved") }, "Approve & download") : null,
        h("button", {
          class: "btn small",
          onclick: async (e) => {
            await navigator.clipboard.writeText(caption.value);
            e.target.textContent = "Copied!";
            setTimeout(() => (e.target.textContent = "Copy caption"), 1500);
          },
        }, "Copy caption"),
        r.review !== "rejected" ? h("button", { class: "btn small", onclick: () => setReview("rejected") }, "Reject") : h("button", { class: "btn small", onclick: () => setReview("pending") }, "Undo"),
      ),
    ),
  );
}

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
  $("#fonts").replaceChildren(
    ...fonts.map((f) =>
      h("button", {
        type: "button",
        class: `font ${f.id === current?.id ? "on" : ""}`,
        title: f.vibe,
        onclick: async () => {
          state.status.settings = await api("/api/settings", { method: "PUT", body: { fontId: f.id } });
          loadFonts();
        },
      },
        h("span", { class: "fname", style: { fontFamily: `"${fontFamily(f)}", sans-serif` } }, f.name),
        h("span", { class: "fvibe" }, f.vibe),
      ),
    ),
  );
}

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

$("#example-form").file.addEventListener("change", (e) => ($("#example-file").textContent = e.target.files[0]?.name || "no video (optional)"));
$("#example-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector("button[type=submit]"), "Adding…", async () => {
    await api("/api/examples", { method: "POST", body: new FormData(form) });
    form.reset();
    $("#example-file").textContent = "no video (optional)";
    await refreshExamples();
  });
});

// ---- Boot & polling ---------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.get("google") === "connected") banner("Google Photos connected. Now pick the clips you want to use.", "ok");
if (params.get("google_error")) banner(`Google sign-in failed: ${params.get("google_error")}`);
if (params.size) history.replaceState(null, "", "/");

await loadStatus();
await Promise.all([refreshClips(), refreshRenders(), refreshAlbums(), loadAuto(), loadTrends(), loadFonts(), refreshExamples()]);

setInterval(async () => {
  const busyClips = state.clips.some((c) => c.status === "importing" || c.status === "analyzing");
  const busyRenders = state.renders.some((r) => r.status === "queued" || r.status === "rendering");
  if (busyClips) await Promise.all([refreshClips(), refreshAlbums()]).catch(() => {});
  if (busyRenders) await refreshRenders().catch(() => {});
  if (state.examplesBusy) await refreshExamples().catch(() => {});
}, 2000);
