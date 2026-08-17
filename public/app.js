const state = {
  tasks: [],
  selectedId: null,
  pollTimer: null,
};

const $ = (sel, el = document) => el.querySelector(sel);

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("is-active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("is-active", p.id === `panel-${name}`);
  });
  if (name === "runs") loadRuns();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function checkHealth() {
  try {
    const h = await api("/api/health");
    $("#health").textContent = h.message;
  } catch {
    $("#health").textContent = "Server offline";
  }
}

function renderTasks() {
  const list = $("#task-list");
  list.innerHTML = state.tasks
    .map(
      (t) => `
    <button class="task ${t.id === state.selectedId ? "is-selected" : ""}" data-id="${t.id}" type="button">
      <div class="task-top">
        <span class="badge badge-${t.type}">${t.type}</span>
        <h3>${escapeHtml(t.name)}</h3>
      </div>
      <p>${escapeHtml(t.description)}</p>
    </button>`
    )
    .join("");

  list.querySelectorAll(".task").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedId = btn.dataset.id;
      renderTasks();
      renderRunner();
    });
  });
}

function renderInputField(input) {
  if (input.type === "textarea") {
    const rows = input.rows || 10;
    return `
      <div class="field">
        <label for="in-${input.key}">${escapeHtml(input.label)}</label>
        <textarea id="in-${input.key}" name="${input.key}" rows="${rows}" ${input.required ? "required" : ""}>${escapeHtml(input.default || "")}</textarea>
      </div>`;
  }
  if (input.type === "password") {
    return `
      <div class="field">
        <label for="in-${input.key}">${escapeHtml(input.label)}</label>
        <input id="in-${input.key}" name="${input.key}" type="password" autocomplete="current-password"
          value="${escapeAttr(input.default || "")}" ${input.required ? "required" : ""}
          placeholder="Type your Facebook password" />
      </div>`;
  }
  if (input.type === "checkbox") {
    const checked = truthyDefault(input.default) ? "checked" : "";
    return `
      <div class="field">
        <label class="check-label">
          <input type="checkbox" id="in-${input.key}" name="${input.key}" ${checked} />
          ${escapeHtml(input.label)}
        </label>
      </div>`;
  }
  if (input.type === "files") {
    return `
      <div class="field">
        <label>${escapeHtml(input.label)}</label>
        <input type="file" id="in-${input.key}-files" accept="image/*" multiple />
        <input type="hidden" id="in-${input.key}" name="${input.key}" value="${escapeAttr(input.default || "")}" />
        <p class="watch-hint" id="photo-hint">Default photos: ${escapeHtml(input.default || "none")}. Choose new files to replace.</p>
        <div class="photo-preview" id="photo-preview"></div>
      </div>`;
  }
  return `
    <div class="field">
      <label for="in-${input.key}">${escapeHtml(input.label)}</label>
      <input id="in-${input.key}" name="${input.key}" type="${input.type === "url" ? "url" : "text"}"
        value="${escapeAttr(input.default || "")}" ${input.required ? "required" : ""}
        ${input.key === "fbPhone" ? 'placeholder="e.g. 011132477765" autocomplete="username"' : ""} />
    </div>`;
}

function truthyDefault(v) {
  return String(v).toLowerCase() === "true" || v === true || v === "1";
}

function renderRunner() {
  const task = state.tasks.find((t) => t.id === state.selectedId);
  const box = $("#runner");
  if (!task) {
    box.innerHTML = `<p class="muted">Select a task to configure and run it.</p>`;
    return;
  }

  const isFb = task.id === "rpa-fb-marketplace";
  const googleAccountField = isFb
    ? `
        <div class="field" style="margin-top:0.65rem">
          <label for="in-chromeProfile"><strong>Google account (Chrome profile)</strong></label>
          <select id="in-chromeProfile" name="chromeProfile">
            <option value="fresh">Loading your Chrome accounts…</option>
          </select>
          <p class="watch-hint">Copies that Google profile into an isolated Chrome (keeps your main Chrome safe). First run may take up to ~1 min to sync.</p>
        </div>`
    : "";

  const watchControls =
    task.type === "rpa"
      ? `
      <div class="watch-box">
        <div class="field" style="margin-top:0">
          <label for="in-browser"><strong>Browser</strong></label>
          <select id="in-browser" name="browser">
            <option value="chrome" selected>Google Chrome</option>
            <option value="edge">Microsoft Edge</option>
            <option value="chromium">Chromium (bundled)</option>
          </select>
        </div>
        ${googleAccountField}
        <label class="check-label" style="margin-top:0.65rem">
          <input type="checkbox" name="forceCloseChrome" checked />
          Auto-close Chrome first (needed to unlock your Google profile)
        </label>
        <label class="check-label" style="margin-top:0.65rem">
          <input type="checkbox" name="watchBrowser" checked />
          Watch browser &amp; red cursor on screen
        </label>
        <div class="field" style="margin-bottom:0;margin-top:0.65rem">
          <label for="in-slowMo">Slow motion (ms per action)</label>
          <input id="in-slowMo" name="slowMo" type="text" value="${isFb ? "250" : "400"}" />
        </div>
        <p class="watch-hint">${
          isFb
            ? "Uses your real Chrome Google account so Facebook stays logged in."
            : "Uses the .exe for the browser you pick — not the Windows default."
        }</p>
      </div>`
      : "";

  // FB: login fields first, then browser, then listing
  const loginKeys = new Set(["fbPhone", "fbPassword"]);
  const loginHtml = task.inputs
    .filter((i) => loginKeys.has(i.key))
    .map(renderInputField)
    .join("");
  const otherHtml = task.inputs
    .filter((i) => !loginKeys.has(i.key))
    .map(renderInputField)
    .join("");
  const formBody = isFb
    ? `${loginHtml}${watchControls}${otherHtml}`
    : `${task.inputs.map(renderInputField).join("")}${watchControls}`;

  box.innerHTML = `
    <div class="task-top">
      <span class="badge badge-${task.type}">${task.type}</span>
    </div>
    <h2>${escapeHtml(task.name)}</h2>
    <p class="learn-note">${escapeHtml(task.learn)}</p>
    ${
      isFb
        ? `<p class="learn-note" style="color:var(--ink)"><strong>Step 1:</strong> Type your Facebook phone &amp; password — the bot will enter them on Facebook.</p>`
        : ""
    }
    <form id="run-form">
      ${formBody}
      <div class="actions">
        <button class="primary" type="submit" id="run-btn">${
          isFb ? "Paste & post (Marketplace + groups)" : "Run on this device"
        }</button>
      </div>
    </form>
    <div id="live"></div>
  `;

  if (isFb) loadChromeProfilesIntoSelect();

  const fileInput = $("#in-photos-files");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files?.length) return;
      const body = new FormData();
      [...fileInput.files].forEach((f) => body.append("photos", f));
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Upload failed");
        return;
      }
      const paths = data.files.map((f) => f.path).join(",");
      $("#in-photos").value = paths;
      $("#photo-hint").textContent = `Uploaded ${data.files.length} file(s). Ready to post.`;
      $("#photo-preview").innerHTML = data.files
        .map((f) => `<img src="${f.url}" alt="" />`)
        .join("");
    });
  }

  const photosHidden = $("#in-photos");
  if (photosHidden?.value) {
    const preview = $("#photo-preview");
    if (preview) {
      preview.innerHTML = photosHidden.value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<img src="/uploads/${p}" alt="" />`)
        .join("");
    }
  }

  $("#run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const inputs = {};
    task.inputs.forEach((input) => {
      const el = form.elements[input.key];
      if (!el) return;
      if (input.type === "checkbox") {
        inputs[input.key] = el.checked ? "true" : "false";
      } else {
        inputs[input.key] = el.value.trim();
      }
    });
    if (task.type === "rpa") {
      inputs.watchBrowser = form.elements.watchBrowser?.checked ? "true" : "false";
      inputs.slowMo = form.elements.slowMo?.value.trim() || "400";
      inputs.browser = (form.elements.browser && form.elements.browser.value) || "chrome";
      if (form.elements.chromeProfile) {
        inputs.chromeProfile = form.elements.chromeProfile.value;
      }
      if (form.elements.forceCloseChrome) {
        inputs.forceCloseChrome = form.elements.forceCloseChrome.checked
          ? "true"
          : "false";
      }
      console.log("[RPA] browser:", inputs.browser, "profile:", inputs.chromeProfile);
    }
    await startRun(task.id, inputs);
  });
}

async function loadChromeProfilesIntoSelect() {
  const sel = $("#in-chromeProfile");
  if (!sel) return;
  try {
    const data = await api("/api/chrome-profiles");
    const profiles = data.profiles || [];
    const preferred =
      profiles.find((p) => /yongchernghann123@gmail\.com/i.test(p.email)) ||
      profiles.find((p) => p.id === "Default") ||
      profiles[0];

    sel.innerHTML =
      `<option value="fresh">Fresh Chrome (empty — log in each time)</option>` +
      profiles
        .map(
          (p) =>
            `<option value="${escapeAttr(p.id)}" ${
              preferred && p.id === preferred.id ? "selected" : ""
            }>${escapeHtml(p.label)}</option>`
        )
        .join("");

    if (!profiles.length) {
      sel.innerHTML = `<option value="fresh">No Chrome profiles found — using fresh</option>`;
    }
  } catch (err) {
    sel.innerHTML = `<option value="fresh">Could not load profiles — using fresh</option>`;
  }
}

async function startRun(taskId, inputs) {
  clearInterval(state.pollTimer);
  const live = $("#live");
  const btn = $("#run-btn");
  if (btn) btn.disabled = true;

  live.innerHTML = `<p class="muted">Starting…</p>`;

  try {
    const started = await api(`/api/tasks/${taskId}/run`, {
      method: "POST",
      body: JSON.stringify({ inputs }),
    });
    live.innerHTML = `
      <p style="margin:1rem 0 0.4rem">
        Run <code>${started.id.slice(0, 8)}</code>
        <span class="status-pill status-running" id="live-status">running</span>
      </p>
      <div class="logs" id="live-logs"></div>
      <div id="live-result"></div>
    `;
    state.pollTimer = setInterval(() => pollRun(started.id), 700);
    await pollRun(started.id);
  } catch (err) {
    live.innerHTML = `<p class="muted" style="color:var(--bad)">${escapeHtml(err.message)}</p>`;
    if (btn) btn.disabled = false;
  }
}

async function pollRun(id) {
  try {
    const run = await api(`/api/runs/${id}`);
    const statusEl = $("#live-status");
    const logsEl = $("#live-logs");
    const resultEl = $("#live-result");
    const btn = $("#run-btn");

    if (statusEl) {
      statusEl.textContent = run.status;
      statusEl.className = `status-pill status-${run.status}`;
    }

    if (logsEl) {
      logsEl.innerHTML = run.logs
        .map(
          (l) =>
            `<div class="${l.level === "error" ? "log-error" : l.level === "success" ? "log-success" : ""}">${escapeHtml(l.message)}</div>`
        )
        .join("");
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    if (run.status !== "running") {
      clearInterval(state.pollTimer);
      if (btn) btn.disabled = false;
      if (resultEl && run.result) {
        resultEl.innerHTML = renderResult(run);
      }
      if (resultEl && run.error) {
        resultEl.innerHTML = `<div class="result-box">${escapeHtml(run.error)}</div>`;
      }
    }
  } catch {
    /* ignore transient poll errors */
  }
}

function renderResult(run) {
  const r = run.result || {};
  let extra = "";
  if (r.screenshotUrl) {
    extra = `<img src="${escapeAttr(r.screenshotUrl)}" alt="Screenshot artifact" />`;
  }
  return `<div class="result-box">${escapeHtml(JSON.stringify(r, null, 2))}${extra}</div>`;
}

async function loadRuns() {
  const runs = await api("/api/runs");
  const list = $("#runs-list");
  const detail = $("#run-detail");
  detail.hidden = true;

  if (!runs.length) {
    list.innerHTML = `<p class="muted">No runs yet. Start a task from the Tasks tab.</p>`;
    return;
  }

  list.innerHTML = runs
    .map(
      (r) => `
    <button class="run-row" data-id="${r.id}" type="button">
      <span class="badge badge-${r.type}">${r.type}</span>
      <strong>${escapeHtml(r.taskName)}</strong>
      <span class="status-pill status-${r.status}">${r.status}</span>
      <time>${new Date(r.startedAt).toLocaleString()}</time>
    </button>`
    )
    .join("");

  list.querySelectorAll(".run-row").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const run = await api(`/api/runs/${btn.dataset.id}`);
      detail.hidden = false;
      detail.innerHTML = `
        <div class="task-top">
          <span class="badge badge-${run.type}">${run.type}</span>
          <span class="status-pill status-${run.status}">${run.status}</span>
        </div>
        <h2 style="margin:0.4rem 0">${escapeHtml(run.taskName)}</h2>
        <p class="muted">Run id: ${run.id}</p>
        <div class="logs">${run.logs
          .map(
            (l) =>
              `<div class="${l.level === "error" ? "log-error" : l.level === "success" ? "log-success" : ""}">${escapeHtml(l.message)}</div>`
          )
          .join("")}</div>
        ${run.result ? renderResult(run) : ""}
        ${run.error ? `<div class="result-box">${escapeHtml(run.error)}</div>` : ""}
      `;
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

async function init() {
  await checkHealth();
  state.tasks = await api("/api/tasks");
  renderTasks();
  if (state.tasks[0]) {
    state.selectedId = state.tasks[0].id;
    renderTasks();
    renderRunner();
  }
}

init();
