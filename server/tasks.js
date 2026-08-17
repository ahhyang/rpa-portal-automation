const { v4: uuid } = require("uuid");
const bots = require("./bots");

/** In-memory run history (learning portal — resets on restart) */
const runs = new Map();

const TASKS = [
  {
    id: "rpa-fb-marketplace",
    type: "rpa",
    name: "FB paste → Marketplace + communities",
    description:
      "Paste your whole listing once, add photos, paste up to 20 group links — bot posts for you with delays.",
    learn:
      "Type your Facebook phone + password in the form. Paste listing text + photos + group links. Bot logs into FB and fills the post.",
    inputs: [
      {
        key: "fbPhone",
        label: "Facebook phone / email",
        type: "text",
        default: "",
        required: true,
      },
      {
        key: "fbPassword",
        label: "Facebook password",
        type: "password",
        default: "",
        required: true,
      },
      {
        key: "pasteAll",
        label: "Paste ALL listing text here (title + details + price)",
        type: "textarea",
        rows: 14,
        default:
          "IPAD A16 128 GB WIFI ZPSET\n\nCondition 9/10\nSystem Smooth\nTrade in Swap Addcash Layan\n✅ Face id\n✅ Speaker\n✅ Camera\n✅ Battery Health 100% ( cycle count 24)\n✅ APPLE WARRANTY\n✅ Ipad & Box\n✅ Resit Pembelian\n✅ Personal Warranty 3 Hari\n\nRM 1399\n📍AREA KK",
        required: true,
      },
      {
        key: "photos",
        label: "Photos",
        type: "files",
        default: "ipad-a16/front.png,ipad-a16/back.png",
        required: true,
      },
      {
        key: "communities",
        label: "Community / group links (1 per line, max 20)",
        type: "textarea",
        rows: 10,
        default:
          "# Paste up to 20 Facebook group links below (remove # lines)\n# https://www.facebook.com/groups/your-group-1\n# https://www.facebook.com/groups/your-group-2",
        required: false,
      },
      {
        key: "alsoMarketplace",
        label: "Also fill Facebook Marketplace first",
        type: "checkbox",
        default: "true",
        required: false,
      },
      {
        key: "autoPost",
        label: "Auto-click Post/Publish (turn OFF to review each one)",
        type: "checkbox",
        default: "true",
        required: false,
      },
      {
        key: "delaySeconds",
        label: "Seconds to wait between each community (min 15)",
        type: "text",
        default: "45",
        required: false,
      },
    ],
  },
  {
    id: "rpa-screenshot",
    type: "rpa",
    name: "Screenshot a page",
    description:
      "Opens a URL in Chromium with Playwright and saves a full-page screenshot.",
    learn: "RPA = robots that use a real browser like a human.",
    inputs: [
      {
        key: "url",
        label: "Page URL",
        type: "url",
        default: "https://example.com",
        required: true,
      },
    ],
  },
  {
    id: "rpa-scrape-titles",
    type: "rpa",
    name: "Scrape page titles & links",
    description:
      "Visits a page, collects the document title and up to 20 link texts.",
    learn: "RPA can read the DOM — useful for reporting and monitoring.",
    inputs: [
      {
        key: "url",
        label: "Page URL",
        type: "url",
        default: "https://example.com",
        required: true,
      },
    ],
  },
  {
    id: "rpa-form-demo",
    type: "rpa",
    name: "Fill a demo form",
    description:
      "Opens the built-in practice form, fills fields slowly (visible cursor), submits, and screenshots.",
    learn: "Classic RPA: type, click, and verify — watch it on your screen.",
    inputs: [
      {
        key: "name",
        label: "Your name",
        type: "text",
        default: "Ada Lovelace",
        required: true,
      },
      {
        key: "email",
        label: "Email",
        type: "text",
        default: "ada@example.com",
        required: true,
      },
      {
        key: "message",
        label: "Message",
        type: "text",
        default: "Hello from my first RPA bot!",
        required: true,
      },
    ],
  },
  {
    id: "rpa-shop-checkout",
    type: "rpa",
    name: "Shop checkout (6 steps)",
    description:
      "Search → filter → add to cart → checkout → fill shipping → place order. Watch every click.",
    learn: "Real RPA is multi-step: navigate, decide, fill forms, confirm.",
    inputs: [
      {
        key: "search",
        label: "Search text",
        type: "text",
        default: "notebook",
        required: true,
      },
      {
        key: "category",
        label: "Category (all|office|tech|home)",
        type: "text",
        default: "office",
        required: true,
      },
      {
        key: "shipName",
        label: "Ship-to name",
        type: "text",
        default: "Ada Lovelace",
        required: true,
      },
      {
        key: "shipEmail",
        label: "Ship-to email",
        type: "text",
        default: "ada@example.com",
        required: true,
      },
      {
        key: "shipCity",
        label: "City",
        type: "text",
        default: "London",
        required: true,
      },
      {
        key: "shipNote",
        label: "Delivery note",
        type: "text",
        default: "Leave at reception",
        required: false,
      },
    ],
  },
  {
    id: "rpa-office-inbox",
    type: "rpa",
    name: "Resolve support ticket",
    description:
      "Login → open inbox → open a ticket → type resolution → mark done.",
    learn: "Office RPA: authenticate, process a queue item, write a note.",
    inputs: [
      {
        key: "username",
        label: "Username",
        type: "text",
        default: "agent",
        required: true,
      },
      {
        key: "password",
        label: "Password",
        type: "text",
        default: "automate",
        required: true,
      },
      {
        key: "ticketId",
        label: "Ticket ID (T-101 / T-102 / T-103)",
        type: "text",
        default: "T-101",
        required: true,
      },
      {
        key: "resolution",
        label: "Resolution note",
        type: "text",
        default: "Fixed via RPA demo — cleared cache and retested export.",
        required: true,
      },
    ],
  },
  {
    id: "rpa-ops-report",
    type: "rpa",
    name: "Build & scrape ops report",
    description:
      "Open report screen, set filters, build table, extract rows + screenshot.",
    learn: "RPA for reporting: filter UI → scrape table → save evidence.",
    inputs: [
      {
        key: "team",
        label: "Team (all|sales|support|ops)",
        type: "text",
        default: "support",
        required: true,
      },
      {
        key: "status",
        label: "Status (all|open|closed)",
        type: "text",
        default: "open",
        required: true,
      },
    ],
  },
  {
    id: "hybrid-api-to-form",
    type: "rpa",
    name: "Hybrid: API → fill form",
    description:
      "APA fetches a todo from an API, then RPA types that data into the practice form.",
    learn: "Best of both: get data via API, then drive the UI when needed.",
    inputs: [
      {
        key: "todoId",
        label: "Todo ID (1–200)",
        type: "text",
        default: "1",
        required: true,
      },
    ],
  },
  {
    id: "apa-http-get",
    type: "apa",
    name: "HTTP GET (API call)",
    description:
      "Calls any public HTTPS URL and returns status + JSON/text body.",
    learn: "APA = automate work through APIs — no browser needed.",
    inputs: [
      {
        key: "url",
        label: "API URL",
        type: "url",
        default: "https://jsonplaceholder.typicode.com/todos/1",
        required: true,
      },
    ],
  },
  {
    id: "apa-post-json",
    type: "apa",
    name: "HTTP POST JSON",
    description: "Sends a JSON body to an API (demo uses jsonplaceholder).",
    learn: "Create/update records by posting JSON — common APA pattern.",
    inputs: [
      {
        key: "url",
        label: "API URL",
        type: "url",
        default: "https://jsonplaceholder.typicode.com/posts",
        required: true,
      },
      {
        key: "title",
        label: "Title",
        type: "text",
        default: "My APA task",
        required: true,
      },
      {
        key: "body",
        label: "Body",
        type: "text",
        default: "Created by the RPA Portal",
        required: true,
      },
    ],
  },
  {
    id: "apa-chain",
    type: "apa",
    name: "Chain two API calls",
    description:
      "Fetches a user, then fetches that user's posts — a mini workflow.",
    learn: "Real APA often chains APIs: output of step 1 → input of step 2.",
    inputs: [
      {
        key: "userId",
        label: "User ID (1–10)",
        type: "text",
        default: "1",
        required: true,
      },
    ],
  },
];

function listTasks() {
  return TASKS.map(({ id, type, name, description, learn, inputs }) => ({
    id,
    type,
    name,
    description,
    learn,
    inputs,
  }));
}

function getTask(id) {
  return TASKS.find((t) => t.id === id) || null;
}

function listRuns() {
  return [...runs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 50);
}

function getRun(id) {
  return runs.get(id) || null;
}

function createRun(taskId, inputs) {
  const task = getTask(taskId);
  const run = {
    id: uuid(),
    taskId,
    taskName: task.name,
    type: task.type,
    status: "running",
    inputs,
    logs: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  runs.set(run.id, run);
  return run;
}

function log(run, message, level = "info") {
  run.logs.push({
    at: new Date().toISOString(),
    level,
    message,
  });
}

async function runTask(taskId, inputs) {
  const task = getTask(taskId);
  if (!task) throw new Error("Unknown task");

  const handler = bots[taskId];
  if (!handler) throw new Error(`No handler for task: ${taskId}`);

  const run = createRun(taskId, inputs);
  log(run, `Started ${task.type.toUpperCase()} task: ${task.name}`);

  // Fire-and-forget so the API can return 202 quickly; client polls /api/runs/:id
  setImmediate(async () => {
    try {
      const result = await handler(inputs, (msg, level) => log(run, msg, level));
      run.result = result;
      run.status = "succeeded";
      log(run, "Task finished successfully", "success");
    } catch (err) {
      run.status = "failed";
      run.error = err.message || String(err);
      log(run, run.error, "error");
    } finally {
      run.finishedAt = new Date().toISOString();
    }
  });

  return {
    id: run.id,
    status: run.status,
    taskId: run.taskId,
    startedAt: run.startedAt,
  };
}

module.exports = {
  listTasks,
  getTask,
  listRuns,
  getRun,
  runTask,
};
