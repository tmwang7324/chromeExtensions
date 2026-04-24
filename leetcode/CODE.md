# CODE.md - LeetCode Tracker Chrome Extension

A complete reference for every major code section, function, variable, and message in this extension.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [manifest.json](#manifestjson)
3. [inject.js - Main-World API Interceptor](#injectjs---main-world-api-interceptor)
4. [content.js - DOM Watcher, API Bridge, and Solve Detector](#contentjs---dom-watcher-api-bridge-and-solve-detector)
5. [background.js - Service Worker and State Manager](#backgroundjs---service-worker-and-state-manager)
6. [popup.html - UI Shell](#popuphtml---ui-shell)
7. [popup.js - UI Controller](#popupjs---ui-controller)
8. [apps-script/Code.gs - Google Sheets Backend](#apps-scriptcodegs---google-sheets-backend)
9. [Message Bus Reference](#message-bus-reference)
10. [Chrome Storage Schema](#chrome-storage-schema)

---

## Architecture Overview

```
[LeetCode page JS context]      [Extension content world]         [Extension UI]             [Google Sheets]
  inject.js                       content.js                        popup.js                  apps-script/Code.gs
     |                               |                                 |                              |
     | intercept window.fetch        | window.postMessage listener      | chrome.runtime.sendMessage   |
     | for /submissions/detail/*     | + DOM observer                   | GET_APP_STATE               |
     | ----------------------------> | build solve payload              | SUBMIT_REFLECTION           |
     | SUBMISSION_API_RESULT         | SOLVE_DETECTED ----------------> background.js ----------------> appendRow()
     |                               |                                 |                              |
```

**Data flow summary:**
1. `inject.js` runs in the page's **main world** at `document_start` and wraps `window.fetch`.
2. When LeetCode requests `/submissions/detail/<id>`, `inject.js` clones the response and posts a `SUBMISSION_API_RESULT` message back onto `window`.
3. `content.js` listens for that page message, stores the latest API payload in `lastApiResult`, and combines it with DOM-derived metadata.
4. Once an accepted solve is confirmed, `content.js` sends `SOLVE_DETECTED` to `background.js`.
5. `background.js` stores the solve, opens the prompt popup, accepts reflection data from `popup.js`, and POSTs the final record to Apps Script.
6. If the POST fails, the record is queued in `chrome.storage.local` until the user syncs it later.

---

## manifest.json

> **File:** [manifest.json](/c:/Users/jw300/chrome_extensions/leetcode/manifest.json) - MV3 manifest that declares permissions, registers the service worker, and injects both the page-world interceptor and the extension content script.

### Key Fields

| Field | Value | Purpose |
|---|---|---|
| `manifest_version` | `3` | Uses the MV3 service-worker model |
| `action.default_popup` | `popup.html` | Toolbar popup entry point |
| `background.service_worker` | `background.js` | Non-persistent background context |
| `permissions` | `["storage", "scripting", "tabs"]` | Storage access plus programmatic reinjection into open LeetCode tabs |
| `host_permissions` | `leetcode.com/*`, `script.google.com/*`, `script.googleusercontent.com/*` | Allows LeetCode injection and Apps Script requests |
| `content_scripts[0].js` | `["inject.js"]` | Main-world fetch interceptor |
| `content_scripts[0].run_at` | `document_start` | Hooks `window.fetch` before the page starts making requests |
| `content_scripts[0].world` | `"MAIN"` | Required so the interceptor patches the page's actual `window.fetch` |
| `content_scripts[1].js` | `["content.js"]` | Extension-world detector and messenger |
| `content_scripts[1].run_at` | `document_idle` | Runs after the problem UI is mostly available |

### Layout Notes

The manifest now uses **two** injected scripts on LeetCode problem pages:
- `inject.js` captures submission API responses from the page context.
- `content.js` consumes those results, watches the DOM, and sends extension messages.

---

## inject.js - Main-World API Interceptor

> **File:** [inject.js](/c:/Users/jw300/chrome_extensions/leetcode/inject.js) - Runs in the page's JavaScript world so it can monkey-patch `window.fetch` and observe LeetCode's submission detail API responses directly.

The whole file is a small IIFE:

```js
(function interceptSubmissionFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    // proxy request, inspect response, post message
  };
})();
```

### `interceptSubmissionFetch()` - `inject.js`

Bootstraps the API interception layer by saving the original `window.fetch` and replacing it with a wrapper.

```js
(function interceptSubmissionFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    // inspect matching submission detail requests
    return response;
  };
})();
```

### Wrapped `window.fetch(...args)` behavior

For every page fetch:
1. Calls the original fetch first.
2. Resolves the request URL from either a string or `Request` object.
3. If the URL contains `/submissions/detail/`, clones the response and parses JSON.
4. Posts a `window.postMessage()` event with a normalized payload:
   - `status`
   - `runtime`
   - `memory`
   - `language`
   - `submissionId`

```js
window.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);
  const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

  if (url.includes("/submissions/detail/")) {
    const clone = response.clone();
    clone.json().then((data) => {
      window.postMessage({
        __leetcodeTracker: true,
        type: "SUBMISSION_API_RESULT",
        payload: { /* normalized API fields */ }
      }, window.location.origin);
    }).catch(() => {});
  }

  return response;
};
```

### Why `inject.js` exists

`content.js` cannot reliably intercept page-owned `fetch()` calls from the isolated extension world. Running `inject.js` in `world: "MAIN"` solves that boundary and lets the extension capture the freshest submission stats even when the DOM is late, partial, or inconsistent.

---

## content.js - DOM Watcher, API Bridge, and Solve Detector

> **File:** [content.js](/c:/Users/jw300/chrome_extensions/leetcode/content.js) - Injected into every `leetcode.com/problems/*` page. Watches for route changes and DOM updates, listens for API intercept events from `inject.js`, assembles solve metadata, and emits `SOLVE_DETECTED`.

The entire file is an IIFE (`initializeTracker`) to avoid polluting globals and to guard against duplicate reinjection.

```js
(function initializeTracker() {
  if (window.__leetcodeTrackerInitialized) return;
  window.__leetcodeTrackerInitialized = true;
  // setup observers, listeners, and first scan
})();
```

### Module-Level Constants

#### `SELECTORS`

An object of CSS selectors used to locate the submission result, title link, tags, description container, and difficulty badge candidates.

### Module-Level Variables

| Variable | Initial Value | Purpose |
|---|---|---|
| `observer` | `null` | Active `MutationObserver` instance |
| `routeKey` | `location.pathname` | Tracks the current SPA route |
| `lastSentFingerprint` | `""` | Prevents duplicate `SOLVE_DETECTED` sends |
| `scheduled` | `false` | Debounce guard for `scheduleScan()` |
| `lastApiResult` | `null` | Latest normalized payload received from `inject.js` |

### Initialization

On load, the script performs four setup steps:

```js
bootstrapHistoryHooks();
attachObserver();
listenForApiResults();
scheduleScan();
```

It also listens for `leetcode-route-change`, resets route-sensitive state, and schedules a fresh scan.

### `listenForApiResults()`

Listens for `window.postMessage()` events emitted by `inject.js`.

- Rejects messages not coming from `window`
- Requires `event.data.__leetcodeTracker === true`
- Requires `event.data.type === "SUBMISSION_API_RESULT"`
- Stores `event.data.payload` in `lastApiResult`
- If the API says the status is `"Accepted"`, clears `lastSentFingerprint` and calls `inspectPage()` immediately

```js
function listenForApiResults() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data?.__leetcodeTracker) return;
    if (event.data.type !== "SUBMISSION_API_RESULT") return;

    lastApiResult = event.data.payload;
    if (lastApiResult.status === "Accepted") {
      lastSentFingerprint = "";
      inspectPage();
    }
  });
}
```

### `attachObserver()`

Attaches or re-attaches a `MutationObserver` on `document.documentElement`. Every mutation schedules a debounced page inspection.

```js
function attachObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}
```

### `scheduleScan()`

Debounces calls to `inspectPage()` so the extension does not react to every DOM mutation immediately.

```js
function scheduleScan() {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    inspectPage();
  }, 250);
}
```

### `inspectPage()`

Coordinates solve extraction and message dispatch.

1. Calls `extractSolveCandidate()`
2. Returns if no solve exists
3. Returns if the fingerprint matches `lastSentFingerprint`
4. Saves the new fingerprint
5. Sends `{ type: "SOLVE_DETECTED", payload: solve }` to `background.js`

```js
async function inspectPage() {
  const solve = extractSolveCandidate();
  if (!solve) return;
  if (solve.fingerprint === lastSentFingerprint) return;

  lastSentFingerprint = solve.fingerprint;
  await chrome.runtime.sendMessage({
    type: "SOLVE_DETECTED",
    payload: solve
  });
}
```

### `extractSolveCandidate()`

The main extraction function. Returns a solve object or `null`.

**Guards:**
- Must be on `/problems/`
- Must see `"Accepted"` from either the DOM result node or `lastApiResult.status`
- `parseProblemRoute()` must succeed

**Important merge behavior:**
- `status` comes from DOM first, then API fallback
- `language`, `runtime`, `memory`, and `submissionId` prefer `lastApiResult`
- Structural metadata like title, tags, difficulty, and description still come from the DOM

```js
function extractSolveCandidate() {
  const domStatus = normalizeWhitespace(document.querySelector(SELECTORS.submissionResult)?.textContent || "");
  const resultText = domStatus || (lastApiResult?.status ?? "");
  if (resultText !== "Accepted") return null;

  const routeInfo = parseProblemRoute();
  if (!routeInfo) return null;

  return {
    fingerprint: [routeInfo.problemSlug, "id-or-language", resultText].join("::"),
    language: lastApiResult?.language || extractStatValue([/Language.../i]),
    runtime: lastApiResult?.runtime || extractStatValue([/Runtime.../i]),
    memory: lastApiResult?.memory || extractStatValue([/Memory.../i]),
    submissionId: lastApiResult?.submissionId || routeInfo.submissionId || extractSubmissionIdFromLinks(),
    // other DOM-derived fields...
  };
}
```

### `extractDescriptionDivInfo()`

Searches the candidate description containers in order, then extracts:
- `description`
- `difficulty`
- `problemNumber`
- `problemTitle`

```js
function extractDescriptionDivInfo() {
  let div = null;
  for (const selector of SELECTORS.problemDescriptionDivs) {
    div = document.querySelector(selector);
    if (div) break;
  }
  if (!div) return { description: "", difficulty: "", problemNumber: "", problemTitle: "" };

  return {
    description: normalizeWhitespace(div.innerText || div.textContent || ""),
    difficulty: "",
    problemNumber: "",
    problemTitle: ""
  };
}
```

### `parseProblemRoute()`

Parses `location.pathname` and extracts:
- `problemSlug`
- optional `submissionId`
- placeholder `problemNumber`

```js
function parseProblemRoute() {
  const match = location.pathname.match(/^\/problems\/([^/]+)(?:\/submissions(?:\/detail\/([0-9]+))?)?/i);
  if (!match) return null;
  return { problemSlug: match[1], submissionId: match[2] || "", problemNumber: "" };
}
```

### `parseProblemTitle(problemSlug)`

Searches title links, prefers one whose `href` matches the current slug, and parses a `"N. Title"` pattern.

```js
function parseProblemTitle(problemSlug) {
  const links = Array.from(document.querySelectorAll(SELECTORS.titleLink));
  const matchingLink = links.find((link) => (link.getAttribute("href") || "").startsWith(`/problems/${problemSlug}`)) || links[0];
  const match = normalizeWhitespace(matchingLink?.textContent || "").match(/^(\d+)\.\s+(.+)$/);
  return match ? { problemNumber: match[1], problemTitle: match[2] } : { problemNumber: "", problemTitle: "" };
}
```

### `extractDifficulty()`

Two-stage difficulty extraction:
1. Try targeted difficulty selectors
2. Fall back to scanning visible `span`, `div`, and `p` nodes

```js
function extractDifficulty() {
  for (const selector of SELECTORS.difficultyBadges) {
    const node = document.querySelector(selector);
    const text = normalizeWhitespace(node?.textContent || "");
    if (node && isVisible(node) && ["Easy", "Medium", "Hard"].includes(text)) return text;
  }
  return "";
}
```

### `extractTags()`

Collects all `/tag/` anchor texts and deduplicates them with a `Set`.

```js
function extractTags() {
  const unique = new Set();
  for (const link of document.querySelectorAll(SELECTORS.tagLinks)) {
    const text = normalizeWhitespace(link.textContent || "");
    if (text) unique.add(text);
  }
  return Array.from(unique);
}
```

### `extractStatValue(patterns)`

Reads normalized page text and returns the first matching capture group.

```js
function extractStatValue(patterns) {
  const pageText = normalizeWhitespace(document.body?.innerText || "");
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match?.[1]) return normalizeWhitespace(match[1]);
  }
  return "";
}
```

### `extractSubmissionIdFromLinks()`

Scans submission detail links and extracts the first numeric submission ID.

```js
function extractSubmissionIdFromLinks() {
  for (const link of document.querySelectorAll('a[href*="/submissions/detail/"]')) {
    const match = (link.getAttribute("href") || "").match(/\/submissions\/detail\/(\d+)/);
    if (match?.[1]) return match[1];
  }
  return "";
}
```

### `bootstrapHistoryHooks()`

Patches `history.pushState` and `history.replaceState`, then mirrors native `popstate` into a custom `leetcode-route-change` event so the tracker can respond to SPA navigation.

```js
function bootstrapHistoryHooks() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    window.dispatchEvent(new Event("leetcode-route-change"));
    return result;
  };
}
```

### Utility Functions

| Function | Purpose | Skeleton |
|---|---|---|
| `normalizeWhitespace(value)` | Collapse whitespace and trim | `return String(value || "").replace(/\s+/g, " ").trim();` |
| `isVisible(node)` | Check whether the node has rendered layout boxes | `return Boolean(node && node.getClientRects().length);` |
| `toTitleCase(text)` | Convert slug-like text into a title fallback | `return text.split(" ").map(...).join(" ");` |

---

## background.js - Service Worker and State Manager

> **File:** [background.js](/c:/Users/jw300/chrome_extensions/leetcode/background.js) - Owns extension state in `chrome.storage.local`, deduplicates solves, opens the prompt window, submits records to Apps Script, queues failed writes, and reinjects the content script into already-open LeetCode tabs on install.

### Module-Level Constants

#### `STORAGE_KEYS`

String keys used inside `chrome.storage.local`.

#### `DEFAULT_SETTINGS`

```js
{ webAppUrl: "", sharedSecret: "", sheetName: "" }
```

#### `SHEET_COLUMNS`

Ordered array defining the 15-column submission schema.

### Event Listeners

#### `chrome.runtime.onInstalled`

Initializes storage defaults and reinjects `content.js` into already-open matching LeetCode tabs.

```js
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await storageGet([...]);
  await storageSet({ [STORAGE_KEYS.settings]: normalizeSettings(stored[STORAGE_KEYS.settings]) });
  // initialize queue, loggedFingerprints, reinject content.js
});
```

#### `chrome.windows.onRemoved`

Clears `promptWindowId` if the tracked popup window is closed.

```js
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { promptWindowId } = await storageGet([STORAGE_KEYS.promptWindowId]);
  if (promptWindowId === windowId) await storageRemove([STORAGE_KEYS.promptWindowId]);
});
```

#### `chrome.runtime.onStartup`

Clears stale popup window IDs after a full browser restart.

```js
chrome.runtime.onStartup.addListener(async () => {
  await storageRemove([STORAGE_KEYS.promptWindowId]);
});
```

#### `chrome.runtime.onMessage`

Routes all extension messages through `handleMessage()` and returns a normalized `{ ok, ... }` response.

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
  return true;
});
```

### `handleMessage(message)`

Central message router.

| `message.type` | Handler |
|---|---|
| `SOLVE_DETECTED` | `handleSolveDetected(payload)` |
| `GET_APP_STATE` | `getAppState()` |
| `SAVE_SETTINGS` | `saveSettings(payload)` |
| `SAVE_DRAFT` | `saveDraft(payload)` |
| `SUBMIT_REFLECTION` | `submitReflection(payload)` |
| `SYNC_QUEUE` | `syncQueue()` |
| `OPEN_PROMPT` | `openPromptWindow()` |

```js
async function handleMessage(message) {
  switch (message?.type) {
    case "SOLVE_DETECTED": return handleSolveDetected(message.payload);
    default: throw new Error("Unsupported message type.");
  }
}
```

### `handleSolveDetected(payload)`

Applies three-layer deduplication:
1. Already logged
2. Already pending
3. Brand-new solve

New solves are saved to `pendingSolve`, then `openPromptWindow()` is called.

```js
async function handleSolveDetected(payload) {
  if (!payload?.fingerprint) throw new Error("Missing solve fingerprint.");
  const stored = await storageGet([STORAGE_KEYS.pendingSolve, STORAGE_KEYS.loggedFingerprints]);
  if (stored[STORAGE_KEYS.loggedFingerprints]?.[payload.fingerprint]) return { duplicate: "logged" };
  await storageSet({ [STORAGE_KEYS.pendingSolve]: payload });
  await openPromptWindow();
  return { accepted: true };
}
```

### `getAppState()`

Builds the popup's read model from storage.

```js
async function getAppState() {
  const stored = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.pendingSolve, STORAGE_KEYS.draft, STORAGE_KEYS.queue]);
  return {
    settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
    pendingSolve: stored[STORAGE_KEYS.pendingSolve] || null,
    draft: stored[STORAGE_KEYS.draft] || createEmptyDraft()
  };
}
```

### `saveSettings(payload)`

Normalizes and persists endpoint settings.

```js
async function saveSettings(payload) {
  const settings = normalizeSettings(payload);
  await storageSet({ [STORAGE_KEYS.settings]: settings });
  return { settings };
}
```

### `saveDraft(payload)`

Sanitizes reflection fields and writes them to storage.

```js
async function saveDraft(payload) {
  const draft = {
    walkthrough: String(payload?.walkthrough || ""),
    confidence: String(payload?.confidence || "solid")
  };
  await storageSet({ [STORAGE_KEYS.draft]: draft });
  return { draft };
}
```

### `submitReflection(payload)`

Primary submission flow:
1. Read `pendingSolve`, settings, queue
2. Validate endpoint configuration
3. Build the merged record
4. Try to POST to Apps Script
5. On failure, queue the record locally
6. Mark the solve completed either way

```js
async function submitReflection(payload) {
  const stored = await storageGet([...]);
  const record = buildSubmissionRecord(stored[STORAGE_KEYS.pendingSolve], payload);
  try {
    await appendRecordToSheet(record, normalizeSettings(stored[STORAGE_KEYS.settings]));
    await markSolveCompleted(record.fingerprint);
    return { submitted: true, queued: false };
  } catch (error) {
    // queue locally, then mark complete
    return { submitted: true, queued: true, warning: error.message };
  }
}
```

### `syncQueue()`

Retries queued records in order and leaves failed items in the queue.

```js
async function syncQueue() {
  const stored = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.queue]);
  let synced = 0;
  const remaining = [];
  for (const item of stored[STORAGE_KEYS.queue] || []) {
    try {
      await appendRecordToSheet(item.record, normalizeSettings(stored[STORAGE_KEYS.settings]));
      synced += 1;
    } catch (error) {
      remaining.push({ ...item, lastError: error.message || "Sync failed." });
    }
  }
  await storageSet({ [STORAGE_KEYS.queue]: remaining });
  return { synced, remaining: remaining.length };
}
```

### `appendRecordToSheet(record, settings)`

Performs the Apps Script POST request and throws on transport or logical errors.

```js
async function appendRecordToSheet(record, settings) {
  const response = await fetch(settings.webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record, sharedSecret: settings.sharedSecret })
  });
  if (!response.ok) throw new Error("Apps Script request failed.");
}
```

### `buildSubmissionRecord(pendingSolve, payload)`

Merges auto-detected solve data with user-provided edits and reflection notes.

```js
function buildSubmissionRecord(pendingSolve, payload) {
  return {
    problemTitle: pendingSolve.problemTitle || "",
    problemDescription: String(payload?.problemDescription || "").trim() || pendingSolve.problemDescription || "",
    language: String(payload?.language || "").trim() || pendingSolve.language || "",
    walkthrough: String(payload?.walkthrough || "").trim(),
    submittedAt: new Date().toISOString()
  };
}
```

### `recordToRow(record)`

Serializes a record object into the 15-value sheet row order.

```js
function recordToRow(record) {
  return [
    record.problemNumber,
    record.problemTitle,
    record.problemDescription
    // ...remaining columns in SHEET_COLUMNS order
  ];
}
```

### `markSolveCompleted(fingerprint)`

Adds the fingerprint to the permanent dedupe log and clears `pendingSolve` plus `draft`.

```js
async function markSolveCompleted(fingerprint) {
  const { loggedFingerprints = {} } = await storageGet([STORAGE_KEYS.loggedFingerprints]);
  loggedFingerprints[fingerprint] = new Date().toISOString();
  await storageSet({ [STORAGE_KEYS.loggedFingerprints]: loggedFingerprints });
  await storageRemove([STORAGE_KEYS.pendingSolve, STORAGE_KEYS.draft]);
}
```

### `openPromptWindow()`

Focuses an existing prompt popup if it still belongs to this extension session; otherwise creates a new standalone prompt window.

```js
async function openPromptWindow() {
  const { promptWindowId } = await storageGet([STORAGE_KEYS.promptWindowId]);
  if (promptWindowId) {
    // focus existing popup if valid
  }
  const windowInfo = await windowsCreate({
    url: chrome.runtime.getURL("popup.html?mode=prompt"),
    type: "popup"
  });
  await storageSet({ [STORAGE_KEYS.promptWindowId]: windowInfo.id });
  return { opened: true, focused: true };
}
```

### Utility / Helper Functions

| Function | Purpose | Skeleton |
|---|---|---|
| `ensureEndpointConfigured(settings)` | Throw if URL or secret is missing | `if (!settings.webAppUrl) throw new Error(...);` |
| `isEndpointConfigured(settings)` | Return whether URL and secret are present | `return Boolean(url && secret);` |
| `normalizeSettings(settings)` | Trim strings and apply defaults | `return { webAppUrl: ..., sharedSecret: ..., sheetName: ... };` |
| `createEmptyDraft()` | Create the default draft object | `return { walkthrough: "", confidence: "solid", revisit: false, ... };` |
| `storageGet(keys)` | Wrapper for `chrome.storage.local.get` | `return chrome.storage.local.get(keys);` |
| `storageSet(items)` | Wrapper for `chrome.storage.local.set` | `return chrome.storage.local.set(items);` |
| `storageRemove(keys)` | Wrapper for `chrome.storage.local.remove` | `return chrome.storage.local.remove(keys);` |
| `windowsGet(id, options)` | Promise wrapper around `chrome.windows.get` | `return new Promise((resolve, reject) => { ... });` |
| `windowsCreate(options)` | Promise wrapper around `chrome.windows.create` | `return new Promise((resolve, reject) => { ... });` |
| `windowsUpdate(id, options)` | Promise wrapper around `chrome.windows.update` | `return new Promise((resolve, reject) => { ... });` |

---

## popup.html - UI Shell

> **File:** [popup.html](/c:/Users/jw300/chrome_extensions/leetcode/popup.html) - Static HTML structure for both the toolbar popup and the standalone prompt window.

### Sections and Key IDs

| HTML Section | Element | Purpose |
|---|---|---|
| Hero | `<section class="hero card">` | Status chips: `#solve-status`, `#queue-status` |
| Solve card | `<section id="solve-card">` | Displays captured solve metadata |
| Reflection form | `<form id="reflection-form">` | User note and override inputs |
| Action row | Inside reflection form | Submit and prompt-window actions |
| Settings form | `<form id="settings-form">` | Apps Script configuration |
| Status banner | `<section id="status-banner">` | Transient success/warning messages |

### Confidence Select Options

- `fragile` - user is uncertain
- `solid` - default
- `teachable` - user could explain the solution

---

## popup.js - UI Controller

> **File:** [popup.js](/c:/Users/jw300/chrome_extensions/leetcode/popup.js) - Loads app state from `background.js`, renders the solve and settings UI, autosaves reflection drafts, and submits user actions back through runtime messages.

### Module-Level DOM References

#### `formElements`

Cached `document.getElementById()` references for reflection and settings fields.

#### `ui`

Cached references for non-form display nodes and buttons.

#### `appState`

Stores the last `GET_APP_STATE` result.

#### `draftSaveHandle`

Tracks the debounced autosave timer.

### Initialization

```js
document.addEventListener("DOMContentLoaded", async () => {
  applyMode();
  bindEvents();
  await refreshState();
});
```

### `applyMode()`

Reads `?mode=` from the URL and writes it to `ui.shell.dataset.mode`.

```js
function applyMode() {
  const params = new URLSearchParams(window.location.search);
  ui.shell.dataset.mode = params.get("mode") || "popup";
}
```

### `bindEvents()`

Attaches submit, click, and draft-autosave listeners.

```js
function bindEvents() {
  ui.reflectionForm.addEventListener("submit", onSubmitReflection);
  ui.settingsForm.addEventListener("submit", onSaveSettings);
  ui.syncButton.addEventListener("click", onSyncQueue);
}
```

### `refreshState()`

Loads the latest app state and re-renders the UI.

```js
async function refreshState() {
  const response = await sendMessage({ type: "GET_APP_STATE" });
  appState = response.state;
  renderState();
}
```

### `renderState()`

Delegates to the solve, draft, and settings renderers.

```js
function renderState() {
  renderPendingSolve(appState.pendingSolve);
  renderDraft(appState.draft);
  renderSettings(appState.settings, appState.endpointConfigured, appState.queueCount);
}
```

### `renderPendingSolve(solve)`

Renders either idle placeholders or the current pending solve, including metadata override fields.

```js
function renderPendingSolve(solve) {
  if (!solve) {
    ui.submitButton.disabled = true;
    return;
  }
  ui.problemTitle.textContent = solve.problemTitle || "";
  formElements.problemDescription.value = solve.problemDescription || "";
}
```

### `renderDraft(draft)`

Restores autosaved note fields and any user metadata overrides.

```js
function renderDraft(draft) {
  formElements.walkthrough.value = draft.walkthrough || "";
  formElements.keyInsights.value = draft.keyInsights || "";
  if (draft.language) formElements.languageEdit.value = draft.language;
}
```

### `renderSettings(settings, endpointConfigured, queueCount)`

Renders endpoint inputs and status copy.

```js
function renderSettings(settings, endpointConfigured, queueCount) {
  formElements.webAppUrl.value = settings.webAppUrl || "";
  ui.queueStatus.textContent = `${queueCount} queued`;
  ui.setupCopy.textContent = endpointConfigured ? "Configured." : "Add endpoint settings.";
}
```

### `createTagChip(text)`

Returns a `<span class="tag-chip">`.

```js
function createTagChip(text) {
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.textContent = text;
  return chip;
}
```

### `onSubmitReflection(event)`

Validates the pending solve and note fields, submits to `background.js`, then refreshes UI state.

```js
async function onSubmitReflection(event) {
  event.preventDefault();
  const payload = collectDraftPayload();
  const response = await sendMessage({ type: "SUBMIT_REFLECTION", payload });
  await refreshState();
}
```

### `onSaveSettings(event)`

Persists Apps Script settings and reloads UI state.

```js
async function onSaveSettings(event) {
  event.preventDefault();
  await sendMessage({ type: "SAVE_SETTINGS", payload: { /* fields */ } });
  await refreshState();
}
```

### `onSyncQueue()`

Requests a queue sync and shows the result.

```js
async function onSyncQueue() {
  const response = await sendMessage({ type: "SYNC_QUEUE" });
  showStatus(`Synced ${response.synced || 0} queued entries.`, "success");
}
```

### `scheduleDraftSave()`

Debounces `SAVE_DRAFT` calls by 250 ms.

```js
function scheduleDraftSave() {
  if (draftSaveHandle) window.clearTimeout(draftSaveHandle);
  draftSaveHandle = window.setTimeout(() => {
    sendMessage({ type: "SAVE_DRAFT", payload: collectDraftPayload() });
  }, 250);
}
```

### `collectDraftPayload()`

Reads the form into a plain object used for both draft saves and final submission.

```js
function collectDraftPayload() {
  return {
    walkthrough: formElements.walkthrough.value,
    keyInsights: formElements.keyInsights.value,
    mistakes: formElements.mistakes.value
  };
}
```

### `runAction(type, payload, successMessage)`

Small helper for single-message UI actions.

```js
async function runAction(type, payload, successMessage) {
  await sendMessage({ type, payload });
  if (successMessage) showStatus(successMessage, "success");
}
```

### `showStatus(message, tone)`

Shows a temporary banner message and auto-hides it.

```js
function showStatus(message, tone) {
  ui.statusBanner.textContent = message;
  ui.statusBanner.classList.remove("hidden", "warning", "success");
  if (tone) ui.statusBanner.classList.add(tone);
}
```

### `sendMessage(message)`

Promise wrapper around `chrome.runtime.sendMessage`.

```js
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (!response?.ok) reject(new Error(response?.error || "Extension request failed."));
      else resolve(response);
    });
  });
}
```

---

## apps-script/Code.gs - Google Sheets Backend

> **File:** `apps-script/Code.gs` - Google Apps Script web app endpoint that validates the shared secret, ensures the sheet structure exists, and appends one row per record.

### Module-Level Constant

#### `COLUMN_HEADERS`

Ordered 15-column header array. Must stay aligned with `SHEET_COLUMNS` in `background.js`.

### `doPost(e)`

Entry point for all extension POST requests.

```js
function doPost(e) {
  const payload = parsePayload_(e);
  const record = payload.record || {};
  const ensured = ensureSheetStructure_(spreadsheet, payload.sheetName || "LeetCode Log");
  ensured.sheet.appendRow(recordToRow_(record));
  return jsonResponse_({ ok: true });
}
```

### `getSharedSecret_(e)`

Tries to read the shared secret from the query string first, then from the parsed JSON body.

```js
function getSharedSecret_(e) {
  return (e.parameter.sharedSecret || "").trim();
}
```

### `parsePayload_(e)`

Parses `e.postData.contents` into a JSON object.

```js
function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error("Missing request body.");
  return JSON.parse(e.postData.contents);
}
```

### `ensureSheetStructure_(spreadsheet, sheetName)`

Creates the sheet if missing and writes headers if row 1 does not match.

```js
function ensureSheetStructure_(spreadsheet, sheetName) {
  let sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  // ensure header row matches COLUMN_HEADERS
  return { sheet: sheet, createdSheet: false, createdHeaders: false };
}
```

### `headersMatch_(actualHeaders, expectedHeaders)`

Compares two header arrays position-by-position.

```js
function headersMatch_(actualHeaders, expectedHeaders) {
  return expectedHeaders.every((header, index) => String(actualHeaders[index] || "").trim() === String(header).trim());
}
```

### `recordToRow_(record)`

Converts a record object to the sheet row array format.

```js
function recordToRow_(record) {
  return [
    record.problemNumber,
    record.problemTitle,
    record.problemDescription
    // ...remaining columns
  ];
}
```

### Utility Functions

| Function | Purpose | Skeleton |
|---|---|---|
| `joinTags_(tags)` | Join array tags with commas | `return Array.isArray(tags) ? tags.join(", ") : stringValue_(tags);` |
| `stringValue_(value)` | Safe string coercion | `return value == null ? "" : String(value);` |
| `jsonResponse_(payload)` | Return JSON `TextOutput` | `return ContentService.createTextOutput(JSON.stringify(payload));` |

---

## Message Bus Reference

All extension-context communication uses `chrome.runtime.sendMessage`. The API intercept bridge from `inject.js` to `content.js` uses `window.postMessage`.

### Page-to-content bridge

| `type` | Sender | Receiver | Payload |
|---|---|---|---|
| `SUBMISSION_API_RESULT` | `inject.js` | `content.js` | `{ status, runtime, memory, language, submissionId }` |

### Extension runtime messages

| `type` | Sender | Receiver | `payload` | Response |
|---|---|---|---|---|
| `SOLVE_DETECTED` | `content.js` | `background.js` | solve object | `{ ok, accepted?, duplicate? }` |
| `GET_APP_STATE` | `popup.js` | `background.js` | - | `{ ok, state: AppState }` |
| `SAVE_SETTINGS` | `popup.js` | `background.js` | `{ webAppUrl, sharedSecret, sheetName }` | `{ ok, settings }` |
| `SAVE_DRAFT` | `popup.js` | `background.js` | draft fields object | `{ ok, draft }` |
| `SUBMIT_REFLECTION` | `popup.js` | `background.js` | draft fields object | `{ ok, submitted, queued, warning? }` |
| `SYNC_QUEUE` | `popup.js` | `background.js` | - | `{ ok, synced, remaining }` |
| `OPEN_PROMPT` | `popup.js` | `background.js` | - | `{ ok, opened, focused }` |

---

## Chrome Storage Schema

All persistent extension data lives in `chrome.storage.local`.

| Key | Type | Description |
|---|---|---|
| `"settings"` | `{ webAppUrl: string, sharedSecret: string, sheetName: string }` | Endpoint configuration |
| `"pendingSolve"` | `SolveObject | undefined` | Current unsubmitted solve |
| `"draft"` | `DraftObject | undefined` | Autosaved reflection contents |
| `"queue"` | `Array<{ record, queuedAt, lastError? }>` | Locally queued sheet writes |
| `"loggedFingerprints"` | `{ [fingerprint: string]: isoTimestamp }` | Permanent dedupe log |
| `"promptWindowId"` | `number | undefined` | Tracked standalone prompt popup window ID |

### SolveObject Fields

| Field | Type | Source |
|---|---|---|
| `fingerprint` | `string` | `[slug]::[submissionId|language|"manual"]::[resultText]` |
| `problemSlug` | `string` | URL route |
| `problemNumber` | `string` | DOM title or description |
| `problemTitle` | `string` | DOM title or slug fallback |
| `problemDescription` | `string` | Description container text |
| `difficulty` | `string` | DOM difficulty extraction |
| `tags` | `string[]` | `/tag/` anchor texts |
| `language` | `string` | API-first, DOM fallback |
| `runtime` | `string` | API-first, DOM fallback |
| `memory` | `string` | API-first, DOM fallback |
| `submissionId` | `string` | API-first, route/link fallback |
| `leetcodeUrl` | `string` | `location.href` at capture time |
| `submissionStatus` | `string` | `"Accepted"` |
| `detectedAt` | `string` | ISO 8601 timestamp |

### DraftObject Fields

| Field | Type |
|---|---|
| `walkthrough` | `string` |
| `keyInsights` | `string` |
| `mistakes` | `string` |
| `confidence` | `string` |
| `revisit` | `boolean` |
| `problemDescription` | `string` |
| `language` | `string` |
| `runtime` | `string` |
