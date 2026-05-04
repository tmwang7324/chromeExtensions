(function initializeTracker() {
    if (window.__leetcodeTrackerInitialized) return;
    window.__leetcodeTrackerInitialized = true;

    const SELECTORS = {
        submissionResult: '[data-e2e-locator="submission-result"]',
        titleLink: ['a[href^="/problems/"]','[data-cy="question-title"]'],
        tagLinks: 'a[href^="/tag/"]',
        problemDescriptionDivs: [
            '#f8940b02-76b7-27f9-4176-51a709ee6648',
            '[data-track-load="description_content"]',
            '[data-cy="question-content"]',
            
            '.question-content'
        ],
        difficultyBadges: [
            '[class*="text-difficulty-easy"]',
            '[class*="text-difficulty-medium"]',
            '[class*="text-difficulty-hard"]',
            '[data-difficulty]',
            '[diff]'
        ]
    };

    let observer = null;
    let routeKey = location.pathname;
    let lastSentFingerprint = "";
    let scheduled = false;
    let lastApiResult = null;

    bootstrapHistoryHooks();
    attachObserver();
    listenForApiResults();
    scheduleScan();
    // recheck the page after the page's route changes, since LeetCode is a single-page app and may not do a full reload on navigation.
    // clear all of the cached variables such as lastSentFingerprint and lastAPIResult to ensure we don't miss a solve that happens right after navigation.
    window.addEventListener("leetcode-route-change", () => {
        console.log("[LeetCode Tracker] Route change detected. Old:", routeKey, "New:", location.pathname);
        if (routeKey !== location.pathname) {
            routeKey = location.pathname;
            lastSentFingerprint = "";
            lastApiResult = null;
            scheduleScan();
        }
    });
    //
    function listenForApiResults() {
        window.addEventListener("message", (event) => {
            if (
                event.source !== window ||
                !event.data?.__leetcodeTracker ||
                event.data.type !== "SUBMISSION_API_RESULT"
            ) {
                return;
            }
            const p = event.data.payload;
            console.log("[LeetCode Tracker] API result received:", p);
            lastApiResult = p;
            if (p.status === "Accepted") {
                // Reset so a prior DOM-only scan's fingerprint doesn't block this send.
                lastSentFingerprint = "";
                // Call directly instead of scheduleScan() to avoid being dropped by
                // the debounce if a MutationObserver scan is already queued.
                inspectPage();
            }
        });
    }

    // Attach a MutationObserver to detect changes in the DOM and trigger scans for solve detection.
    // This is because LeetCode's React-based frontend may update the page with results after the initial load, and we want to
    // catch those updates as soon as possible.
    function attachObserver() {
        console.log("[LeetCode Tracker] Attaching DOM observer.");
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver(() => {
            console.debug("[LeetCode Tracker] DOM mutation detected, scheduling scan.");
            scheduleScan();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function scheduleScan() {
        if (scheduled) {
            return;
        }

        scheduled = true;
        window.setTimeout(() => {
            scheduled = false;
            inspectPage();
        }, 250);
    }

    async function inspectPage() {
        //console.log("[LeetCode Tracker] Inspecting page at:", location.pathname);
        const solve = extractSolveCandidate();

        if (!solve) {
            console.debug("[LeetCode Tracker] No solve candidate found on page.");
            return;
        }

        if (solve.fingerprint === lastSentFingerprint) {
            console.debug("[LeetCode Tracker] Duplicate fingerprint, skipping:", solve.fingerprint);
            return;
        }

        lastSentFingerprint = solve.fingerprint;
        console.log("[LeetCode Tracker] Sending SOLVE_DETECTED for:", solve.problemSlug, solve.difficulty, "Fingerprint:", solve.fingerprint);
        
        try {
            await chrome.runtime.sendMessage({
                type: "SOLVE_DETECTED",
                payload: solve
            });
            console.log("[LeetCode Tracker] SOLVE_DETECTED sent successfully.");
        } catch (error) {
            console.error("[LeetCode Tracker] Failed to send SOLVE_DETECTED:", error);
        }
    }

    function extractSolveCandidate() {
        //console.log("[LeetCode Tracker] Extracting solve candidate...");
        
        if (!location.pathname.startsWith("/problems/")) {
            console.debug("[LeetCode Tracker] Not on a problem page:", location.pathname);
            return null;
        }

        const resultNode = document.querySelector(SELECTORS.submissionResult);
        const domResultText = normalizeWhitespace(resultNode?.textContent || "");
        const resultText = domResultText || (lastApiResult?.status ?? "");
        //console.log("[LeetCode Tracker] Result node found:", !!resultNode, "DOM text:", domResultText, "API status:", lastApiResult?.status ?? "none");
        
        if (!resultNode) {
            console.warn("[LeetCode Tracker] Selector not found:", SELECTORS.submissionResult);
            console.warn("[LeetCode Tracker] Looking for alternative selectors...");
            const allDivs = document.querySelectorAll("div,span,p");
            let found = false;
            for (const el of allDivs) {
                if (el.textContent && el.textContent.includes("Accepted")) {
                    console.log("[LeetCode Tracker] Found 'Accepted' text in element with text:", el.textContent.substring(0, 100));
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.warn("[LeetCode Tracker] No 'Accepted' text found on page.");
            }
        }

        if (resultText !== "Accepted") {
            console.debug("[LeetCode Tracker] Result is not 'Accepted':", resultText);
            return null;
        }

        const routeInfo = parseProblemRoute();
        if (!routeInfo) {
            console.warn("[LeetCode Tracker] Could not parse problem route.");
            return null;
        }
        //console.log("[LeetCode Tracker] Parsed route info:", routeInfo);

        const descriptionInfo = extractDescriptionDivInfo();
        const titleInfo = parseProblemTitle(routeInfo.problemSlug);
        const difficulty = descriptionInfo.difficulty || extractDifficulty();
        const tags = extractTags();
        const language = lastApiResult?.language || extractStatValue([/Language\s+([A-Za-z0-9+#.\-]+)/i]);
        const runtime = lastApiResult?.runtime   || extractStatValue([/Runtime\s+([0-9.]+\s*[A-Za-z]+)/i]);
        const memory = lastApiResult?.memory     || extractStatValue([/Memory\s+([0-9.]+\s*[A-Za-z]+)/i]);
        const submissionId = lastApiResult?.submissionId || routeInfo.submissionId || extractSubmissionIdFromLinks();
        const problemNumber = descriptionInfo.problemNumber || titleInfo.problemNumber || routeInfo.problemNumber || "";
        const problemTitle = descriptionInfo.problemTitle || titleInfo.problemTitle || toTitleCase(routeInfo.problemSlug.replace(/-/g, " "));
        const problemDescription = descriptionInfo.description || "";
        const fingerprint = [routeInfo.problemSlug, submissionId || language || "manual", resultText].join("::");
        console.log("[LeetCode Tracker] Extracted solve candidate:", {
            problemSlug: routeInfo.problemSlug,
            problemNumber,
            problemTitle,
            problemDescription: problemDescription.substring(0, 80),
            difficulty,
            tags,
            language,
            runtime,
            memory,
            submissionId,
            fingerprint
        });

        return {
            detectedAt: new Date().toISOString(),
            fingerprint,
            problemSlug: routeInfo.problemSlug,
            problemNumber,
            problemTitle,
            problemDescription,
            difficulty,
            tags,
            language,
            runtime,
            memory,
            submissionId,
            leetcodeUrl: location.href,
            submissionStatus: resultText
        };
    }

    function extractDescriptionDivInfo() {
        let div = null;
        for (const selector of SELECTORS.problemDescriptionDivs) {
            div = document.querySelector(selector);
            if (div) {
                console.log("[LeetCode Tracker] Description div found with selector:", selector);
                break;
            }
        }
        if (!div) {
            console.warn("[LeetCode Tracker] No description div found. Tried:", SELECTORS.problemDescriptionDivs);
            return { description: "", difficulty: "", problemNumber: "", problemTitle: "" };
        }

        const fullText = normalizeWhitespace(div.textContent || "");
        console.log("[LeetCode Tracker] Description div text (first 200 chars):", fullText.substring(0, 200));

        // Extract difficulty from known text values within the div
        let difficulty = "";
        for (const node of div.querySelectorAll("span,div,p")) {
            const text = normalizeWhitespace(node.textContent || "");
            if (["Easy", "Medium", "Hard"].includes(text) && isVisible(node)) {
                difficulty = text;
                break;
            }
        }

        // Extract problem number and title — look for "N. Title" heading pattern
        let problemNumber = "";
        let problemTitle = "";
        const headingMatch = fullText.match(/^(\d+)\.\s+(.+?)(?:\s{2,}|$)/);
        if (headingMatch) {
            problemNumber = headingMatch[1];
            problemTitle = headingMatch[2].trim();
        }

        const description = normalizeWhitespace(div.innerText || div.textContent || "");
        console.log("[LeetCode Tracker] Description div extracted:", { difficulty, problemNumber, problemTitle });
        return { description, difficulty, problemNumber, problemTitle };
    }

    function parseProblemRoute() {
        const match = location.pathname.match(/^\/problems\/([^/]+)(?:\/submissions(?:\/detail\/([0-9]+))?)?/i);

        if (!match) {
            return null;
        }

        return {
            problemSlug: match[1],
            submissionId: match[2] || "",
            problemNumber: ""
        };
    }

    function parseProblemTitle(problemSlug) {
        const exactHref = `/problems/${problemSlug}/`;
        const alternateHref = `/problems/${problemSlug}`;
        const matchingLink = document.querySelector(
            `a[href="${exactHref}"], a[href="${alternateHref}"]`
        );

        const fallbackLinks = matchingLink
            ? [matchingLink]
            : Array.from(document.querySelectorAll(SELECTORS.titleLink));

        const titleSource = matchingLink || fallbackLinks.find((link) => {
            const href = link.getAttribute("href") || "";
            return href.startsWith(alternateHref);
        }) || fallbackLinks[0];

        const titleText = normalizeWhitespace(titleSource?.textContent || "");
        const match = titleText.match(/^(\d+)\.\s+(.+)$/);

        if (!match) {
            return { problemNumber: "", problemTitle: "" };
        }
        console.log("[LeetCode Tracker] Title link found:", titleText, "Parsed number:", match[1], "Parsed title:", match[2]);
        return {
            problemNumber: match[1],
            problemTitle: match[2]
        };
    }

    function extractDifficulty() {
        // Try targeted selectors first for speed
        for (const selector of SELECTORS.difficultyBadges) {
            const node = document.querySelector(selector);
            console.log("[LeetCode Tracker] Checking difficulty selector:", selector, "Found node:", !!node);
            if (node && isVisible(node)) {
                const text = normalizeWhitespace(node.textContent || "");
                if (["Easy", "Medium", "Hard"].includes(text)) {
                    console.log("[LeetCode Tracker] Difficulty found via selector:", selector, "→", text);
                    return text;
                }
            }
        }
        // Fall back to full text scan
        const candidates = Array.from(document.querySelectorAll("span,div,p"));
        for (const node of candidates) {
            const text = normalizeWhitespace(node.textContent || "");
            if (["Easy", "Medium", "Hard"].includes(text) && isVisible(node)) {
                return text;
            }
        }
        return "";
    }

    function extractTags() {
        const links = Array.from(document.querySelectorAll(SELECTORS.tagLinks));
        const unique = new Set();

        for (const link of links) {
            const text = normalizeWhitespace(link.textContent || "");
            if (text) {
                unique.add(text);
            }
        }

        return Array.from(unique);
    }

    function extractStatValue(patterns) {
        const pageText = normalizeWhitespace(document.body?.innerText || "");

        for (const pattern of patterns) {
            const match = pageText.match(pattern);
            if (match?.[1]) {
                return normalizeWhitespace(match[1]);
            }
        }

        return "";
    }

    function extractSubmissionIdFromLinks() {
        const links = Array.from(document.querySelectorAll('a[href*="/submissions/detail/"]'));
        for (const link of links) {
            const href = link.getAttribute("href") || "";
            const match = href.match(/\/submissions\/detail\/(\d+)/);
            if (match?.[1]) {
                return match[1];
            }
        }

        return "";
    }

    function bootstrapHistoryHooks() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function pushStateWrapper(...args) {
            const result = originalPushState.apply(this, args);
            window.dispatchEvent(new Event("leetcode-route-change"));
            return result;
        };

        history.replaceState = function replaceStateWrapper(...args) {
            const result = originalReplaceState.apply(this, args);
            window.dispatchEvent(new Event("leetcode-route-change"));
            return result;
        };

        window.addEventListener("popstate", () => {
            window.dispatchEvent(new Event("leetcode-route-change"));
        });
    }

    function normalizeWhitespace(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(node) {
        return Boolean(node && node.getClientRects().length);
    }

    function toTitleCase(text) {
        return text
            .split(" ")
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }
})();