require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { listTasks, getTask, runTask, listRuns, getRun } = require("./tasks");
const { UPLOADS_DIR } = require("./marketplace");
const { listChromeProfiles } = require("./chromeProfiles");

const app = express();
const PORT = process.env.PORT || 3847;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOADS_DIR, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024, files: 10 },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/artifacts", express.static(path.join(__dirname, "..", "artifacts")));
app.use("/uploads", express.static(UPLOADS_DIR));

/** Upload photos for Marketplace / RPA tasks */
app.post("/api/uploads", upload.array("photos", 10), (req, res) => {
  const files = (req.files || []).map((f) => ({
    name: f.filename,
    path: `inbox/${f.filename}`,
    url: `/uploads/inbox/${f.filename}`,
    size: f.size,
  }));
  res.json({ files });
});

app.get("/api/uploads", (_req, res) => {
  const walk = (dir, prefix = "") => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
      else if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
        out.push({ path: rel, url: `/uploads/${rel}` });
      }
    }
    return out;
  };
  res.json(walk(UPLOADS_DIR));
});

app.get("/api/chrome-profiles", (_req, res) => {
  res.json(listChromeProfiles());
});

app.get("/api/tasks", (_req, res) => {
  res.json(listTasks());
});

app.get("/api/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json(task);
});

app.post("/api/tasks/:id/run", async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  try {
    const run = await runTask(req.params.id, req.body?.inputs || {});
    res.status(202).json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(listRuns());
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "RPA Portal is running" });
});

app.listen(PORT, () => {
  console.log(`\n  RPA Portal  →  http://localhost:${PORT}`);
  console.log(`  API docs   →  http://localhost:${PORT}/api/health\n`);
});
