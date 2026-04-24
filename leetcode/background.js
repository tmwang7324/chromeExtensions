const STORAGE_KEYS = {
    settings: "settings",
    pendingSolve: "pendingSolve",
    draft: "draft",
    queue: "queue",
    loggedFingerprints: "loggedFingerprints",
    promptWindowId: "promptWindowId"
};

const DEFAULT_SETTINGS = {
    webAppUrl: "",
    sharedSecret: "",
    sheetName: ""
};

const SHEET_COLUMNS = [
    "Problem Number",
    "Problem Title",
    "Problem Description",
    "Difficulty",
    "Tags",
    "Language",
    "Runtime",
    "Memory",
    "LeetCode URL",
    "Walkthrough",
    "Key Insights",
    "Mistakes / Blockers",
    "Confidence",
    "Revisit",
    "Submitted At"
];

chrome.runtime.onInstalled.addListener(async () => {
    const stored = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.queue, STORAGE_KEYS.loggedFingerprints]);

    await storageSet({ [STORAGE_KEYS.settings]: normalizeSettings(stored[STORAGE_KEYS.settings]) });

    if (!Array.isArray(stored[STORAGE_KEYS.queue])) {
        await storageSet({ [STORAGE_KEYS.queue]: [] });
    }

    if (!stored[STORAGE_KEYS.loggedFingerprints]) {
        await storageSet({ [STORAGE_KEYS.loggedFingerprints]: {} });
    }

    // Inject content script into already-open LeetCode tabs that missed the initial injection.
    const tabs = await chrome.tabs.query({ url: "https://leetcode.com/problems/*" });
    for (const tab of tabs) {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
        }).catch(() => { /* tab may have closed or be restricted */ });
    }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    const { promptWindowId } = await storageGet([STORAGE_KEYS.promptWindowId]);

    if (promptWindowId === windowId) {
        await storageRemove([STORAGE_KEYS.promptWindowId]);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    // Browser restart invalidates all previous window IDs. Clear the stored
    // prompt window ID so openPromptWindow() always creates a fresh window.
    await storageRemove([STORAGE_KEYS.promptWindowId]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));

    return true;
});

async function handleMessage(message) {
    switch (message?.type) {
        case "SOLVE_DETECTED":
            return handleSolveDetected(message.payload);
        case "GET_APP_STATE":
            return { state: await getAppState() };
        case "SAVE_SETTINGS":
            return saveSettings(message.payload);
        case "SAVE_DRAFT":
            return saveDraft(message.payload);
        case "SUBMIT_REFLECTION":
            return submitReflection(message.payload);
        case "SYNC_QUEUE":
            return syncQueue();
        case "OPEN_PROMPT":
            return openPromptWindow();
        default:
            throw new Error("Unsupported message type.");
    }
}

async function handleSolveDetected(payload) {
    if (!payload?.fingerprint) {
        throw new Error("Missing solve fingerprint.");
    }

    const stored = await storageGet([
        STORAGE_KEYS.pendingSolve,
        STORAGE_KEYS.loggedFingerprints
    ]);

    const pendingSolve = stored[STORAGE_KEYS.pendingSolve];
    const loggedFingerprints = stored[STORAGE_KEYS.loggedFingerprints] || {};

    if (loggedFingerprints[payload.fingerprint]) {
        return { duplicate: "logged" };
    }

    if (pendingSolve?.fingerprint === payload.fingerprint) {
        await openPromptWindow();
        return { duplicate: "pending" };
    }

    await storageSet({
        [STORAGE_KEYS.pendingSolve]: {
            ...payload,
            detectedAt: payload.detectedAt || new Date().toISOString()
        }
    });

    await openPromptWindow();
    return { accepted: true };
}

async function getAppState() {
    const stored = await storageGet([
        STORAGE_KEYS.settings,
        STORAGE_KEYS.pendingSolve,
        STORAGE_KEYS.draft,
        STORAGE_KEYS.queue
    ]);

    return {
        settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
        pendingSolve: stored[STORAGE_KEYS.pendingSolve] || null,
        draft: stored[STORAGE_KEYS.draft] || createEmptyDraft(),
        queueCount: Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue].length : 0,
        sheetColumns: SHEET_COLUMNS,
        endpointConfigured: isEndpointConfigured(stored[STORAGE_KEYS.settings])
    };
}

async function saveSettings(payload) {
    const settings = normalizeSettings(payload);

    await storageSet({ [STORAGE_KEYS.settings]: settings });
    return { settings };
}

async function saveDraft(payload) {
    const draft = {
        walkthrough: String(payload?.walkthrough || ""),
        keyInsights: String(payload?.keyInsights || ""),
        mistakes: String(payload?.mistakes || ""),
        confidence: String(payload?.confidence || "solid"),
        revisit: Boolean(payload?.revisit),
        problemDescription: String(payload?.problemDescription || ""),
        language: String(payload?.language || ""),
        runtime: String(payload?.runtime || "")
    };

    await storageSet({ [STORAGE_KEYS.draft]: draft });
    return { draft };
}

async function submitReflection(payload) {
    const stored = await storageGet([
        STORAGE_KEYS.pendingSolve,
        STORAGE_KEYS.settings,
        STORAGE_KEYS.queue,
        STORAGE_KEYS.loggedFingerprints
    ]);

    const pendingSolve = stored[STORAGE_KEYS.pendingSolve];
    const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

    if (!pendingSolve) {
        throw new Error("There is no pending solve to submit.");
    }

    ensureEndpointConfigured(settings);

    const record = buildSubmissionRecord(pendingSolve, payload);
    console.log("[LeetCode Tracker] Built submission record:", record);

    try {
        console.log("[LeetCode Tracker] Attempting to POST record to Apps Script...");
        await appendRecordToSheet(record, settings);
        console.log("[LeetCode Tracker] Successfully appended record to sheet.");
        await markSolveCompleted(pendingSolve.fingerprint);
        console.log("[LeetCode Tracker] Marked solve as completed.");
        return { submitted: true, queued: false };
    } catch (error) {
        console.warn("[LeetCode Tracker] POST failed, queueing locally:", error.message);
        const queue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];
        queue.push({ record, queuedAt: new Date().toISOString() });
        await storageSet({ [STORAGE_KEYS.queue]: queue });
        await markSolveCompleted(pendingSolve.fingerprint);
        console.log("[LeetCode Tracker] Record queued for retry.");
        return {
            submitted: true,
            queued: true,
            warning: error.message || "The entry was queued locally because the Apps Script request failed."
        };
    }
}

async function syncQueue() {
    const stored = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.queue]);
    const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
    const queue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];

    ensureEndpointConfigured(settings);

    if (!queue.length) {
        console.log("[LeetCode Tracker] Queue is empty.");
        return { synced: 0 };
    }

    console.log("[LeetCode Tracker] Syncing queue with", queue.length, "items...");

    const remaining = [];
    let synced = 0;

    for (const item of queue) {
        try {
            console.log("[LeetCode Tracker] Syncing queued item:", item.record.problemTitle);
            await appendRecordToSheet(item.record, settings);
            console.log("[LeetCode Tracker] Synced:", item.record.problemTitle);
            synced += 1;
        } catch (error) {
            console.warn("[LeetCode Tracker] Failed to sync item:", item.record.problemTitle, error.message);
            remaining.push({ ...item, lastError: error.message || "Sync failed." });
        }
    }

    await storageSet({ [STORAGE_KEYS.queue]: remaining });
    console.log("[LeetCode Tracker] Sync complete. Synced:", synced, "Remaining:", remaining.length);
    return { synced, remaining: remaining.length };
}

async function appendRecordToSheet(record, settings) {
    ensureEndpointConfigured(settings);

    const requestBody = {
        record,
        sharedSecret: settings.sharedSecret
    };
    if (settings.sheetName) {
        requestBody.sheetName = settings.sheetName;
    }

    console.log("[LeetCode Tracker] Posting to Apps Script URL:", settings.webAppUrl);
    console.log("[LeetCode Tracker] Request body:", requestBody);

    const response = await fetch(settings.webAppUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shared-Secret": settings.sharedSecret
        },
        body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    let responsePayload = null;

    if (responseText) {
        try {
            responsePayload = JSON.parse(responseText);
        } catch (error) {
            responsePayload = null;
        }
    }

    console.log("[LeetCode Tracker] Response status:", response.status, "Response text:", responseText);

    if (!response.ok) {
        console.error("[LeetCode Tracker] Request failed with status", response.status);
        throw new Error(responsePayload?.error || `Apps Script request failed: ${responseText || response.status}`);
    }

    if (responsePayload && responsePayload.ok === false) {
        console.error("[LeetCode Tracker] Apps Script returned error:", responsePayload.error);
        throw new Error(responsePayload.error || "Apps Script rejected the write request.");
    }

    console.log("[LeetCode Tracker] Record posted successfully.");
}

function buildSubmissionRecord(pendingSolve, payload) {
    return {
        problemNumber: pendingSolve.problemNumber || "",
        problemTitle: pendingSolve.problemTitle || "",
        problemDescription: String(payload?.problemDescription || "").trim() || pendingSolve.problemDescription || "",
        difficulty: pendingSolve.difficulty || "",
        tags: Array.isArray(pendingSolve.tags) ? pendingSolve.tags : [],
        language: String(payload?.language || "").trim() || pendingSolve.language || "",
        runtime: String(payload?.runtime || "").trim() || pendingSolve.runtime || "",
        memory: pendingSolve.memory || "",
        leetcodeUrl: pendingSolve.leetcodeUrl || "",
        walkthrough: String(payload?.walkthrough || "").trim(),
        keyInsights: String(payload?.keyInsights || "").trim(),
        mistakes: String(payload?.mistakes || "").trim(),
        confidence: String(payload?.confidence || "solid"),
        revisit: Boolean(payload?.revisit),
        submittedAt: new Date().toISOString()
    };
}

function recordToRow(record) {
    return [
        record.problemNumber,
        record.problemTitle,
        record.problemDescription,
        record.difficulty,
        record.tags.join(", "),
        record.language,
        record.runtime,
        record.memory,
        record.leetcodeUrl,
        record.walkthrough,
        record.keyInsights,
        record.mistakes,
        record.confidence,
        record.revisit ? "Yes" : "No",
        record.submittedAt
    ];
}

async function markSolveCompleted(fingerprint) {
    const { loggedFingerprints = {} } = await storageGet([STORAGE_KEYS.loggedFingerprints]);
    loggedFingerprints[fingerprint] = new Date().toISOString();

    await storageSet({ [STORAGE_KEYS.loggedFingerprints]: loggedFingerprints });
    await storageRemove([STORAGE_KEYS.pendingSolve, STORAGE_KEYS.draft]);
}

async function openPromptWindow() {
    const { promptWindowId } = await storageGet([STORAGE_KEYS.promptWindowId]);
    const popupUrl = chrome.runtime.getURL("popup.html");

    if (promptWindowId) {
        try {
            const win = await windowsGet(promptWindowId, { populate: true });
            const isOurPopup = Array.isArray(win?.tabs) &&
                win.tabs.some((tab) => (tab.url || "").startsWith(popupUrl));

            if (isOurPopup) {
                await windowsUpdate(promptWindowId, { focused: true, drawAttention: true });
                return { opened: false, focused: true };
            }
        } catch (_) {
            // Window no longer exists or belongs to a different extension session.
        }
        await storageRemove([STORAGE_KEYS.promptWindowId]);
    }

    const windowInfo = await windowsCreate({
        url: chrome.runtime.getURL("popup.html?mode=prompt"),
        type: "popup",
        width: 460,
        height: 820,
        focused: true
    });

    await storageSet({ [STORAGE_KEYS.promptWindowId]: windowInfo.id });
    return { opened: true, focused: true };
}

function ensureEndpointConfigured(settings) {
    const normalizedSettings = normalizeSettings(settings);

    if (!normalizedSettings.webAppUrl) {
        throw new Error("Set the Apps Script web app URL before submitting or syncing entries.");
    }

    if (!normalizedSettings.sharedSecret) {
        throw new Error("Set the shared secret before submitting or syncing entries.");
    }
}

function isEndpointConfigured(settings) {
    const normalizedSettings = normalizeSettings(settings);
    return Boolean(normalizedSettings.webAppUrl && normalizedSettings.sharedSecret);
}

function normalizeSettings(settings) {
    return {
        webAppUrl: String(settings?.webAppUrl || "").trim(),
        sharedSecret: String(settings?.sharedSecret || "").trim(),
        sheetName: String(settings?.sheetName || DEFAULT_SETTINGS.sheetName).trim()
    };
}

function createEmptyDraft() {
    return {
        walkthrough: "",
        keyInsights: "",
        mistakes: "",
        confidence: "solid",
        revisit: false,
        problemDescription: "",
        language: "",
        runtime: ""
    };
}

function storageGet(keys) {
    return chrome.storage.local.get(keys);
}

function storageSet(items) {
    return chrome.storage.local.set(items);
}

function storageRemove(keys) {
    return chrome.storage.local.remove(keys);
}

function windowsGet(windowId, options) {
    return new Promise((resolve, reject) => {
        chrome.windows.get(windowId, options, (win) => {
            const runtimeError = chrome.runtime.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            resolve(win);
        });
    });
}

function windowsCreate(options) {
    return new Promise((resolve, reject) => {
        chrome.windows.create(options, (windowInfo) => {
            const runtimeError = chrome.runtime.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            resolve(windowInfo);
        });
    });
}

function windowsUpdate(windowId, options) {
    return new Promise((resolve, reject) => {
        chrome.windows.update(windowId, options, (windowInfo) => {
            const runtimeError = chrome.runtime.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            resolve(windowInfo);
        });
    });
}