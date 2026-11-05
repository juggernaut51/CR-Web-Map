const { test, expect } = require("@playwright/test");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");
const { installAssetMocks } = require("./helpers/assets");
const { loginAsAdmin, gotoAdmin, settle } = require("./helpers/actions");

const PORT = 5306;
let server;

test.beforeAll(async () => {
    const dbConfig = await resetTestDatabase();
    server = await startServer({ port: PORT, dbConfig });
});

test.afterAll(async () => {
    if (server) await server.stop();
});

async function postBug(context, description) {
    const res = await context.request.post(`${server.baseURL}/api/bugs`, {
        data: { description, zoom: 19, lat: 40.698, lng: -124.196 }
    });
    if (!res.ok()) throw new Error(`Failed to create bug report: ${res.status()}`);
}

async function openBugLog(page) {
    await page.locator("#utility-toggle").click();
    await page.waitForTimeout(150);
    await page.locator("#view-bug-reports").click();
    await page.waitForTimeout(600);
}

test.describe("admin bug log", () => {
    test("Resolve removes the whole card", async ({ browser }) => {
        const context = await browser.newContext();
        await installAssetMocks(context);
        await loginAsAdmin(context, server.baseURL, server.adminPassword);
        await postBug(context, "Resolve Me Bug");

        const page = await context.newPage();
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);
        await openBugLog(page);

        const card = page.locator("#bug-log-body > div", { hasText: "Resolve Me Bug" });
        await expect(card).toHaveCount(1);
        await card.getByRole("button", { name: "Resolve" }).click();
        await settle(page, 600);

        await expect(page.locator("#bug-log-body", { hasText: "Resolve Me Bug" })).toHaveCount(0);

        await context.close();
    });

    test("with the DELETE failing, the card stays and an error shows", async ({ browser }) => {
        const context = await browser.newContext();
        await installAssetMocks(context);
        await loginAsAdmin(context, server.baseURL, server.adminPassword);
        await postBug(context, "Stubborn Bug");

        const page = await context.newPage();
        await context.route("**/api/bugs/*", (route) =>
            route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
        );
        let dialogMessage = null;
        page.once("dialog", async (d) => { dialogMessage = d.message(); await d.accept(); });

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);
        await openBugLog(page);

        const card = page.locator("#bug-log-body > div", { hasText: "Stubborn Bug" });
        await expect(card).toHaveCount(1);
        await card.getByRole("button", { name: "Resolve" }).click();
        await settle(page, 600);

        expect(dialogMessage).toContain("Failed to resolve");
        await expect(page.locator("#bug-log-body", { hasText: "Stubborn Bug" })).toHaveCount(1);

        await context.close();
    });
});
