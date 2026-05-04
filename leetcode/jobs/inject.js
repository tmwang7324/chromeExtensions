// inject.js — MAIN-world script that wraps fetch and XMLHttpRequest so we can
// detect when a user submits a job application on LinkedIn, Handshake, Workday,
// or Google Careers. Detected submits are posted to the isolated content script
// via window.postMessage as APPLY_API_RESULT events.

(function interceptJobApplySubmits() {
    if (window.__jobTrackerInjected) return;
    window.__jobTrackerInjected = true;

    // APPLY_PATTERNS lists URL-fragment matchers per source. classify() picks the
    // first one that matches the request URL. Patterns are best-effort and should
    // be verified against real submits in DevTools — endpoints rotate over time.
    const APPLY_PATTERNS = [
        { source: "linkedin",  test: (url) => /voyager\/api\/voyagerJobsDashOnsiteApply|jobApplications|easy-apply/i.test(url) },
        { source: "handshake", test: (url) => /joinhandshake\.com\/.*\/(applications|apply)\b/i.test(url) },
        { source: "workday",   test: (url) => /myworkdayjobs\.com\/.*\/(apply|applyManually|submitApplication)/i.test(url) },
        { source: "google",    test: (url) => /careers\.google\.com\/.*\/(applications|apply)/i.test(url) || /google\.com\/about\/careers\/.*\/applications/i.test(url) }
    ];

    // classify(url) — returns the source name ("linkedin"/"handshake"/"workday"/
    // "google") if the URL matches a known submit endpoint, else null.
    function classify(url) {
        if (!url) return null;
        for (const pattern of APPLY_PATTERNS) {
            if (pattern.test(url)) return pattern.source;
        }
        return null;
    }

    // postResult(source, url, status, responseText) — emits the APPLY_API_RESULT
    // postMessage that content.js listens for. Tries to lift an application id
    // out of the JSON response body, but falls back gracefully if the body isn't
    // JSON or doesn't carry one. Never throws.
    function postResult(source, url, status, responseText) {
        let parsed = null;
        if (responseText) {
            try { parsed = JSON.parse(responseText); } catch (_) { parsed = null; }
        }
        window.postMessage({
            __jobTracker: true,
            type: "APPLY_API_RESULT",
            payload: {
                source,
                url,
                status,
                applicationId: parsed?.applicationId || parsed?.id || parsed?.data?.id || "",
                detectedAt: new Date().toISOString()
            }
        }, window.location.origin);
    }

    // Patched window.fetch — pass-through wrapper. After the response resolves,
    // if the URL classifies as a known apply endpoint and the method is POST
    // with a 2xx status, clone the response and forward it via postResult.
    // Errors are swallowed so we never break the host page's fetch behavior.
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = typeof args[0] === "string" ? args[0]
            : args[0] instanceof Request ? args[0].url
            : "";
        const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();

        const response = await originalFetch.apply(this, args);
        try {
            const source = classify(url);
            if (source && method === "POST" && response.ok) {
                response.clone().text().then((text) => postResult(source, url, response.status, text)).catch(() => {});
            }
        } catch (_) { /* never break the page */ }
        return response;
    };

    // PatchedXHR — wraps XMLHttpRequest so Workday's XHR-based submits are also
    // observed. Records method + URL on .open(), then on "loadend" checks if the
    // URL classifies and the response is 2xx; if so, forwards via postResult.
    // Prototype is preserved so instanceof checks against XMLHttpRequest still pass.
    const OriginalXHR = window.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OriginalXHR();
        let trackedUrl = "";
        let trackedMethod = "GET";

        const originalOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            trackedMethod = String(method || "GET").toUpperCase();
            trackedUrl = String(url || "");
            return originalOpen.call(this, method, url, ...rest);
        };

        xhr.addEventListener("loadend", () => {
            try {
                const source = classify(trackedUrl);
                if (!source || trackedMethod !== "POST") return;
                if (xhr.status < 200 || xhr.status >= 300) return;
                let text = "";
                try { text = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : ""; } catch (_) {}
                postResult(source, trackedUrl, xhr.status, text);
            } catch (_) { /* never break the page */ }
        });

        return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
})();
