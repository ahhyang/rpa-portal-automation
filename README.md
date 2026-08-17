# RPA Portal

A small **local learning portal** for:

- **RPA** (Robotic Process Automation) — browser bots with [Playwright](https://playwright.dev)
- **APA** (API Process Automation) — automate work by calling HTTP APIs

Run tasks from the web UI on your machine, or trigger the same bots via REST.

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3847**

`npm install` also downloads Chromium for Playwright (`postinstall`).

## Facebook Marketplace helper

Task **FB paste → Marketplace + communities**:

1. Paste your **whole** listing (no need to split title/price/category)  
2. Photos (your iPad pics are preloaded)  
3. Paste up to **20** Facebook group links (one per line)  
4. Optional: also Marketplace  
5. Auto-Post on, delay ~45s between groups  

First run: log into Facebook in Edge. Facebook may limit mass posting.


## Watch the cursor

For any **RPA** task, leave **Watch browser & red cursor** checked. The browser opens on your screen with slow-motion moves and a red ring that follows the mouse.

## What you can try

| Task | Type | What it does |
|------|------|----------------|
| Facebook Marketplace listing | RPA | Fill FB create-item form with photos + text |
| Screenshot a page | RPA | Opens a URL, saves a full-page PNG |
| Scrape page titles & links | RPA | Collects title + up to 20 links |
| Fill a demo form | RPA | Types into `/practice-form.html` (visible) |
| Shop checkout (6 steps) | RPA | Search → cart → checkout → confirm |
| Resolve support ticket | RPA | Login → open ticket → resolve |
| Build & scrape ops report | RPA | Filter table → extract rows |
| Hybrid: API → fill form | RPA+APA | Fetch todo via API, type into form |
| HTTP GET | APA | Calls any public API URL |
| HTTP POST JSON | APA | Posts JSON (demo: jsonplaceholder) |
| Chain two API calls | APA | User → posts workflow |

Practice apps: `/practice-form.html` and `/playground.html`.

## API (APA pattern)

```http
GET  /api/tasks
POST /api/tasks/:id/run
GET  /api/runs/:id
```

Example (PowerShell):

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:3847/api/tasks/apa-chain/run `
  -ContentType "application/json" `
  -Body '{"inputs":{"userId":"1"}}'
```

Poll `GET /api/runs/<id>` until `status` is `succeeded` or `failed`.

## Project layout

```
server/
  index.js    # Express app + API
  tasks.js    # Task catalog + run history
  bots.js     # Playwright RPA + fetch APA handlers
public/       # Portal UI + practice form
artifacts/    # Screenshots (created at runtime)
```

## Learning tips

1. Start with **Fill a demo form** — watch Chromium do what you’d do by hand.
2. Compare with **HTTP GET** — same “get data” goal, but via API (faster, no browser).
3. Use the **API** tab to trigger a task from curl/Postman — that’s how real APA portals work.

Screenshots land under `/artifacts` and are linked from the run result.
