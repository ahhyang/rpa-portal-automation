const fs = require("fs");
const path = require("path");

function chromeUserDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;
  if (!process.env.LOCALAPPDATA) return null;
  return path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data");
}

function chromeExecutable() {
  const candidates = [
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
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** List Chrome profiles with Google account emails when available */
function listChromeProfiles() {
  const userDataDir = chromeUserDataDir();
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return { userDataDir, profiles: [] };
  }

  const localStatePath = path.join(userDataDir, "Local State");
  const profiles = [];

  if (fs.existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const cache = localState.profile?.info_cache || {};
      for (const [directory, info] of Object.entries(cache)) {
        const email =
          info.user_name ||
          info.gaia_name ||
          info.hosted_domain ||
          "";
        profiles.push({
          id: directory,
          name: info.name || directory,
          email: String(email),
          label: email
            ? `${info.name || directory} — ${email}`
            : `${info.name || directory} (${directory})`,
        });
      }
    } catch {
      /* fall through to folder scan */
    }
  }

  if (!profiles.length) {
    for (const name of fs.readdirSync(userDataDir)) {
      if (name === "Default" || /^Profile \d+$/i.test(name)) {
        profiles.push({
          id: name,
          name,
          email: "",
          label: name,
        });
      }
    }
  }

  profiles.sort((a, b) => a.label.localeCompare(b.label));
  return { userDataDir, profiles, executable: chromeExecutable() };
}

module.exports = {
  listChromeProfiles,
  chromeUserDataDir,
  chromeExecutable,
};
