const formElements = {
    walkthrough: document.getElementById("walkthrough"),
    keyInsights: document.getElementById("keyInsights"),
    mistakes: document.getElementById("mistakes"),
    confidence: document.getElementById("confidence"),
    revisit: document.getElementById("revisit"),
    problemDescription: document.getElementById("problemDescription"),
    languageEdit: document.getElementById("languageEdit"),
    runtimeEdit: document.getElementById("runtimeEdit"),
    webAppUrl: document.getElementById("webAppUrl"),
    sharedSecret: document.getElementById("sharedSecret"),
    sheetName: document.getElementById("sheetName")
};

const ui = {
    shell: document.querySelector(".shell"),
    solveStatus: document.getElementById("solve-status"),
    queueStatus: document.getElementById("queue-status"),
    problemTitle: document.getElementById("problem-title"),
    problemSlug: document.getElementById("problem-slug"),
    difficultyPill: document.getElementById("difficulty-pill"),
    languageValue: document.getElementById("language-value"),
    runtimeValue: document.getElementById("runtime-value"),
    memoryValue: document.getElementById("memory-value"),
    tagRow: document.getElementById("tag-row"),
    problemLink: document.getElementById("problem-link"),
    setupCopy: document.getElementById("setup-copy"),
    submitButton: document.getElementById("submit-button"),
    statusBanner: document.getElementById("status-banner"),
    reflectionForm: document.getElementById("reflection-form"),
    settingsForm: document.getElementById("settings-form"),
    openPromptButton: document.getElementById("open-prompt-button"),
    syncButton: document.getElementById("sync-button")
};

let appState = null;
let draftSaveHandle = null;

document.addEventListener("DOMContentLoaded", async () => {
    applyMode();
    bindEvents();
    console.log("[LeetCode Tracker] Popup loaded, fetching initial state...");
    await refreshState();
});

function applyMode() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") || "popup";
    ui.shell.dataset.mode = mode;
}

function bindEvents() {
    ui.reflectionForm.addEventListener("submit", onSubmitReflection);
    ui.settingsForm.addEventListener("submit", onSaveSettings);
    ui.openPromptButton.addEventListener("click", () => runAction("OPEN_PROMPT", null, "Prompt window opened."));
    ui.syncButton.addEventListener("click", onSyncQueue);

    for (const element of [
        formElements.walkthrough,
        formElements.keyInsights,
        formElements.mistakes,
        formElements.confidence,
        formElements.revisit,
        formElements.problemDescription,
        formElements.languageEdit,
        formElements.runtimeEdit
    ]) {
        element.addEventListener("input", scheduleDraftSave);
        element.addEventListener("change", scheduleDraftSave);
    }
}

async function refreshState() {
    const response = await sendMessage({ type: "GET_APP_STATE" });
    appState = response.state;
    renderState();
}

function renderState() {
    renderPendingSolve(appState.pendingSolve);
    renderDraft(appState.draft);
    renderSettings(appState.settings, appState.endpointConfigured, appState.queueCount);
}

function renderPendingSolve(solve) {
    if (!solve) {
        ui.solveStatus.textContent = "Waiting for a solve";
        ui.problemTitle.textContent = "No accepted solve yet";
        ui.problemSlug.textContent = "Open a LeetCode problem and get Accepted to trigger capture.";
        ui.difficultyPill.textContent = "Idle";
        ui.difficultyPill.dataset.difficulty = "";
        ui.languageValue.textContent = "-";
        ui.runtimeValue.textContent = "-";
        ui.memoryValue.textContent = "-";
        ui.tagRow.replaceChildren();
        ui.problemLink.href = "#";
        ui.problemLink.textContent = "Open submission";
        ui.submitButton.disabled = true;
        formElements.problemDescription.value = "";
        formElements.languageEdit.value = "";
        formElements.runtimeEdit.value = "";
        return;
    }

    ui.solveStatus.textContent = "Accepted solve captured";
    ui.problemTitle.textContent = [solve.problemNumber, solve.problemTitle].filter(Boolean).join(". ") || solve.problemTitle;
    ui.problemSlug.textContent = solve.problemSlug || "-";
    ui.difficultyPill.textContent = solve.difficulty || "Unknown";
    ui.difficultyPill.dataset.difficulty = solve.difficulty || "";
    ui.languageValue.textContent = solve.language || "Unknown";
    ui.runtimeValue.textContent = solve.runtime || "Unknown";
    ui.memoryValue.textContent = solve.memory || "Unknown";
    ui.problemLink.href = solve.leetcodeUrl || "#";
    ui.problemLink.textContent = solve.leetcodeUrl ? "Open submission" : "LeetCode URL unavailable";
    ui.submitButton.disabled = false;
    formElements.problemDescription.value = solve.problemDescription || "";
    formElements.languageEdit.value = solve.language || "";
    formElements.runtimeEdit.value = solve.runtime || "";

    const tags = Array.isArray(solve.tags) ? solve.tags : [];
    const chips = tags.length ? tags.map(createTagChip) : [createTagChip("No tags captured yet")];
    ui.tagRow.replaceChildren(...chips);
}

function renderDraft(draft) {
    formElements.walkthrough.value = draft.walkthrough || "";
    formElements.keyInsights.value = draft.keyInsights || "";
    formElements.mistakes.value = draft.mistakes || "";
    formElements.confidence.value = draft.confidence || "solid";
    formElements.revisit.checked = Boolean(draft.revisit);
    // Override metadata fields only if the user has previously saved edits
    if (draft.problemDescription) formElements.problemDescription.value = draft.problemDescription;
    if (draft.language) formElements.languageEdit.value = draft.language;
    if (draft.runtime) formElements.runtimeEdit.value = draft.runtime;
}

function renderSettings(settings, endpointConfigured, queueCount) {
    formElements.webAppUrl.value = settings.webAppUrl || "";
    formElements.sharedSecret.value = settings.sharedSecret || "";
    formElements.sheetName.value = settings.sheetName || "";
    ui.queueStatus.textContent = `${queueCount} queued`;
    ui.setupCopy.textContent = endpointConfigured
        ? "Apps Script endpoint is configured. Submit solves directly, or leave Sheet name blank to use the Apps Script default sheet."
        : "Add the Apps Script web app URL and shared secret before submitting or syncing solves.";
}

function createTagChip(text) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = text;
    return chip;
}

async function onSubmitReflection(event) {
    event.preventDefault();

    if (!appState?.pendingSolve) {
        showStatus("There is no pending solve to submit yet.", "warning");
        return;
    }

    const payload = collectDraftPayload();
    if (!payload.walkthrough && !payload.keyInsights && !payload.mistakes) {
        showStatus("Add at least one note before submitting.", "warning");
        return;
    }

    ui.submitButton.disabled = true;
    ui.submitButton.textContent = "Saving...";

    try {
        const response = await sendMessage({
            type: "SUBMIT_REFLECTION",
            payload
        });

        if (response.queued) {
            showStatus(response.warning || "Saved locally and queued for Google Sheets sync.", "warning");
        } else {
            showStatus("Saved to Google Sheets.", "success");
        }

        await refreshState();
    } catch (error) {
        showStatus(error.message, "warning");
    } finally {
        ui.submitButton.disabled = false;
        ui.submitButton.textContent = "Save to Google Sheets";
    }
}

async function onSaveSettings(event) {
    event.preventDefault();

    try {
        await sendMessage({
            type: "SAVE_SETTINGS",
            payload: {
                webAppUrl: formElements.webAppUrl.value,
                sharedSecret: formElements.sharedSecret.value,
                sheetName: formElements.sheetName.value
            }
        });
        showStatus("Settings saved.", "success");
        await refreshState();
    } catch (error) {
        showStatus(error.message, "warning");
    }
}

async function onSyncQueue() {
    try {
        const response = await sendMessage({ type: "SYNC_QUEUE" });
        showStatus(`Synced ${response.synced || 0} queued entr${response.synced === 1 ? "y" : "ies"}.`, "success");
        await refreshState();
    } catch (error) {
        showStatus(error.message, "warning");
    }
}

function scheduleDraftSave() {
    if (draftSaveHandle) {
        window.clearTimeout(draftSaveHandle);
    }

    draftSaveHandle = window.setTimeout(async () => {
        draftSaveHandle = null;
        try {
            await sendMessage({ type: "SAVE_DRAFT", payload: collectDraftPayload() });
        } catch (error) {
            console.debug("Could not save extension draft.", error);
        }
    }, 250);
}

function collectDraftPayload() {
    return {
        walkthrough: formElements.walkthrough.value,
        keyInsights: formElements.keyInsights.value,
        mistakes: formElements.mistakes.value,
        confidence: formElements.confidence.value,
        revisit: formElements.revisit.checked,
        problemDescription: formElements.problemDescription.value,
        language: formElements.languageEdit.value,
        runtime: formElements.runtimeEdit.value
    };
}

async function runAction(type, payload, successMessage) {
    try {
        await sendMessage({ type, payload });
        if (successMessage) {
            showStatus(successMessage, "success");
        }
    } catch (error) {
        showStatus(error.message, "warning");
    }
}

function showStatus(message, tone) {
    ui.statusBanner.textContent = message;
    ui.statusBanner.classList.remove("hidden", "warning", "success");
    if (tone) {
        ui.statusBanner.classList.add(tone);
    }

    window.clearTimeout(showStatus.dismissHandle);
    showStatus.dismissHandle = window.setTimeout(() => {
        ui.statusBanner.classList.add("hidden");
    }, 4200);
}

function sendMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            const runtimeError = chrome.runtime.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            if (!response?.ok) {
                reject(new Error(response?.error || "Extension request failed."));
                return;
            }

            resolve(response);
        });
    });
}