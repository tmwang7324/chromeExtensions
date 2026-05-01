(function interceptSubmissionFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = typeof args[0] === "string" ? args[0]
            : args[0] instanceof Request ? args[0].url
            : "";

        if (url.includes("/submissions/detail/")) {
            const clone = response.clone();
            clone.json().then((data) => {
                if (!data || typeof data !== "object") return;
                // Skip intermediate polling responses — judge hasn't finished yet
                if (!data.status_msg) return;
                const idMatch = url.match(/\/submissions\/detail\/(\d+)/);
                console.log(`Data fetched from ${url}: ${JSON.stringify(data)}`);
                window.postMessage({
                    __leetcodeTracker: true,
                    type: "SUBMISSION_API_RESULT",
                    payload: {
                        status:       data.status_msg      || "",
                        runtime:      data.status_runtime  || "",
                        memory:       data.status_memory   || "",
                        language:     data.lang            || "",
                        submissionId: idMatch?.[1]         || ""
                    }
                    
                }, window.location.origin);
            }).catch(() => {});
        }

        return response;
    };
})();
