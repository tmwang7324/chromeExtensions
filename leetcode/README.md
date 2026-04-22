# LeetCode Solutions Tracker

This extension watches LeetCode problem pages for an Accepted submission, opens a reflection UI immediately, and sends the completed record to a Google Apps Script web app that writes to Google Sheets.

## What is included in v1

- Accepted-result detection on LeetCode problem pages.
- Metadata extraction for title, slug, difficulty, tags, and visible submission stats.
- Reflection capture for walkthrough, key insights, mistakes/blockers, confidence, and revisit flag.
- Apps Script-backed Sheets append flow with queued offline retry.

## Files

- `manifest.json` — MV3 manifest, content script registration, and Apps Script host permissions.
- `content.js` — watches LeetCode DOM and emits solve events.
- `background.js` — manages pending solves, dedupe, queued retries, and Apps Script writes.
- `popup.html`, `popup.js`, `popup.css` — reflection UI and settings surface.

## Setup

1. Create or open a Google Apps Script project that is bound to or can open the spreadsheet you want to use.
2. Store the spreadsheet ID, default sheet name, and shared secret in Apps Script properties.
3. Implement the Apps Script `doPost(e)` handler to validate `X-Shared-Secret`, create the target sheet if missing, repair row 1 headers when missing or mismatched, and append one LeetCode record per row.
4. Deploy the script as a web app that your extension can call.
5. Open Chrome extensions, enable Developer mode, choose Load unpacked, and point Chrome at `chromeExtensions/leetcode`.
6. Open the extension popup and save the Apps Script web app URL, the shared secret, and an optional sheet name override.

## Apps Script contract

The extension sends a JSON `POST` request with this shape:

```json
{
	"sheetName": "optional-sheet-override",
	"sharedSecret": "same-secret-sent-in-header-for-apps-script-compatibility",
	"record": {
		"problemNumber": "1",
		"problemTitle": "Two Sum",
		"problemSlug": "two-sum",
		"difficulty": "Easy",
		"tags": ["Array", "Hash Table"],
		"language": "JavaScript",
		"runtime": "52 ms",
		"memory": "44.1 MB",
		"submissionId": "1234567890",
		"leetcodeUrl": "https://leetcode.com/problems/two-sum/submissions/1234567890/",
		"detectedAt": "2026-04-21T00:00:00.000Z",
		"walkthrough": "...",
		"keyInsights": "...",
		"mistakes": "...",
		"confidence": "solid",
		"revisit": false,
		"submittedAt": "2026-04-21T00:05:00.000Z"
	}
}
```

Request headers:

- `Content-Type: application/json`
- `X-Shared-Secret: <sharedSecret>`

Apps Script web apps do not reliably expose custom request headers to `doPost(e)`, so the extension also mirrors the shared secret in the JSON body. The script should validate the body value.

Apps Script should respond with JSON similar to:

```json
{
	"ok": true,
	"sheetNameUsed": "LeetCode Log",
	"createdSheet": false,
	"createdHeaders": false
}
```

If `sheetName` is blank or omitted, Apps Script should use its configured default sheet.

## Spreadsheet columns

Rows are appended in this order:

1. Problem Number
2. Problem Title
3. Problem Slug
4. Difficulty
5. Tags
6. Language
7. Runtime
8. Memory
9. Submission ID
10. LeetCode URL
11. Detected At
12. Walkthrough
13. Key Insights
14. Mistakes / Blockers
15. Confidence
16. Revisit
17. Submitted At

## Notes

- The extension is DOM-first. If LeetCode changes selectors or hides metadata behind a different view, some optional fields may be blank.
- `submission-result` with the text `Accepted` is the current main trigger.
- The action popup doubles as the manual resume surface for unfinished drafts, while the service worker opens the same page in a focused popup window after a new Accepted solve.
- If an Apps Script write fails, the record is queued locally and can be retried with the Sync queued entries button.