const { test, expect } = require("@playwright/test");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");
const { installAssetMocks } = require("./helpers/assets");
const { loginAsAdmin, gotoPublic } = require("./helpers/actions");
const { installMapCapture, pixelForLatLng, CAMPUS_CENTER } = require("./helpers/draw");

const PORT = 5305;
const [CX, CY] = CAMPUS_CENTER;
let server;

test.beforeAll(async () => {
    const dbConfig = await resetTestDatabase();
    server = await startServer({ port: PORT, dbConfig });
});

test.afterAll(async () => {
    if (server) await server.stop();
});

/** A public-page context. Logged in as admin only so setup calls (creating test
 * features) can authenticate; the page itself is always loaded as a visitor would see it. */
async function newPublicPage(browser, viewport) {
    const context = await browser.newContext(viewport ? { viewport } : {});
    await installAssetMocks(context);
    await installMapCapture(context);
    await loginAsAdmin(context, server.baseURL, server.adminPassword);
    const page = await context.newPage();
    await gotoPublic(page, server.baseURL);
    await page.waitForTimeout(1200);
    return { context, page };
}

async function search(page, from, to) {
    await page.fill("#route-start-search", from);
    await page.fill("#route-end-search", to);
    await page.click("#route-end-btn");
    await page.waitForTimeout(700);
}

test.describe("public map", () => {
    test("routing distances match the seed data", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        await search(page, "Humanities", "Theater");
        expect(await page.locator("#route-distance-label").textContent()).toBe("Distance: 294 m");

        await page.click("#route-clear");
        await page.waitForTimeout(300);
        await search(page, "Learning Resource Center", "Theater");
        expect(await page.locator("#route-distance-label").textContent()).toBe("Distance: 125 m");

        await page.click("#route-clear");
        await page.waitForTimeout(300);
        await search(page, "Applied Technology", "Academy of the Redwoods Office");
        expect(await page.locator("#route-distance-label").textContent()).toBe("Distance: 66 m");

        await context.close();
    });

    test("changing From and searching again without Clear moves the start (desktop Search)", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        await search(page, "Humanities", "Theater");
        const firstStart = await page.locator("#route-start-label").textContent();
        expect(firstStart).toContain("HU");

        await page.fill("#route-start-search", "Learning Resource Center");
        await page.click("#route-end-btn");
        await page.waitForTimeout(700);

        const secondStart = await page.locator("#route-start-label").textContent();
        expect(secondStart).toContain("LRC");
        expect(secondStart).not.toBe(firstStart);
        expect(await page.locator("#route-distance-label").textContent()).toBe("Distance: 125 m");

        await context.close();
    });

    test("changing From and searching again without Clear moves the start (mobile Go)", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser, { width: 390, height: 844 });

        await page.fill("#mobile-from-input", "Humanities");
        await page.fill("#mobile-to-input", "Theater");
        await page.click("#mobile-go-btn");
        await page.waitForTimeout(700);
        const firstStart = await page.locator("#route-start-label").textContent();
        expect(firstStart).toContain("HU");

        await page.fill("#mobile-from-input", "Learning Resource Center");
        await page.click("#mobile-go-btn");
        await page.waitForTimeout(700);

        const secondStart = await page.locator("#route-start-label").textContent();
        expect(secondStart).toContain("LRC");
        expect(secondStart).not.toBe(firstStart);
        expect(await page.locator("#route-distance-label").textContent()).toBe("Distance: 125 m");

        await context.close();
    });

    test("a search after the page has loaded takes under 500ms", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        await page.fill("#route-start-search", "Humanities");
        await page.fill("#route-end-search", "Theater");
        await page.waitForTimeout(100);

        const start = Date.now();
        await page.click("#route-end-btn");
        await page.waitForFunction(() => {
            const el = document.querySelector("#route-distance-label");
            return el && /\d/.test(el.textContent);
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(500);
        await context.close();
    });

    test("Fit to campus changes the view", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        const before = await page.evaluate(() => ({
            center: window.__crMap.getCenter(),
            zoom: window.__crMap.getZoom()
        }));

        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);
        await page.locator('[data-action="fit-to-campus"]').click();
        await page.waitForTimeout(500);

        const after = await page.evaluate(() => ({
            center: window.__crMap.getCenter(),
            zoom: window.__crMap.getZoom()
        }));

        expect(after.zoom !== before.zoom || after.center.lat !== before.center.lat || after.center.lng !== before.center.lng).toBe(true);
        await context.close();
    });

    test("Download GeoJSON downloads features and walkways", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        const downloads = [];
        page.on("download", (d) => downloads.push(d));

        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);
        await page.locator('[data-action="download-data"]').click();
        await page.waitForTimeout(800);

        expect(downloads).toHaveLength(1);
        const p = await downloads[0].path();
        const fs = require("fs");
        const content = JSON.parse(fs.readFileSync(p, "utf8"));
        expect(content).toHaveProperty("features");
        expect(content).toHaveProperty("walkways");
        expect(content.features.length).toBe(99);
        expect(content.walkways.length).toBe(608);

        await context.close();
    });

    test("no Settings link, gear button or settings modal exists", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);

        expect(await page.locator("#drawer-settings-fab").count()).toBe(0);
        expect(await page.locator("#settings-modal-scrim").count()).toBe(0);
        expect(await page.getByText("Settings", { exact: true }).count()).toBe(0);

        await context.close();
    });

    test("the satellite layer shows the Esri credit, and the public page requests nothing from leaflet-draw", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);

        const drawRequests = [];
        page.on("request", (req) => {
            const url = req.url().toLowerCase();
            if (url.includes("leaflet-draw") || url.includes("leaflet.draw")) drawRequests.push(req.url());
        });

        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);
        await page.locator('.basemap-btn[data-base-layer="satellite"]').click();
        await page.waitForTimeout(500);

        const attribution = await page.locator(".leaflet-control-attribution").textContent();
        expect(attribution).toContain("Esri");

        expect(drawRequests).toEqual([]);
        await context.close();
    });

    test("a building and an entrance named with a script payload show as plain text, with no alert", async ({ browser }) => {
        const { context, page } = await newPublicPage(browser);
        const payload = "<img src=x onerror=alert(1)>";

        const buildingCoords = [
            [CX - 0.0002, CY - 0.0001],
            [CX + 0.0001, CY - 0.0001],
            [CX + 0.0001, CY + 0.0001],
            [CX - 0.0002, CY + 0.0001],
            [CX - 0.0002, CY - 0.0001]
        ];
        await context.request.post(`${server.baseURL}/api/features`, {
            data: { type: "Feature", geometry: { type: "Polygon", coordinates: [buildingCoords] }, properties: { type: "building", name: payload, prefix: "XX" } }
        });
        const entRes = await context.request.post(`${server.baseURL}/api/features`, {
            data: { type: "Feature", geometry: { type: "Point", coordinates: [CX + 0.0003, CY] }, properties: { type: "entrance", name: payload } }
        });
        const entrance = await entRes.json();

        let alertFired = false;
        page.on("dialog", async (d) => { alertFired = true; await d.dismiss(); });

        await gotoPublic(page, server.baseURL);
        await page.waitForTimeout(1200);

        // Building labels only render on the satellite/historic layer.
        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);
        await page.locator('.basemap-btn[data-base-layer="satellite"]').click();
        await page.waitForTimeout(500);
        await page.locator("#utility-close").click();
        await page.waitForTimeout(200);

        const ourLabel = page.locator(".building-label").filter({ hasText: "img" });
        await expect(ourLabel).toHaveCount(1);
        expect(await ourLabel.textContent()).toBe(payload);

        const entrancePixel = await pixelForLatLng(page, entrance.geometry.coordinates);
        await page.mouse.click(entrancePixel.x, entrancePixel.y);
        await page.waitForTimeout(400);
        const popupHtml = await page.locator(".leaflet-popup-content").innerHTML();
        expect(popupHtml).not.toContain("<img");
        expect(popupHtml).toContain("&lt;img");

        expect(alertFired).toBe(false);
        await context.close();
    });

    test("with /api/walkways failing, the \"Couldn't load campus data\" toast appears", async ({ browser }) => {
        const context = await browser.newContext();
        await installAssetMocks(context);
        await context.route("**/api/walkways", (route) =>
            route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
        );
        const page = await context.newPage();
        await page.goto(server.baseURL + "/");
        await page.waitForTimeout(1200);

        const toastText = await page.locator("#toasts .toast").textContent();
        expect(toastText).toContain("Couldn't load campus data");

        await context.close();
    });
});
