// Shared browser-driving helpers: login, page navigation, request tracking and
// window.alert/confirm/prompt handling.

/**
 * Logs in as admin by POSTing the login form directly through the context's request
 * API, which shares cookies with pages opened from that context.
 */
async function loginAsAdmin(context, baseURL, password) {
    const res = await context.request.post(`${baseURL}/login`, {
        form: { password },
        maxRedirects: 0
    });
    if (res.status() !== 302) {
        throw new Error(`Login did not redirect as expected (status ${res.status()})`);
    }
}

async function dismissWelcomeIfPresent(page) {
    const gotIt = page.locator("#welcome-got-it");
    try {
        if (await gotIt.isVisible({ timeout: 1000 })) {
            await gotIt.click();
        }
    } catch (_) {
        // not present — nothing to dismiss
    }
}

/** Navigates to the public map and dismisses the first-visit welcome dialog. */
async function gotoPublic(page, baseURL, path = "/") {
    await page.goto(baseURL + path);
    await dismissWelcomeIfPresent(page);
    return page;
}

/** Navigates to the admin editor (caller must already be logged in on this context). */
async function gotoAdmin(page, baseURL) {
    await page.goto(baseURL + "/admin");
    return page;
}

/**
 * Records every request matching `predicate` fired on `page` from the moment this is
 * called until `stop()` is invoked.
 * @param {import('@playwright/test').Page} page
 * @param {(req:import('@playwright/test').Request)=>boolean} predicate
 */
function trackRequests(page, predicate) {
    const list = [];
    const handler = (req) => {
        if (predicate(req)) list.push({ method: req.method(), url: req.url(), postData: req.postData() });
    };
    page.on("request", handler);
    return { list, stop: () => page.off("request", handler) };
}

/**
 * Queues one-shot dialog responders, consumed in the order dialogs actually fire.
 * Any dialog beyond the queue is dismissed automatically.
 * @param {import('@playwright/test').Page} page
 * @param {Array<(dialog:import('@playwright/test').Dialog)=>Promise<void>|void>} responders
 */
function queueDialogs(page, responders) {
    const queue = responders.slice();
    const handler = async (dialog) => {
        const fn = queue.shift();
        try {
            if (fn) await fn(dialog);
            else await dialog.dismiss();
        } catch (_) {
            // dialog may already be gone
        }
    };
    page.on("dialog", handler);
    return () => page.off("dialog", handler);
}

const acceptPrompt = (text) => (dialog) => dialog.accept(text);
const acceptConfirm = () => (dialog) => dialog.accept();
const dismiss = () => (dialog) => dialog.dismiss();

/** Waits past the grace period used to prove no extra network request shows up. */
async function settle(page, ms = 400) {
    await page.waitForTimeout(ms);
}

module.exports = {
    loginAsAdmin,
    dismissWelcomeIfPresent,
    gotoPublic,
    gotoAdmin,
    trackRequests,
    queueDialogs,
    acceptPrompt,
    acceptConfirm,
    dismiss,
    settle
};
