const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const ARTIFACTS = path.join(__dirname, "..", "artifacts");
const PORT = process.env.PORT || 3847;
const LOCAL = `http://127.0.0.1:${PORT}`;

function ensureArtifacts() {
  if (!fs.existsSync(ARTIFACTS)) fs.mkdirSync(ARTIFACTS, { recursive: true });
}

function truthy(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseSlowMo(inputs, watch) {
  if (!watch) return 0;
  const n = Number(inputs.slowMo);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 2000);
  return 400;
}

/** Use installed Chrome / Edge, or Playwright Chromium — respects UI choice, ignores OS default */
function parseBrowserChannel(inputs) {
  const raw = String(inputs.browser || "chrome")
    .toLowerCase()
    .trim();
  if (raw === "edge" || raw === "msedge" || raw === "microsoft edge") {
    return {
      channel: "msedge",
      label: "Microsoft Edge",
      exeCandidates: [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ],
    };
  }
  if (raw === "chromium" || raw === "bundled") {
    return { channel: null, label: "Chromium (Playwright)", exeCandidates: [] };
  }
  return {
    channel: "chrome",
    label: "Google Chrome",
    exeCandidates: [
      process.env.CHROME_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            "Google",
            "Chrome",
            "Application",
            "chrome.exe"
          )
        : null,
    ].filter(Boolean),
  };
}

function findBrowserExe(candidates) {
  for (const p of candidates || []) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Red cursor ring so you can see mouse moves on screen */
async function installCursorHighlight(page) {
  await page.addInitScript(() => {
    const boot = () => {
      if (document.getElementById("__rpa_cursor")) return;
      const dot = document.createElement("div");
      dot.id = "__rpa_cursor";
      Object.assign(dot.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "24px",
        height: "24px",
        borderRadius: "50%",
        border: "2px solid #e11d48",
        background: "rgba(225, 29, 72, 0.28)",
        boxShadow: "0 0 0 4px rgba(225, 29, 72, 0.15)",
        pointerEvents: "none",
        zIndex: "2147483647",
        transform: "translate(-50%, -50%)",
        transition: "width 80ms, height 80ms",
      });
      (document.documentElement || document.body).appendChild(dot);
      window.addEventListener(
        "mousemove",
        (e) => {
          dot.style.left = `${e.clientX}px`;
          dot.style.top = `${e.clientY}px`;
        },
        true
      );
      window.addEventListener(
        "mousedown",
        () => {
          dot.style.width = "16px";
          dot.style.height = "16px";
        },
        true
      );
      window.addEventListener(
        "mouseup",
        () => {
          dot.style.width = "24px";
          dot.style.height = "24px";
        },
        true
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  });
}

async function humanMove(page, selector) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 20,
    });
  }
  return loc;
}

async function humanClick(page, selector, log, label) {
  const loc = await humanMove(page, selector);
  log(`Click → ${label || selector}`);
  await loc.click();
}

async function humanType(page, selector, text, log, label) {
  await humanClick(page, selector, log, label || `focus ${selector}`);
  await page.locator(selector).first().fill("");
  log(`Type → ${label || selector}: "${text}"`);
  await page.locator(selector).first().pressSequentially(String(text), {
    delay: 45,
  });
}

async function snap(page, prefix, log) {
  const fileName = `${prefix}-${Date.now()}.png`;
  const filePath = path.join(ARTIFACTS, fileName);
  await page.screenshot({ path: filePath, fullPage: true });
  log(`Screenshot saved: ${fileName}`);
  return `/artifacts/${fileName}`;
}

async function withBrowser(fn, log, inputs = {}) {
  ensureArtifacts();
  const watch = truthy(inputs.watchBrowser, true);
  const slowMo = parseSlowMo(inputs, watch);
  const { channel, label, exeCandidates } = parseBrowserChannel(inputs);
  const exe = findBrowserExe(exeCandidates);

  log(
    watch
      ? `Launching ${label} ON YOUR SCREEN (slowMo ${slowMo}ms) — watch the red cursor…`
      : `Launching ${label} headless…`
  );
  if (exe) log(`Executable: ${exe}`);

  const launchOptions = {
    headless: !watch,
    slowMo,
  };
  // Prefer .exe path so Windows default browser is ignored
  if (exe) launchOptions.executablePath = exe;
  else if (channel) launchOptions.channel = channel;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err) {
    const hint =
      channel === "chrome"
        ? "Install Google Chrome, or switch Browser to Edge / Chromium."
        : channel === "msedge"
          ? "Install Microsoft Edge, or switch Browser to Chrome / Chromium."
          : err.message;
    throw new Error(`Could not launch ${label}. ${hint} (${err.message})`);
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  if (watch) await installCursorHighlight(page);

  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    log(`UA: ${ua.slice(0, 100)}…`);
    return await fn(page, log);
  } finally {
    if (watch) {
      log("Leaving browser open 1.5s so you can see the final screen…");
      await page.waitForTimeout(1500);
    }
    await browser.close();
    log("Browser closed");
  }
}

/** RPA: screenshot any public page */
async function rpaScreenshot(inputs, log) {
  const url = inputs.url;
  if (!url) throw new Error("url is required");

  return withBrowser(async (page) => {
    log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.mouse.move(200, 200, { steps: 15 });
    await page.mouse.move(640, 360, { steps: 20 });
    const title = await page.title();
    log(`Page title: ${title}`);
    const screenshotUrl = await snap(page, "screenshot", log);
    return { title, url, screenshotUrl };
  }, log, inputs);
}

/** RPA: scrape title + links */
async function rpaScrapeTitles(inputs, log) {
  const url = inputs.url;
  if (!url) throw new Error("url is required");

  return withBrowser(async (page) => {
    log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const title = await page.title();
    log(`Document title: ${title}`);
    const links = await page.$$eval("a[href]", (anchors) =>
      anchors
        .map((a) => ({
          text: (a.textContent || "").trim().slice(0, 80),
          href: a.href,
        }))
        .filter((l) => l.text && l.href.startsWith("http"))
        .slice(0, 20)
    );
    log(`Collected ${links.length} links`);
    const screenshotUrl = await snap(page, "scrape", log);
    return { title, url, links, screenshotUrl };
  }, log, inputs);
}

/** RPA: fill the built-in practice form */
async function rpaFormDemo(inputs, log) {
  const { name, email, message } = inputs;
  if (!name || !email || !message) {
    throw new Error("name, email, and message are required");
  }

  const formUrl = `${LOCAL}/practice-form.html`;

  return withBrowser(async (page) => {
    log(`Opening practice form: ${formUrl}`);
    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await humanType(page, "#name", name, log, "Name");
    await humanType(page, "#email", email, log, "Email");
    await humanType(page, "#message", message, log, "Message");
    await humanClick(page, 'button[type="submit"]', log, "Submit");
    await page.waitForSelector("#result.visible", { timeout: 5000 });
    const resultText = (await page.textContent("#result")).trim();
    log(`Form result: ${resultText}`);
    const screenshotUrl = await snap(page, "form", log);
    return {
      submitted: { name, email, message },
      resultText,
      screenshotUrl,
    };
  }, log, inputs);
}

/**
 * Complex RPA: shop search → filter → add to cart → checkout → confirm
 */
async function rpaShopCheckout(inputs, log) {
  const search = inputs.search || "notebook";
  const category = inputs.category || "office";
  const shipName = inputs.shipName || "Ada Lovelace";
  const shipEmail = inputs.shipEmail || "ada@example.com";
  const shipCity = inputs.shipCity || "London";
  const shipNote = inputs.shipNote || "Leave at reception";

  return withBrowser(async (page) => {
    const steps = [];
    log("Step 1/6 — Open Demo Shop playground");
    await page.goto(`${LOCAL}/playground.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    steps.push("opened shop");

    log("Step 2/6 — Type search + choose category");
    await humanType(page, "#search", search, log, "Search");
    await humanClick(page, "#category", log, "Category dropdown");
    await page.selectOption("#category", category);
    log(`Selected category: ${category}`);
    await humanClick(page, "#apply-filters", log, "Apply filters");
    steps.push(`filtered ${search}/${category}`);

    log("Step 3/6 — Add first visible product to cart");
    const addBtn = page.locator(".add-to-cart").first();
    await addBtn.waitFor({ state: "visible", timeout: 5000 });
    const productName = await page.locator(".product h3").first().textContent();
    await humanClick(page, ".add-to-cart", log, `Add ${productName}`);
    steps.push(`added ${productName}`);

    log("Step 4/6 — Go to checkout");
    await humanClick(page, "#go-checkout", log, "Go to checkout");
    await page.waitForSelector("#ship-name", { timeout: 5000 });
    steps.push("checkout");

    log("Step 5/6 — Fill shipping form");
    await humanType(page, "#ship-name", shipName, log, "Full name");
    await humanType(page, "#ship-email", shipEmail, log, "Email");
    await humanType(page, "#ship-city", shipCity, log, "City");
    await humanType(page, "#ship-note", shipNote, log, "Note");

    log("Step 6/6 — Place order");
    await humanClick(page, "#place-order", log, "Place order");
    await page.waitForSelector("#screen-confirm.is-active", { timeout: 5000 });
    const banner = (await page.textContent("#order-banner")).trim();
    const summary = (await page.textContent("#order-summary")).trim();
    log(`Confirmed: ${banner}`);
    steps.push("order placed");

    const screenshotUrl = await snap(page, "shop", log);
    return {
      steps,
      productName: productName.trim(),
      confirmation: banner,
      summary,
      screenshotUrl,
    };
  }, log, inputs);
}

/**
 * Complex RPA: login → open ticket → resolve with note
 */
async function rpaOfficeInbox(inputs, log) {
  const username = inputs.username || "agent";
  const password = inputs.password || "automate";
  const ticketId = inputs.ticketId || "T-101";
  const resolution =
    inputs.resolution || "Fixed via RPA demo — cleared cache and retested export.";

  return withBrowser(async (page) => {
    const steps = [];
    log("Step 1/5 — Open Office login");
    await page.goto(`${LOCAL}/playground.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await humanClick(page, 'button[data-goto="office"]', log, "Office inbox nav");
    await page.waitForSelector("#login-user", { timeout: 5000 });
    steps.push("login screen");

    log("Step 2/5 — Sign in");
    await humanType(page, "#login-user", username, log, "Username");
    await humanType(page, "#login-pass", password, log, "Password");
    await humanClick(page, "#do-login", log, "Sign in");
    await page.waitForSelector("#screen-inbox.is-active", { timeout: 5000 });
    steps.push("signed in");

    log(`Step 3/5 — Open ticket ${ticketId}`);
    await humanClick(page, `[data-ticket-id="${ticketId}"]`, log, `Ticket ${ticketId}`);
    await page.waitForSelector("#ticket-panel:not(.hidden)", { timeout: 5000 });
    const title = (await page.textContent("#ticket-title")).trim();
    steps.push(`opened ${ticketId}`);

    log("Step 4/5 — Write resolution note");
    await humanType(page, "#resolution", resolution, log, "Resolution");

    log("Step 5/5 — Mark resolved");
    await humanClick(page, "#resolve-ticket", log, "Mark resolved");
    await page.waitForTimeout(400);
    const badge = await page
      .locator(`[data-ticket-id="${ticketId}"] .badge`)
      .textContent();
    log(`Ticket status badge: ${badge.trim()}`);
    steps.push("resolved");

    const screenshotUrl = await snap(page, "inbox", log);
    return {
      steps,
      ticketId,
      ticketTitle: title,
      resolution,
      status: badge.trim(),
      screenshotUrl,
    };
  }, log, inputs);
}

/**
 * Complex RPA: build filtered ops report + extract table rows
 */
async function rpaOpsReport(inputs, log) {
  const team = inputs.team || "support";
  const status = inputs.status || "open";

  return withBrowser(async (page) => {
    const steps = [];
    log("Step 1/4 — Open report screen");
    await page.goto(`${LOCAL}/playground.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await humanClick(page, 'button[data-goto="report"]', log, "Report nav");
    await page.waitForSelector("#report-team", { timeout: 5000 });
    steps.push("report screen");

    log("Step 2/4 — Set filters");
    await humanClick(page, "#report-team", log, "Team filter");
    await page.selectOption("#report-team", team);
    await humanClick(page, "#report-status", log, "Status filter");
    await page.selectOption("#report-status", status);
    steps.push(`filters ${team}/${status}`);

    log("Step 3/4 — Build report");
    await humanClick(page, "#build-report", log, "Build report");
    await page.waitForTimeout(300);

    log("Step 4/4 — Scrape table rows");
    const rows = await page.$$eval("#report-body tr", (trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
        return { id: cells[0], team: cells[1], task: cells[2], status: cells[3] };
      })
    );
    const meta = (await page.textContent("#report-meta")).trim();
    log(`Extracted ${rows.length} rows — ${meta}`);
    steps.push("scraped table");

    const screenshotUrl = await snap(page, "report", log);
    return { steps, team, status, meta, rows, screenshotUrl };
  }, log, inputs);
}

/**
 * Complex hybrid: APA fetch todos → RPA paste into practice form (watch cursor)
 */
async function hybridApiToForm(inputs, log) {
  const todoId = String(inputs.todoId || "1");
  const apiUrl = `https://jsonplaceholder.typicode.com/todos/${todoId}`;

  log(`APA step — GET ${apiUrl}`);
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  const todo = await res.json();
  log(`Got todo: "${todo.title}" (completed=${todo.completed})`);

  return withBrowser(async (page) => {
    log("RPA step — open form and type API data");
    await page.goto(`${LOCAL}/practice-form.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await humanType(page, "#name", `User ${todo.userId}`, log, "Name from API userId");
    await humanType(
      page,
      "#email",
      `todo${todo.id}@example.com`,
      log,
      "Email from todo id"
    );
    await humanType(page, "#message", todo.title, log, "Message = todo title");
    await humanClick(page, 'button[type="submit"]', log, "Submit");
    await page.waitForSelector("#result.visible", { timeout: 5000 });
    const resultText = (await page.textContent("#result")).trim();
    const screenshotUrl = await snap(page, "hybrid", log);
    return {
      apiTodo: { id: todo.id, title: todo.title, completed: todo.completed },
      resultText,
      screenshotUrl,
    };
  }, log, inputs);
}

/** APA: simple GET */
async function apaHttpGet(inputs, log) {
  const url = inputs.url;
  if (!url) throw new Error("url is required");

  log(`GET ${url}`);
  const res = await fetch(url, {
    headers: { Accept: "application/json, text/plain, */*" },
  });
  const contentType = res.headers.get("content-type") || "";
  let body;
  if (contentType.includes("application/json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  log(`Response status: ${res.status}`);

  return { status: res.status, ok: res.ok, contentType, body };
}

/** APA: POST JSON */
async function apaPostJson(inputs, log) {
  const { url, title, body } = inputs;
  if (!url) throw new Error("url is required");

  const payload = {
    title: title || "Untitled",
    body: body || "",
    userId: 1,
  };

  log(`POST ${url}`);
  log(`Payload: ${JSON.stringify(payload)}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  log(`Response status: ${res.status}`);

  return { status: res.status, ok: res.ok, body: data };
}

/** APA: chain user → posts */
async function apaChain(inputs, log) {
  const userId = String(inputs.userId || "1");
  const base = "https://jsonplaceholder.typicode.com";

  log(`Step 1: GET ${base}/users/${userId}`);
  const userRes = await fetch(`${base}/users/${userId}`);
  if (!userRes.ok) throw new Error(`User fetch failed: ${userRes.status}`);
  const user = await userRes.json();
  log(`Found user: ${user.name} <${user.email}>`);

  log(`Step 2: GET ${base}/posts?userId=${userId}`);
  const postsRes = await fetch(`${base}/posts?userId=${userId}`);
  if (!postsRes.ok) throw new Error(`Posts fetch failed: ${postsRes.status}`);
  const posts = await postsRes.json();
  log(`Found ${posts.length} posts`);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      company: user.company?.name,
    },
    posts: posts.slice(0, 5).map((p) => ({ id: p.id, title: p.title })),
    totalPosts: posts.length,
  };
}

module.exports = {
  "rpa-fb-marketplace": require("./marketplace").rpaFbMarketplace,
  "rpa-screenshot": rpaScreenshot,
  "rpa-scrape-titles": rpaScrapeTitles,
  "rpa-form-demo": rpaFormDemo,
  "rpa-shop-checkout": rpaShopCheckout,
  "rpa-office-inbox": rpaOfficeInbox,
  "rpa-ops-report": rpaOpsReport,
  "hybrid-api-to-form": hybridApiToForm,
  "apa-http-get": apaHttpGet,
  "apa-post-json": apaPostJson,
  "apa-chain": apaChain,
};
