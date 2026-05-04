// content.js — Isolated-world script. Bridges inject.js's APPLY_API_RESULT
// postMessage events into chrome.runtime APPLICATION_DETECTED messages, after
// scraping job-posting metadata from the current page.

(function initializeJobTracker() {
    if (window.__jobTrackerInitialized) return;
    window.__jobTrackerInitialized = true;

    let routeKey = location.pathname;
    let lastSentFingerprint = "";
    let lastApiResult = null;

    bootstrapHistoryHooks();
    listenForApiResults();

    // Reset cached fingerprint and api result whenever the SPA navigates so a
    // new job posting opens a clean detection slate.
    window.addEventListener("job-tracker-route-change", () => {
        if (routeKey !== location.pathname) {
            routeKey = location.pathname;
            lastSentFingerprint = "";
            lastApiResult = null;
        }
    });

    // listenForApiResults — Subscribe to APPLY_API_RESULT postMessages from
    // inject.js. When one arrives we know a real submit POST just succeeded,
    // so trigger an immediate scrape + dispatch.
    function listenForApiResults() {
        window.addEventListener("message", (event) => {
            if (event.source !== window || !event.data?.__jobTracker) return;
            if (event.data.type !== "APPLY_API_RESULT") return;
            lastApiResult = event.data.payload;
            // Reset so a prior scrape's fingerprint doesn't block this one.
            lastSentFingerprint = "";
            inspectPage();
        });
    }

    // inspectPage — Pull a candidate from the DOM, dedup against the last sent
    // fingerprint, and forward to background.js. Called from listenForApiResults
    // (auto detection) and could also be called from a manual trigger.
    async function inspectPage() {
        const application = extractApplicationCandidate();
        if (!application) return;
        if (application.fingerprint === lastSentFingerprint) return;
        lastSentFingerprint = application.fingerprint;
        try {
            await chrome.runtime.sendMessage({
                type: "APPLICATION_DETECTED",
                payload: application
            });
        } catch (error) {
            console.error("[Job Tracker] Failed to send APPLICATION_DETECTED:", error);
        }
    }

    // extractApplicationCandidate — Detect the source by hostname, run the
    // matching per-site extractor, then enrich with category guess + fingerprint.
    // Returns null when the page doesn't look like a job posting.
    function extractApplicationCandidate() {
        const source = detectSource();
        if (!source) return null;

        const extractor = EXTRACTORS[source] || EXTRACTORS.generic;
        const scraped = extractor() || {};

        const jobTitle = scraped.jobTitle || "";
        const company = scraped.company || "";
        const jobLocation = scraped.location || "";
        if (!jobTitle && !company) return null;

        const realId = scraped.jobId || extractJobIdFromUrl(source);
        const synthesizedId = [jobTitle, company, jobLocation]
            .map((s) => normalizeWhitespace(String(s)).toLowerCase())
            .filter(Boolean)
            .join("|");
        const jobId = realId || synthesizedId || location.pathname;
        const fingerprint = [source, location.hostname, jobId, "applied"].join("::");

        return {
            detectedAt: lastApiResult?.detectedAt || new Date().toISOString(),
            fingerprint,
            source,
            jobTitle,
            company,
            location: jobLocation,
            pay: scraped.pay || "",
            jobDescription: scraped.jobDescription || "",
            qualifications: scraped.qualifications || "",
            link: scraped.link || location.href,
            category: guessCategory(jobTitle),
            jobId
        };
    }

    // detectSource — Map hostname → source key. Returns null for sites the
    // extension wasn't registered to handle (manual log path covers those).
    function detectSource() {
        const host = location.hostname;
        if (host.endsWith("linkedin.com")) return "linkedin";
        if (host.endsWith("joinhandshake.com")) return "handshake";
        if (host.endsWith("myworkdayjobs.com")) return "workday";
        if (host.endsWith("careers.google.com") || host === "www.google.com") return "google";
        return null;
    }

    // extractJobIdFromUrl — Per-source URL parser pulling the platform-native
    // job id when present. Used as the strong dedup key when available.
    function extractJobIdFromUrl(source) {
        const path = location.pathname;
        if (source === "linkedin") return path.match(/\/jobs\/view\/(\d+)/)?.[1] || "";
        if (source === "handshake") return path.match(/\/jobs\/(\d+)/)?.[1] || "";
        if (source === "workday") return path.match(/\/job\/[^/]+\/([^/]+)/)?.[1] || "";
        if (source === "google") return path.match(/jobs\/results\/(\d+)/)?.[1] || "";
        return "";
    }

    // EXTRACTORS — One scraper per source. Each returns
    // { jobTitle, company, location, pay, jobDescription, qualifications, link, jobId }.
    // Selectors are best-effort starting points; verify against live pages.
    const EXTRACTORS = {
        linkedin() {
            const titleEl = document.querySelector(".jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title");
            const companyEl = document.querySelector(".jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name a");
            const locationEl = document.querySelector(".jobs-unified-top-card__bullet, .job-details-jobs-unified-top-card__primary-description-container");
            const descEl = document.querySelector("#job-details, .jobs-description__content");
            const payEl = document.querySelector(".jobs-unified-top-card__salary-info, .compensation__salary");
            const description = normalizeWhitespace(descEl?.innerText || "");
            return {
                jobTitle: normalizeWhitespace(titleEl?.textContent),
                company: normalizeWhitespace(companyEl?.textContent),
                location: normalizeWhitespace(locationEl?.textContent),
                pay: normalizeWhitespace(payEl?.textContent) || extractPayFromText(description),
                jobDescription: description,
                qualifications: extractQualifications(description),
                link: location.href
            };
        },
        handshake() {
            const titleEl = document.querySelector('[data-hook="job-title"], h1');
            const companyEl = document.querySelector('[data-hook="employer-name"], a[href*="/employers/"]');
            const locationEl = document.querySelector('[data-hook="job-location"]');
            const descEl = document.querySelector('[data-hook="job-description"], main article');
            const payEl = document.querySelector('[data-hook="job-pay"], [data-hook="salary"]');
            const description = normalizeWhitespace(descEl?.innerText || "");
            return {
                jobTitle: normalizeWhitespace(titleEl?.textContent),
                company: normalizeWhitespace(companyEl?.textContent),
                location: normalizeWhitespace(locationEl?.textContent),
                pay: normalizeWhitespace(payEl?.textContent) || extractPayFromText(description),
                jobDescription: description,
                qualifications: extractQualifications(description),
                link: location.href
            };
        },
        workday() {
            const titleEl = document.querySelector('[data-automation-id="jobPostingHeader"]');
            const locationEl = document.querySelector('[data-automation-id="locations"], [data-automation-id="jobPostingLocation"]');
            const descEl = document.querySelector('[data-automation-id="jobPostingDescription"]');
            const description = normalizeWhitespace(descEl?.innerText || "");
            // Workday tenants ARE the company; pull from hostname (e.g. "stripe.wd1.myworkdayjobs.com" -> "stripe")
            const tenant = location.hostname.split(".")[0];
            return {
                jobTitle: normalizeWhitespace(titleEl?.textContent),
                company: tenant ? tenant.charAt(0).toUpperCase() + tenant.slice(1) : "",
                location: normalizeWhitespace(locationEl?.textContent),
                pay: extractPayFromText(description),
                jobDescription: description,
                qualifications: extractQualifications(description),
                link: location.href
            };
        },
        google() {
            const titleEl = document.querySelector("h2.gc-job-detail__title, h1");
            const locationEl = document.querySelector('[itemprop="jobLocation"], .gc-job-detail__location');
            const descEl = document.querySelector(".gc-job-detail__content, [itemprop='description']");
            const description = normalizeWhitespace(descEl?.innerText || "");
            return {
                jobTitle: normalizeWhitespace(titleEl?.textContent),
                company: "Google",
                location: normalizeWhitespace(locationEl?.textContent),
                pay: extractPayFromText(description),
                jobDescription: description,
                qualifications: extractQualifications(description),
                link: location.href
            };
        },
        // generic — Used by the manual-log path for unknown company sites.
        // Pulls whatever it can from heading + meta tags and leaves the rest blank
        // for the user to fill in.
        generic() {
            const titleEl = document.querySelector("h1");
            const description = normalizeWhitespace(document.body?.innerText || "").slice(0, 4000);
            return {
                jobTitle: normalizeWhitespace(titleEl?.textContent) || document.title,
                company: "",
                location: "",
                pay: extractPayFromText(description),
                jobDescription: description,
                qualifications: extractQualifications(description),
                link: location.href
            };
        }
    };

    // extractPayFromText — Best-effort regex scan for the first salary-looking
    // dollar amount or range in the job description. Returns "" if no match.
    function extractPayFromText(text) {
        if (!text) return "";
        const match = text.match(/\$[\d,]+(?:\.\d+)?(?:\s*[-–]\s*\$?[\d,]+(?:\.\d+)?)?(?:\s*(?:\/|per)?\s*(?:hour|hr|year|yr|annually|annual))?/i);
        return match ? normalizeWhitespace(match[0]) : "";
    }

    // extractQualifications — Best-effort scrape of the "Qualifications" or
    // "Requirements" section. Looks for those headers and grabs the following
    // ~600 chars; returns "" if no header is found.
    function extractQualifications(text) {
        if (!text) return "";
        const match = text.match(/(qualifications|requirements|what we'?re looking for|minimum qualifications)\s*[:\-]?\s*(.{50,800}?)(?=responsibilities|benefits|about (us|the team|the role)|preferred|nice to have|$)/i);
        return match ? normalizeWhitespace(match[2]).slice(0, 800) : "";
    }

    // guessCategory — Apply keyword heuristic to the job title. User can override
    // in the popup dropdown.
    function guessCategory(title) {
        const t = (title || "").toLowerCase();
        if (/\b(engineer|developer|swe|sde|software|programmer|backend|frontend|full[\s-]?stack)\b/.test(t)) return "Software";
        if (/\b(analyst|analytics|business intelligence|\bbi\b|data scientist|data science)\b/.test(t)) return "Data Analyst";
        return "";
    }

    // bootstrapHistoryHooks — Patch pushState/replaceState and listen for popstate
    // so SPA navigation (LinkedIn, Workday, Google) fires our route-change event.
    function bootstrapHistoryHooks() {
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function (...args) {
            const r = origPush.apply(this, args);
            window.dispatchEvent(new Event("job-tracker-route-change"));
            return r;
        };
        history.replaceState = function (...args) {
            const r = origReplace.apply(this, args);
            window.dispatchEvent(new Event("job-tracker-route-change"));
            return r;
        };
        window.addEventListener("popstate", () => {
            window.dispatchEvent(new Event("job-tracker-route-change"));
        });
    }

    // normalizeWhitespace — Collapse all whitespace runs to single spaces and trim.
    function normalizeWhitespace(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }
})();
