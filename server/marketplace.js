const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const {
  listChromeProfiles,
  chromeUserDataDir,
  chromeExecutable,
} = require("./chromeProfiles");

const PROFILES_ROOT = path.join(__dirname, "..", "browser-profiles");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const CDP_PORT = 9333;
const MARKETPLACE_URL =
  "https://www.facebook.com/marketplace/create/item?locale=ms_MY";

function truthy(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Resolve exact browser from UI choice — no silent fallback to Edge/system default */
function resolveBrowserChoice(inputs) {
  const raw = String(inputs.browser || "chrome")
    .toLowerCase()
    .trim();

  if (raw === "edge" || raw === "msedge" || raw === "microsoft edge") {
    return {
      id: "msedge",
      channel: "msedge",
      label: "Microsoft Edge",
      profileDir: path.join(PROFILES_ROOT, "fb-msedge"),
      exeCandidates: [
        process.env.EDGE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ].filter(Boolean),
    };
  }

  if (raw === "chromium" || raw === "bundled") {
    return {
      id: "chromium",
      channel: null,
      label: "Chromium (Playwright)",
      profileDir: path.join(PROFILES_ROOT, "fb-chromium"),
      exeCandidates: [],
    };
  }

  // default + "chrome" → Google Chrome only
  return {
    id: "chrome",
    channel: "chrome",
    label: "Google Chrome",
    profileDir: path.join(PROFILES_ROOT, "fb-chrome"),
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

function findExecutable(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** So Chrome does not show “Restore pages? Chrome didn't shut down correctly” */
function markChromeExitClean(profileDir, log) {
  const prefsPath = path.join(profileDir, "Preferences");
  if (!fs.existsSync(prefsPath)) return;
  try {
    const raw = fs.readFileSync(prefsPath, "utf8");
    const prefs = JSON.parse(raw);
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    log(`Cleared crash-restore flag in ${path.basename(profileDir)}/Preferences`);
  } catch (err) {
    log(`Could not patch Preferences: ${err.message}`, "error");
  }
}

async function dismissChromeNags(page, log) {
  try {
    await page.keyboard.press("Escape");
    await sleep(300);
    // Close “Restore pages?” if it still appears
    const closeBtn = page.locator('[aria-label="Close"], [aria-label="Tutup"]').first();
    if (await closeBtn.count()) {
      await closeBtn.click({ timeout: 1000 }).catch(() => {});
    }
    // Prefer dismiss over Restore (Restore reopens many tabs)
    const gotIt = page.getByRole("button", { name: /Got it|OK|Dismiss/i });
    if (await gotIt.count()) await gotIt.first().click().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Close every chrome.exe so Playwright can use your Google profile */
function forceCloseChrome(log) {
  log("Closing all Google Chrome windows…");
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    /* ignore */
  }
  try {
    execSync("taskkill /F /IM chrome.exe /T", {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    /* ignore */
  }
  log("Chrome kill attempted");

  const userDataDir = chromeUserDataDir();
  if (userDataDir) {
    clearProfileLocks(userDataDir);
    try {
      for (const name of fs.readdirSync(userDataDir)) {
        if (name === "Default" || /^Profile /i.test(name)) {
          clearProfileLocks(path.join(userDataDir, name));
          markChromeExitClean(path.join(userDataDir, name), log);
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Copy your Chrome Google profile into an isolated folder so automation
 * does not fight with your everyday Chrome (no profile lock / about:blank).
 */
function syncIsolatedProfile(chromeProfile, log) {
  const userDataDir = chromeUserDataDir();
  const src = path.join(userDataDir, chromeProfile);
  if (!fs.existsSync(src)) {
    throw new Error(`Chrome profile folder not found: ${src}`);
  }

  const destRoot = path.join(
    PROFILES_ROOT,
    `isolated-${chromeProfile.replace(/[^\w.-]+/g, "_")}`
  );
  const destDefault = path.join(destRoot, "Default");
  fs.mkdirSync(destDefault, { recursive: true });

  log(
    `Syncing Chrome profile "${chromeProfile}" → isolated automation copy (may take 30–90s first time)…`
  );

  // robocopy: exit codes 0–7 mean success
  try {
    execSync(
      `robocopy "${src}" "${destDefault}" /E /XO /XD Cache "Code Cache" GPUCache DawnCache "GrShaderCache" ShaderCache "Service Worker" Crashpad "OptimizationGuidePredictionModels" /NFL /NDL /NJH /NJS /nc /ns /np`,
      { windowsHide: true, stdio: "ignore" }
    );
  } catch (err) {
    if (typeof err.status === "number" && err.status > 7) {
      throw new Error(`Profile sync failed (robocopy ${err.status})`);
    }
  }

  clearProfileLocks(destRoot);
  clearProfileLocks(destDefault);
  markChromeExitClean(destDefault, log);
  // remove stale CDP port file
  for (const f of ["DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(destRoot, f));
    } catch {
      /* ignore */
    }
  }

  log(`Isolated profile ready: ${destRoot}`);
  return destRoot;
}

async function waitForCdp(port, log, tries = 50) {
  for (let i = 1; i <= tries; i++) {
    await sleep(400);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        log(`CDP is up: ${info.Browser || info["User-Agent"] || "ok"}`);
        return true;
      }
    } catch {
      if (i === 10 || i === 25 || i === 40) {
        log(`Waiting for Chrome debug port :${port}… (${i}/${tries})`);
      }
    }
  }
  return false;
}

/**
 * Start isolated Chrome copy of your Google profile + attach via CDP.
 * Opens Marketplace URL immediately.
 */
async function launchChromeProfileViaCDP({
  exe,
  chromeProfile,
  selected,
  log,
  autoClose,
}) {
  const isolatedDir = syncIsolatedProfile(chromeProfile, log);

  // Only kill Chrome if we must free the debug port / previous automation instance
  if (autoClose) {
    forceCloseChrome(log);
    await sleep(2000);
  }

  // Free CDP port
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    /* ignore */
  }

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${isolatedDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    MARKETPLACE_URL,
  ];

  log(`Starting Chrome with isolated profile + CDP :${CDP_PORT}`);
  log(`Startup URL: ${MARKETPLACE_URL}`);

  let stderrBuf = "";
  const child = spawn(exe, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });
  child.stdout.on("data", (d) => {
    stderrBuf += d.toString();
  });

  let exitedEarly = false;
  child.on("exit", (code) => {
    exitedEarly = true;
    log(`Chrome process exited early (code ${code})`, "error");
    if (stderrBuf.trim()) log(stderrBuf.trim().slice(0, 500), "error");
  });

  const cdpReady = await waitForCdp(CDP_PORT, log);
  if (!cdpReady) {
    if (stderrBuf.trim()) log(`Chrome output: ${stderrBuf.trim().slice(0, 800)}`, "error");
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // One more hard retry: kill everything and spawn again
    log("Retry: force-close Chrome and launch again…", "error");
    forceCloseChrome(log);
    await sleep(3000);
    exitedEarly = false;
    const child2 = spawn(exe, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    const ok2 = await waitForCdp(CDP_PORT, log, 40);
    if (!ok2) {
      try {
        child2.kill();
      } catch {
        /* ignore */
      }
      throw new Error(
        "Could not open Chrome debug port. Check that Chrome starts, then retry."
      );
    }
    const browser2 = await chromium.connectOverCDP(
      `http://127.0.0.1:${CDP_PORT}`
    );
    return await finishCdpAttach(browser2, child2, selected, chromeProfile, log);
  }

  if (exitedEarly) {
    throw new Error("Chrome exited before CDP was ready");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  return await finishCdpAttach(browser, child, selected, chromeProfile, log);
}

async function finishCdpAttach(browser, child, selected, chromeProfile, log) {
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome opened but no context found");

  let page =
    context.pages().find((p) => /facebook\.com/i.test(p.url())) ||
    context.pages()[0];
  if (!page) page = await context.newPage();

  await page.bringToFront().catch(() => {});
  await dismissChromeNags(page, log);

  if (!/marketplace\/create/i.test(page.url())) {
    log(`Page is ${page.url()} — navigating to Marketplace…`);
    await page.goto(MARKETPLACE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
  }

  await sleep(800);
  await dismissChromeNags(page, log);
  log(`Chrome ready at: ${page.url()}`);
  log(
    `Using Google profile copy: ${selected?.email || selected?.label || chromeProfile}`
  );

  return {
    browser,
    context,
    page,
    chromeChild: child,
    persistent: true,
    cdp: true,
    chromeProfile,
    alreadyOnMarketplace: /marketplace\/create/i.test(page.url()),
  };
}

async function launchFbBrowser(inputs, log) {
  const choice = resolveBrowserChoice(inputs);
  const watch = truthy(inputs.watchBrowser, true);
  const slowMo = watch ? Math.min(Number(inputs.slowMo) || 200, 2000) : 0;
  const chromeProfile = String(inputs.chromeProfile || "").trim();
  const autoClose = truthy(inputs.forceCloseChrome, true);

  fs.mkdirSync(choice.profileDir, { recursive: true });

  log(`Browser choice from UI: "${String(inputs.browser)}" → ${choice.label}`);

  // ——— Use your real Chrome Google account profile via CDP ———
  if (choice.id === "chrome" && chromeProfile && chromeProfile !== "fresh") {
    const exe = chromeExecutable() || findExecutable(choice.exeCandidates);
    const userDataDir = chromeUserDataDir();
    if (!exe || !userDataDir) {
      throw new Error("Google Chrome User Data folder / chrome.exe not found");
    }

    const { profiles } = listChromeProfiles();
    const selected = profiles.find((p) => p.id === chromeProfile);
    log(`Google account profile: ${selected?.label || chromeProfile}`);
    log(`Chrome User Data: ${userDataDir}`);

    if (autoClose) {
      forceCloseChrome(log);
      log("Waiting 3s for profile unlock…");
      await sleep(3000);
    }

    const launched = await launchChromeProfileViaCDP({
      exe,
      chromeProfile,
      selected,
      log,
      autoClose,
    });

    return {
      ...launched,
      choice,
      stateFile: path.join(choice.profileDir, "fb-storage.json"),
    };
  }

  // ——— Fresh Playwright Chrome (no Google account until you log in) ———
  clearProfileLocks(choice.profileDir);
  log(`Profile: ${choice.profileDir} (fresh / cookie jar)`);

  const exe = findExecutable(choice.exeCandidates);
  if (choice.id === "chrome" || choice.id === "msedge") {
    if (!exe) {
      throw new Error(
        `${choice.label} not found. Install it or set CHROME_PATH / EDGE_PATH`
      );
    }
    log(`FORCING executable: ${exe}`);
  }

  const launchOpts = {
    headless: !watch,
    slowMo,
    args: ["--no-first-run", "--no-default-browser-check"],
  };
  if (exe) launchOpts.executablePath = exe;

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    throw new Error(
      `Could not start ${choice.label}. Quit the browser and retry. (${err.message})`
    );
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });

  const stateFile = path.join(choice.profileDir, "fb-storage.json");
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
        log(`Restored ${state.cookies.length} saved cookies`);
      }
    } catch (err) {
      log(`Could not restore cookies: ${err.message}`, "error");
    }
  }

  const page = await context.newPage();
  log(`Browser version: ${browser.version()}`);
  log("Verified fresh Chrome session");

  return {
    browser,
    context,
    page,
    choice,
    stateFile,
    persistent: false,
    chromeProfile: "fresh",
    chromeChild: null,
    cdp: false,
  };
}

function clearProfileLocks(profileDir) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    const p = path.join(profileDir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function resolvePhotos(inputs) {
  const raw = String(inputs.photos || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.map((p) => {
    if (path.isAbsolute(p) && fs.existsSync(p)) return p;
    const fromUploads = path.join(UPLOADS_DIR, p.replace(/^[/\\]/, ""));
    if (fs.existsSync(fromUploads)) return fromUploads;
    const asIs = path.resolve(p);
    if (fs.existsSync(asIs)) return asIs;
    throw new Error(`Photo not found: ${p}`);
  });
}

/** One paste → title, price, location, full body (no manual field splitting) */
function parseListingPaste(paste) {
  const text = String(paste || "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("Paste your full listing text first");

  const lines = text.split("\n").map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const title = nonEmpty[0] || "For sale";

  const priceMatch = text.match(/\bRM\s*([0-9][0-9,]*(?:\.\d+)?)/i) ||
    text.match(/\b(?:harga|price)\s*[:=]?\s*([0-9][0-9,]*)/i) ||
    text.match(/(?:^|\s)(\d{3,5})(?:\s|$)/m);
  const price = priceMatch
    ? String(priceMatch[1]).replace(/,/g, "")
    : "";

  const locMatch =
    text.match(/📍\s*(?:AREA\s*)?(.+)/i) ||
    text.match(/\bAREA\s+([A-Za-z .]+)/i) ||
    text.match(/\b(?:lokasi|location)\s*[:=]?\s*(.+)/i);
  let location = locMatch ? locMatch[1].trim() : "";
  if (/^kk$/i.test(location) || /\bkk\b/i.test(text)) {
    location = location && !/^kk$/i.test(location) ? location : "Kota Kinabalu";
  }

  return {
    title: title.slice(0, 100),
    price,
    location,
    body: text,
  };
}

function parseCommunityUrls(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      if (/^https?:\/\//i.test(l)) return l;
      if (/^\d+$/.test(l)) return `https://www.facebook.com/groups/${l}`;
      return l;
    })
    .filter((l) => /facebook\.com/i.test(l))
    .slice(0, 20);
}

async function tryFill(page, labels, value, log, fieldName) {
  if (value === undefined || value === null || value === "") return false;

  for (const label of labels) {
    const byLabel = page.getByLabel(label, { exact: false });
    if ((await byLabel.count()) > 0) {
      await byLabel.first().click({ timeout: 3000 }).catch(() => {});
      await byLabel.first().fill(String(value));
      log(`Filled ${fieldName} via label "${label}"`);
      return true;
    }
  }

  for (const label of labels) {
    const byPlaceholder = page.getByPlaceholder(label, { exact: false });
    if ((await byPlaceholder.count()) > 0) {
      await byPlaceholder.first().fill(String(value));
      log(`Filled ${fieldName} via placeholder "${label}"`);
      return true;
    }
  }

  for (const label of labels) {
    const labeled = page.locator(
      `xpath=//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${label.toLowerCase()}")]//following::input[1] | //span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${label.toLowerCase()}")]//following::textarea[1]`
    );
    if ((await labeled.count()) > 0) {
      await labeled.first().fill(String(value));
      log(`Filled ${fieldName} near text "${label}"`);
      return true;
    }
  }

  log(`Could not find field for ${fieldName}`, "error");
  return false;
}

async function tryClick(page, names, log, what) {
  for (const name of names) {
    const btn = page.getByRole("button", { name: new RegExp(name, "i") });
    if ((await btn.count()) > 0) {
      await btn.first().click();
      log(`Clicked ${what}: "${name}"`);
      return true;
    }
  }
  return false;
}

async function ensureLoggedIn(page, log, fallbackUrl, creds = {}) {
  const phone =
    String(creds.phone || process.env.FB_PHONE || "").trim();
  const password =
    String(creds.password || process.env.FB_PASSWORD || "").trim();

  await sleep(800);
  const url = page.url();
  const emailInput = page
    .locator('#email, input[name="email"], input[type="text"]')
    .first();
  const passInput = page
    .locator('#pass, input[name="pass"], input[type="password"]')
    .first();

  const onLogin =
    /login|checkpoint/i.test(url) ||
    ((await emailInput.count()) > 0 && (await passInput.count()) > 0);

  if (!onLogin) {
    // Sometimes Marketplace shows a login wall without /login in URL
    const loginCta = page.getByRole("button", {
      name: /log in|log masuk|allow|continue/i,
    });
    if ((await loginCta.count()) === 0) return;
  }

  if (!phone || !password) {
    log(
      "Facebook login needed — set FB_PHONE / FB_PASSWORD in .env or wait and log in manually (3 min)…",
      "error"
    );
    await page
      .waitForFunction(
        () => !/login|checkpoint/i.test(location.href),
        null,
        { timeout: 180000 }
      )
      .catch(() => {});
  } else {
    log(`Auto-login Facebook with phone ${phone.slice(0, 4)}****…`);

    // Prefer classic login fields
    const userField =
      (await page.locator("#email").count()) > 0
        ? page.locator("#email")
        : page.getByLabel(/email|phone|telefon|mobile|e-mel/i).first();
    const pwdField =
      (await page.locator("#pass").count()) > 0
        ? page.locator("#pass")
        : page.locator('input[type="password"]').first();

    await userField.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if ((await userField.count()) > 0) {
      await userField.click({ timeout: 5000 }).catch(() => {});
      await userField.fill("");
      await userField.fill(phone);
      log("Filled phone/email");
    } else {
      log("Could not find Facebook phone/email field", "error");
    }

    if ((await pwdField.count()) > 0) {
      await pwdField.click({ timeout: 5000 }).catch(() => {});
      await pwdField.fill("");
      await pwdField.fill(password);
      log("Filled password");
    } else {
      log("Could not find Facebook password field", "error");
    }

    const loginBtn = page.locator(
      '#loginbutton, button[name="login"], button[type="submit"]'
    ).first();
    if ((await loginBtn.count()) > 0) {
      await loginBtn.click();
      log("Clicked Log in");
    } else {
      await tryClick(
        page,
        ["Log in", "Log Masuk", "Log In", "Continue", "Allow"],
        log,
        "login"
      );
    }

    await sleep(4000);

    // If wrong format, try +60…
    const stillLogin = /login/i.test(page.url());
    if (stillLogin && phone.startsWith("0") && (await userField.count()) > 0) {
      const intl = "+60" + phone.slice(1);
      log(`Still on login — retrying with ${intl.slice(0, 5)}****…`);
      await userField.fill(intl);
      await pwdField.fill(password);
      if ((await loginBtn.count()) > 0) await loginBtn.click();
      else
        await tryClick(page, ["Log in", "Log Masuk", "Log In"], log, "login");
      await sleep(4000);
    }

    // Checkpoint / 2FA — user must finish
    if (/checkpoint|two.?factor|auth/i.test(page.url())) {
      log(
        "Facebook security check / 2FA — complete it in the Chrome window (waiting up to 3 min)…",
        "error"
      );
      await page
        .waitForFunction(
          () => !/login|checkpoint/i.test(location.href),
          null,
          { timeout: 180000 }
        )
        .catch(() => {});
    }
  }

  if (fallbackUrl && !/marketplace|groups/i.test(page.url())) {
    await page.goto(fallbackUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  log(`After login URL: ${page.url()}`);
}

async function uploadPhotos(page, photos, log) {
  if (!(await page.locator('input[type="file"]').count())) {
    await tryClick(
      page,
      ["Add photos", "Tambah foto", "Photo/video", "Foto/video", "Photos", "Photo"],
      log,
      "add photos"
    );
    await page.waitForTimeout(800);
  }
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(photos);
  log(`Uploaded ${photos.length} photo(s)`);
  await page.waitForTimeout(1500);
}

async function fillMarketplaceForm(page, listing, log, autoPost, opts = {}) {
  const createUrl =
    "https://www.facebook.com/marketplace/create/item?locale=ms_MY";

  await dismissChromeNags(page, log);

  if (opts.alreadyOnMarketplace && /marketplace\/create/i.test(page.url())) {
    log("Already on Marketplace create page");
  } else {
    log(`Marketplace → ${createUrl}`);
    await page.goto(createUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  await dismissChromeNags(page, log);
  await ensureLoggedIn(page, log, createUrl, opts.creds || {});
  await page.waitForTimeout(1200);

  await uploadPhotos(page, listing.photos, log);

  log(`Parsed title: ${listing.title}`);
  if (listing.price) log(`Parsed price: RM ${listing.price}`);
  if (listing.location) log(`Parsed location: ${listing.location}`);

  await tryFill(page, ["Title", "Tajuk", "Listing title"], listing.title, log, "title");
  if (listing.price) {
    await tryFill(page, ["Price", "Harga"], listing.price, log, "price");
  }

  const conditionBtn = page.getByText(/Condition|Keadaan/i).first();
  if ((await conditionBtn.count()) > 0) {
    await conditionBtn.click().catch(() => {});
    await page.waitForTimeout(400);
    const used = page.getByText(/Used - Good|Terpakai|Used/i).first();
    if ((await used.count()) > 0) await used.click();
  }

  // Paste FULL text into description — no splitting by category
  await tryFill(
    page,
    ["Description", "Perihalan", "More details"],
    listing.body,
    log,
    "description"
  );

  if (listing.location) {
    await tryFill(
      page,
      ["Location", "Lokasi", "Meet-up"],
      listing.location,
      log,
      "location"
    );
    await page.waitForTimeout(700);
    const suggestion = page.getByRole("option").first();
    if ((await suggestion.count()) > 0) {
      await suggestion.click().catch(() => {});
    }
  }

  await tryClick(page, ["Next", "Seterusnya", "Continue"], log, "next");
  await page.waitForTimeout(1000);

  if (autoPost) {
    const ok = await tryClick(
      page,
      ["Publish", "Terbitkan", "Post", "List"],
      log,
      "publish"
    );
    if (!ok) log("Publish not found — finish Marketplace manually.", "error");
    return ok ? "published" : "needs_manual";
  }

  log("Marketplace form filled — click Publish yourself if needed.");
  return "filled";
}

async function fillContentEditable(page, text, log) {
  const editors = [
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('[contenteditable="true"]'),
    page.getByRole("textbox").filter({ hasText: /./ }).first(),
  ];

  for (const loc of editors) {
    if ((await loc.count()) === 0) continue;
    const el = loc.first();
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.insertText(text);
    log("Pasted full listing into post box");
    return true;
  }

  // fallback: any visible textarea
  const ta = page.locator("textarea").first();
  if ((await ta.count()) > 0) {
    await ta.fill(text);
    log("Pasted full listing into textarea");
    return true;
  }

  log("Could not find post composer text box", "error");
  return false;
}

async function postToCommunity(page, groupUrl, listing, log, autoPost, creds = {}) {
  log(`Community → ${groupUrl}`);
  await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await ensureLoggedIn(page, log, groupUrl, creds);
  await page.waitForTimeout(1500);

  // Prefer Sell something (buy/sell groups), else Write something
  const opened =
    (await tryClick(
      page,
      ["Sell something", "Jual sesuatu", "Create sale post"],
      log,
      "sell"
    )) ||
    (await tryClick(
      page,
      [
        "Write something",
        "Tulis sesuatu",
        "What's on your mind",
        "Apa yang anda fikirkan",
        "Discussion",
        "Create post",
        "Buat siaran",
      ],
      log,
      "composer"
    ));

  if (!opened) {
    // try clicking the feed composer placeholder
    const placeholder = page.getByText(/Write something|Tulis sesuatu|Sell something|Jual/i).first();
    if ((await placeholder.count()) > 0) {
      await placeholder.click();
      log("Opened composer via placeholder text");
    } else {
      log("Could not open composer in this community", "error");
      return "failed";
    }
  }

  await page.waitForTimeout(1200);

  try {
    await uploadPhotos(page, listing.photos, log);
  } catch (err) {
    log(`Photo upload skipped/failed: ${err.message}`, "error");
  }

  const pasted = await fillContentEditable(page, listing.body, log);
  if (!pasted) return "failed";

  await page.waitForTimeout(800);

  if (autoPost) {
    const ok = await tryClick(
      page,
      ["Post", "Siarkan", "Publish", "Terbitkan", "Next", "Seterusnya"],
      log,
      "post"
    );
    if (!ok) {
      log("Post button not found — finish this group manually.", "error");
      return "needs_manual";
    }
    await page.waitForTimeout(2000);
    return "posted";
  }

  log("Draft ready in this community — click Post yourself (15s pause)…");
  await page.waitForTimeout(15000);
  return "filled";
}

/**
 * Paste-all listing → Marketplace (optional) + up to 20 Facebook communities.
 */
async function rpaFbMarketplace(inputs, log) {
  const paste = String(inputs.pasteAll || inputs.description || "").trim();
  const parsed = parseListingPaste(paste);
  const photos = resolvePhotos(inputs);
  const communities = parseCommunityUrls(inputs.communities);
  const alsoMarketplace = truthy(inputs.alsoMarketplace, true);
  const autoPost = truthy(inputs.autoPost, true);
  const delaySec = Math.max(15, Math.min(Number(inputs.delaySeconds) || 45, 180));

  if (!photos.length) {
    throw new Error("Add photos (upload or keep the default iPad photos)");
  }
  if (!alsoMarketplace && !communities.length) {
    throw new Error(
      "Paste community/group links (one per line, max 20) and/or enable Marketplace"
    );
  }

  const listing = { ...parsed, photos };
  const creds = {
    phone: String(inputs.fbPhone || process.env.FB_PHONE || "").trim(),
    password: String(inputs.fbPassword || process.env.FB_PASSWORD || "").trim(),
  };
  if (creds.phone) {
    log(`Facebook login ready for ${creds.phone.slice(0, 4)}**** (from .env / form)`);
  } else {
    log("No FB_PHONE in .env — you may need to log in manually", "error");
  }

  log("—— Parsed from your paste ——");
  log(`Title: ${listing.title}`);
  log(`Price: ${listing.price ? "RM " + listing.price : "(not found — fill on FB if needed)"}`);
  log(`Location: ${listing.location || "(none)"}`);
  log(`Photos: ${photos.length}`);
  log(`Communities: ${communities.length}`);
  log(`Delay between posts: ${delaySec}s`);
  log(
    "Note: posting to many groups fast can get limited by Facebook. Delays help."
  );

  if (!fs.existsSync(PROFILES_ROOT)) fs.mkdirSync(PROFILES_ROOT, { recursive: true });

  let browser;
  let context;
  let page;
  let choice;
  let stateFile;
  let persistent;
  let alreadyOnMarketplace;
  let chromeChild;
  let cdp;
  ({
    browser,
    context,
    page,
    choice,
    stateFile,
    persistent,
    alreadyOnMarketplace,
    chromeChild,
    cdp,
  } = await launchFbBrowser(inputs, log));

  const results = [];

  try {
    if (page.isClosed()) page = await context.newPage();
    log(`Locked to ${choice.label}${cdp ? " (real Chrome + your Google account)" : ""}`);

    if (alsoMarketplace) {
      try {
        const status = await fillMarketplaceForm(page, listing, log, autoPost, {
          alreadyOnMarketplace,
          creds,
        });
        results.push({ target: "marketplace", status });
        log(`Marketplace: ${status}`, status === "failed" ? "error" : "success");
        if (communities.length) {
          log(`Waiting ${delaySec}s before communities…`);
          await page.waitForTimeout(delaySec * 1000);
        }
      } catch (err) {
        results.push({ target: "marketplace", status: "failed", error: err.message });
        log(`Marketplace failed: ${err.message}`, "error");
      }
    }

    for (let i = 0; i < communities.length; i++) {
      const url = communities[i];
      log(`—— Community ${i + 1}/${communities.length} ——`);
      try {
        const status = await postToCommunity(
          page,
          url,
          listing,
          log,
          autoPost,
          creds
        );
        results.push({ target: url, status });
        log(`Result: ${status}`, status === "failed" ? "error" : "success");
      } catch (err) {
        results.push({ target: url, status: "failed", error: err.message });
        log(`Failed: ${err.message}`, "error");
      }

      if (i < communities.length - 1) {
        log(`Waiting ${delaySec}s before next community…`);
        await page.waitForTimeout(delaySec * 1000);
      }
    }

    if (!autoPost) {
      log("Assist done — browser open 30s more for any manual clicks…");
      await page.waitForTimeout(30000);
    }

    const shot = path.join(
      __dirname,
      "..",
      "artifacts",
      `fb-multi-${Date.now()}.png`
    );
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

    const ok = results.filter(
      (r) =>
        r.status === "posted" ||
        r.status === "published" ||
        r.status === "filled"
    ).length;
    return {
      browserUsed: choice.label,
      chromeProfile: inputs.chromeProfile || "fresh",
      parsed: {
        title: listing.title,
        price: listing.price,
        location: listing.location,
      },
      photoCount: photos.length,
      communityCount: communities.length,
      delaySeconds: delaySec,
      autoPost,
      results,
      summary: `${ok}/${results.length} targets filled/posted`,
      screenshotUrl: `/artifacts/${path.basename(shot)}`,
    };
  } finally {
    if (!persistent && !cdp) {
      try {
        const state = await context.storageState();
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        log(`Saved login cookies → ${stateFile}`);
      } catch (err) {
        log(`Could not save cookies: ${err.message}`, "error");
      }
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      log("Browser closed");
    } else if (cdp) {
      // Disconnect Playwright only — leave Chrome window open for you
      await browser.close().catch(() => {});
      log(
        "Disconnected bot — Chrome stays open on Marketplace so you can finish Publish"
      );
      // chromeChild is the Chrome process; leave it running
      void chromeChild;
    } else {
      await context.close().catch(() => {});
      log("Browser closed");
    }
  }
}

module.exports = {
  rpaFbMarketplace,
  parseListingPaste,
  UPLOADS_DIR,
};
