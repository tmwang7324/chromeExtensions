# Job Application Tracker — Chrome Extension

## Context

You want a Chrome extension that automatically captures job applications submitted on LinkedIn, Handshake, Workday, Google Careers, and arbitrary company career sites, and appends them as rows to a Google Sheet via Apps Script (same pattern as the existing [leetcode/](leetcode/) extension).

The empty skeleton already exists at [jobs/manifest.json](jobs/manifest.json) — host permissions for LinkedIn/Handshake/Glassdoor/Workday are declared, but the `content_scripts` array is empty and no other files exist. We will fill it in by porting the leetcode architecture and adapting detection to job-application submit POSTs.

Final sheet columns (in order): `Id, Job Title, Job Category, Company, Date Applied, Truncated Job Description, Link, Status, Qualifications, Location, Pay`.

### Decisions confirmed with user
- **Detection flow:** Submission POST opens a confirm popup pre-filled with scraped fields; user confirms/edits/cancels before the row is appended. Mirrors leetcode's "pending solve → reflection prompt → submit" flow.
- **Host scope:** Known sites get auto-injected content scripts. `activeTab` permission allows the user to also log applications on arbitrary company sites by clicking the toolbar button — that opens the popup with whatever the page scrape produced, fully editable.
- **Status:** Always written as `Applied` on row creation. Future status changes are done by hand in the sheet.
- **Job Category:** Keyword heuristic on title (`engineer|developer|swe|sde|software` → `Software`; `analyst|analytics|bi|data scientist` → `Data Analyst`; else blank), user can override in the popup.

---

## Architecture (port of [leetcode/](leetcode/))

Same five-layer model: `inject.js` (MAIN-world fetch override) → `content.js` (DOM scraper + bridge) → `background.js` (state, dedup, prompt window, Apps Script client) → `popup.html`/`popup.js` (confirm + edit form, settings) → `apps-script/Code.gs` (web app endpoint).

The job-specific work is concentrated in two places: **per-site detection rules** (which POST URLs count as a submission, which DOM selectors scrape which field) and the **column mapping** in `background.js` and `Code.gs`.

---

## Files to create under [jobs/](jobs/)

### 1. [jobs/manifest.json](jobs/manifest.json) — modify

- Add `"activeTab"` to `permissions`.
- Add Google Careers + Apps Script to `host_permissions`:
  - `https://careers.google.com/*`
  - `https://www.google.com/about/careers/*`
  - `https://script.google.com/*`
  - `https://script.googleusercontent.com/*`
- Replace the empty `"content_scripts":` with two entries per site, mirroring leetcode (one MAIN-world `inject.js` at `document_start`, one isolated `content.js` at `document_idle`). Matches:
  - `https://www.linkedin.com/jobs/*`
  - `https://*.joinhandshake.com/*` (Handshake's actual student-portal domain)
  - `https://*.myworkdayjobs.com/*` (Workday is per-tenant)
  - `https://careers.google.com/*`, `https://www.google.com/about/careers/*`
- `web_accessible_resources` not needed — pages talk to `inject.js` via `window.postMessage`.

### 2. [jobs/inject.js](jobs/inject.js) — new

Wrap `window.fetch` and `XMLHttpRequest.prototype.send` (Workday uses XHR, not fetch). For each site, recognize submit POSTs by URL pattern and re-post the request body / response to the isolated content script via `window.postMessage({__jobTracker: true, type: "APPLY_API_RESULT", payload: {...}})`.

Site-specific URL patterns (validate during implementation by submitting a test application with DevTools open — endpoints can change):
- **LinkedIn Easy Apply:** POSTs to `voyager/api/voyagerJobsDashOnsiteApplyApplication*` — payload contains `jobPostingUrn`, response has application ID. The job ID also lives in the page URL `/jobs/view/<id>/`.
- **Handshake:** `/api/v1/applications` POST or `/jobs/<id>/apply` form POST. Response is JSON with application object.
- **Workday:** XHR POST to `*/cxs/*/job/*/apply/applyManually` (or similar — tenant-prefixed). The job descriptor sits on the same page in `data-automation-id` attributes.
- **Google Careers:** `/api/jobs/applications` POST (verify on real submit).

For unknown company sites: do not auto-fire. The popup's manual-log button handles those.

Reuse the leetcode pattern: clone the response, parse JSON safely, never throw inside the wrapper, post lightweight payload only (status code, application id, any returned title/company echo).

### 3. [jobs/content.js](jobs/content.js) — new

Per-site DOM scraper. Detect which platform we're on by `location.hostname`, then run the matching extractor. Each extractor returns:

```
{
  detectedAt, fingerprint,
  jobTitle, company, location, pay,
  jobDescription,         // full text; truncated in background.js to ~500 chars
  qualifications,         // bullet list joined as text, sourced from the "Qualifications"/"Requirements" section
  link,                   // canonical job URL
  category,               // heuristic guess; user can override
  source                  // "linkedin" | "handshake" | "workday" | "google" | "manual"
}
```

Selectors (sketch — verify in DevTools during implementation):
- **LinkedIn:** title `.jobs-unified-top-card__job-title`, company `.jobs-unified-top-card__company-name a`, location `.jobs-unified-top-card__bullet`, description `#job-details`, pay regex `\$[\d,]+(?:\.\d+)?(?:\s*[-–]\s*\$[\d,]+)?`.
- **Handshake:** title/company/location in the right rail (`[data-hook="job-detail-..."]` style hooks), description in the main panel.
- **Workday:** `[data-automation-id="jobPostingHeader"]`, `[data-automation-id="locations"]`, `[data-automation-id="jobPostingDescription"]`.
- **Google Careers:** `h2.gc-job-detail__title`, company is implicitly Google, `[itemprop="jobLocation"]`, description in `.gc-job-detail__content`.

Fingerprint logic: prefer a real job id parsed from the URL or DOM (e.g., LinkedIn `/jobs/view/<id>/`, Workday job descriptor, Handshake `/jobs/<id>`). When none is available (most company career sites), synthesize a stable id by combining `jobTitle + "|" + company + "|" + location`, lowercased and whitespace-collapsed — that triple is unique enough in practice to dedup re-submissions of the same role. Final fingerprint = `[source, hostname, jobId || synthesizedId, "applied"].join("::")` — same dedup pattern as [leetcode/content.js:183](leetcode/content.js#L183). Bridge `APPLY_API_RESULT` from inject.js into `chrome.runtime.sendMessage({type: "APPLICATION_DETECTED", payload})`. Mirror [leetcode/content.js:47-67](leetcode/content.js#L47-L67) verbatim with renamed identifiers.

Also handle SPA route changes by hooking `history.pushState/replaceState` ([leetcode/content.js:364-383](leetcode/content.js#L364-L383)) — LinkedIn especially is a SPA.

### 4. [jobs/background.js](jobs/background.js) — new

Direct port of [leetcode/background.js](leetcode/background.js). Rename:
- `STORAGE_KEYS.pendingSolve` → `pendingApplication`
- `STORAGE_KEYS.loggedFingerprints` → kept as-is
- Message types: `SOLVE_DETECTED` → `APPLICATION_DETECTED`, `SUBMIT_REFLECTION` → `SUBMIT_APPLICATION`
- Replace `SHEET_COLUMNS` with the 11-column job schema (`Id` is auto-assigned by Apps Script as the row index — see Apps Script section).

Reuse functions wholesale (rename only): `handleMessage`, `handleSolveDetected`, `getAppState`, `saveSettings`, `saveDraft`, `submitReflection`, `syncQueue`, `appendRecordToSheet`, `markSolveCompleted`, `openPromptWindow`, `ensureEndpointConfigured`, `isEndpointConfigured`, `normalizeSettings`, `createEmptyDraft`, plus the Chrome promise wrappers at [leetcode/background.js:459-513](leetcode/background.js#L459-L513).

`buildSubmissionRecord` (currently [leetcode/background.js:339-357](leetcode/background.js#L339-L357)) needs the new schema:

```
{
  jobTitle, jobCategory, company,
  dateApplied: pendingApplication.detectedAt,
  truncatedDescription: truncate(jobDescription, 500),
  link, status: "Applied",
  qualifications, location, pay
}
```

`recordToRow` outputs the column order above; `Id` is omitted because Apps Script computes it as `lastRow - 1`.

Add `MANUAL_LOG` message type: when the toolbar popup is opened on a non-known site and the user clicks "Log this page", popup.js sends `MANUAL_LOG` with the active tab's URL; background.js calls `chrome.scripting.executeScript` to inject `content.js` (using `activeTab` permission), which scrapes whatever it can with a generic extractor (title from `<h1>` or `<title>`, the rest left blank for the user to fill in).

### 5. [jobs/popup.html](jobs/popup.html), [jobs/popup.js](jobs/popup.js), [jobs/popup.css](jobs/popup.css) — new

Same dual-mode pattern as leetcode (`?mode=prompt` for the spawned confirm window, default for the toolbar popup). Form fields, all editable:

- Job Title, Company, Location, Pay
- Job Category (dropdown: Software / Data Analyst / Other) — pre-filled from heuristic
- Truncated Description (textarea, 500 char limit, pre-filled)
- Qualifications (textarea, pre-filled)
- Link (read-only, pre-filled with current URL)
- Status (read-only label "Applied")

Settings section (Apps Script URL, shared secret, sheet name) reused from [leetcode/popup.html](leetcode/popup.html) verbatim.

Plus a "Log this page" button visible when `pendingApplication` is null and the user is on a non-known site — sends `MANUAL_LOG`.

### 6. [jobs/apps-script/Code.gs](jobs/apps-script/Code.gs) — new

Port [leetcode/apps-script/Code.gs](leetcode/apps-script/Code.gs). Two changes:
- Header row = the 11 job columns.
- `recordToRow_` writes `Id = sheet.getLastRow()` (so the first data row is Id=1) followed by the record fields in order.

Script properties: `JOBS_SHARED_SECRET`, `JOBS_SPREADSHEET_ID`, `JOBS_DEFAULT_SHEET_NAME` (default `"Job Applications"`).

---

## Reused functions / helpers (do NOT rewrite)

| Function | Source | Notes |
|---|---|---|
| Chrome storage/window promise wrappers | [leetcode/background.js:459-513](leetcode/background.js#L459-L513) | Copy verbatim |
| `openPromptWindow` window-lifecycle logic | [leetcode/background.js:387-417](leetcode/background.js#L387-L417) | Copy verbatim |
| Queue/retry & `syncQueue` | [leetcode/background.js:256-337](leetcode/background.js#L256-L337) | Copy verbatim |
| MAIN-world fetch wrapper skeleton | [leetcode/inject.js:1-35](leetcode/inject.js#L1-L35) | Copy, swap URL pattern + payload shape |
| `bootstrapHistoryHooks` for SPA navigation | [leetcode/content.js:364-383](leetcode/content.js#L364-L383) | Copy verbatim |
| `normalizeWhitespace`, `isVisible`, `toTitleCase` | [leetcode/content.js:385-399](leetcode/content.js#L385-L399) | Copy verbatim |
| Apps Script `doPost` / `ensureSheetStructure_` / `jsonResponse_` | leetcode/apps-script/Code.gs | Copy, change header row + property names |

---

## Verification

1. **Unit-style smoke:** Load the unpacked extension at [jobs/](jobs/) (`chrome://extensions` → Load unpacked). Confirm no manifest errors and the toolbar icon appears.
2. **Apps Script setup:** Deploy [jobs/apps-script/Code.gs](jobs/apps-script/Code.gs) as a web app, set the three script properties, paste the URL + secret into the popup's settings panel, click Save.
3. **Per-site live test** (one application each, in a throwaway test posting if possible):
   - LinkedIn Easy Apply on a real job → confirm popup opens with title/company/location/description pre-filled → submit → row appears in sheet with `Status=Applied`.
   - Handshake apply.
   - Workday apply (any tenant — the `*.myworkdayjobs.com` match should catch it).
   - Google Careers apply.
4. **Manual log:** Visit any company careers site, click the toolbar icon, click "Log this page", fill in fields, submit. Row appears in sheet.
5. **Dedup:** Re-submit the same LinkedIn application (or refresh post-submit) — popup should not re-open and no duplicate row should appear.
6. **Offline retry:** Disconnect from internet, submit one application — verify it queues. Reconnect, click Sync — verify it appears in the sheet.
7. **Bad data:** Submit with Job Category set to "Other", with empty Pay — confirm sheet row is well-formed (empty cells, not `undefined`).
