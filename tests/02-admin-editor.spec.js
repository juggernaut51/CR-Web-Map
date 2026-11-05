const { test, expect } = require("@playwright/test");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");
const { installAssetMocks } = require("./helpers/assets");
const { loginAsAdmin, gotoAdmin, trackRequests, queueDialogs, acceptPrompt, settle } = require("./helpers/actions");
const { clickMapAt, drawPolygon, drawPolyline, TOOLBAR, regionCenter, squareAround, lineAround } = require("./helpers/draw");

const PORT = 5302;
let server;

test.beforeAll(async () => {
    const dbConfig = await resetTestDatabase();
    server = await startServer({ port: PORT, dbConfig });
});

test.afterAll(async () => {
    if (server) await server.stop();
});

/** Opens a fresh, logged-in admin page in its own context. */
async function newAdminPage(browser) {
    const context = await browser.newContext();
    await installAssetMocks(context);
    await loginAsAdmin(context, server.baseURL, server.adminPassword);
    const page = await context.newPage();
    await gotoAdmin(page, server.baseURL);
    await page.waitForTimeout(1200); // let bootAdmin() finish fetching + rendering
    return { context, page };
}

function isWriteRequest(req) {
    return ["POST", "PUT", "PATCH", "DELETE"].includes(req.method());
}

test.describe("admin editor", () => {
    test("loading /admin sends no write requests", async ({ browser }) => {
        const context = await browser.newContext();
        await installAssetMocks(context);
        await loginAsAdmin(context, server.baseURL, server.adminPassword);
        const page = await context.newPage();
        const writes = trackRequests(page, isWriteRequest);
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1500);
        expect(writes.list).toEqual([]);
        await context.close();
    });

    test("B, Escape, E, then a map click sends exactly 1 entrance POST", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);
        const writes = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        queueDialogs(page, [acceptPrompt("Test Entrance A")]);

        await page.keyboard.press("b");
        await page.waitForTimeout(200);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        await page.keyboard.press("e");
        await page.waitForTimeout(200);
        await clickMapAt(page, ...regionCenter(0));
        await settle(page, 600);

        expect(writes.list).toHaveLength(1);
        expect(JSON.parse(writes.list[0].postData).properties.type).toBe("entrance");
        await context.close();
    });

    test("B, then the toolbar marker button, then a click sends exactly 1 entrance POST", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);
        const writes = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        queueDialogs(page, [acceptPrompt("Test Entrance B")]);

        await page.keyboard.press("b");
        await page.waitForTimeout(200);
        await page.locator(TOOLBAR.marker).click();
        await page.waitForTimeout(200);
        await clickMapAt(page, ...regionCenter(1));
        await settle(page, 600);

        expect(writes.list).toHaveLength(1);
        expect(JSON.parse(writes.list[0].postData).properties.type).toBe("entrance");
        await context.close();
    });

    test("starting polygon erase, Escape, then B and drawing over walkways sends 1 building POST and 0 walkway DELETEs", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);
        const featurePosts = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        const walkwayDeletes = trackRequests(page, (r) => r.method() === "DELETE" && r.url().includes("/api/walkways"));
        queueDialogs(page, [acceptPrompt("Over Walkways"), acceptPrompt("OW")]);

        await page.locator("#utility-toggle").click();
        await page.locator('[data-action="polygon-delete"]').click();
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        await page.keyboard.press("b");
        await page.waitForTimeout(200);
        // Centered on campus, so this square necessarily crosses real walkways.
        await drawPolygon(page, squareAround([0.55, 0.45], 0.12));
        await settle(page, 600);

        expect(walkwayDeletes.list).toHaveLength(0);
        expect(featurePosts.list).toHaveLength(1);
        expect(JSON.parse(featurePosts.list[0].postData).properties.type).toBe("building");
        await context.close();
    });

    test("the toolbar marker, polygon and line each send exactly 1 POST of the right type", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);
        const featurePosts = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        const walkwayPosts = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/walkways"));
        queueDialogs(page, [
            acceptPrompt("Toolbar Entrance"),
            acceptPrompt("Toolbar Building"),
            acceptPrompt("TB"),
            acceptPrompt("Toolbar Walkway")
        ]);

        await page.locator(TOOLBAR.marker).click();
        await page.waitForTimeout(200);
        await clickMapAt(page, ...regionCenter(2));
        await settle(page, 500);

        await page.locator(TOOLBAR.polygon).click();
        await page.waitForTimeout(200);
        await drawPolygon(page, squareAround(regionCenter(3)));
        await settle(page, 500);

        await page.locator(TOOLBAR.polyline).click();
        await page.waitForTimeout(200);
        await drawPolyline(page, lineAround(regionCenter(4)));
        await settle(page, 600);

        expect(featurePosts.list).toHaveLength(2);
        expect(featurePosts.list.map((r) => JSON.parse(r.postData).properties.type).sort()).toEqual(["building", "entrance"]);
        expect(walkwayPosts.list).toHaveLength(1);
        expect(JSON.parse(walkwayPosts.list[0].postData).properties.type).toBe("walkway");
        await context.close();
    });

    test("a 4-point curved walkway saved through the API keeps its _id and coordinates over two /admin reloads", async ({ browser }) => {
        const context = await browser.newContext();
        await installAssetMocks(context);
        await loginAsAdmin(context, server.baseURL, server.adminPassword);

        const coords = [
            [-124.1975, 40.6975],
            [-124.1973, 40.6977],
            [-124.1970, 40.6978],
            [-124.1968, 40.6980]
        ];
        const createRes = await context.request.post(`${server.baseURL}/api/walkways`, {
            data: {
                type: "Feature",
                geometry: { type: "LineString", coordinates: coords },
                properties: { type: "walkway", name: "Curved Test Path", curved: true, control: coords }
            }
        });
        expect(createRes.ok()).toBeTruthy();
        const saved = await createRes.json();
        const id = saved.properties._id;
        expect(id).toBeTruthy();

        const page = await context.newPage();
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const after = await context.request.get(`${server.baseURL}/api/walkways`);
        const fc = await after.json();
        const matches = fc.features.filter((f) => f.properties && f.properties._id === id);
        expect(matches).toHaveLength(1);
        expect(matches[0].geometry.coordinates).toEqual(coords);
        expect(matches[0].properties.curved).toBe(true);

        await context.close();
    });
});
