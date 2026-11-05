const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");
const { installAssetMocks } = require("./helpers/assets");
const { loginAsAdmin, gotoAdmin, trackRequests, settle } = require("./helpers/actions");
const { installMapCapture, pixelForLatLng, CAMPUS_CENTER, TOOLBAR } = require("./helpers/draw");

const PORT = 5304;
const [CX, CY] = CAMPUS_CENTER;
let server;

test.beforeAll(async () => {
    const dbConfig = await resetTestDatabase();
    server = await startServer({ port: PORT, dbConfig });
});

test.afterAll(async () => {
    if (server) await server.stop();
});

async function newAdminPage(browser) {
    const context = await browser.newContext();
    await installAssetMocks(context);
    await installMapCapture(context);
    await loginAsAdmin(context, server.baseURL, server.adminPassword);
    const page = await context.newPage();
    await gotoAdmin(page, server.baseURL);
    await page.waitForTimeout(1200);
    return { context, page };
}

function byId(features) {
    const map = new Map();
    for (const f of features) map.set(f.properties._id, f);
    return map;
}

// This test runs first, against the freshly-seeded, still-untouched database, so the
// download can be compared directly to the seed files on disk.
test.describe.serial("admin edits", () => {
    test("Download GeoJSON gives features.json and walkways.json matching data/*.json", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const downloads = [];
        page.on("download", (d) => downloads.push(d));

        await page.locator("#utility-toggle").click();
        await page.waitForTimeout(150);
        await page.locator('[data-action="download-data"]').click();
        await page.waitForTimeout(1000);

        expect(downloads).toHaveLength(2);
        const byName = {};
        for (const d of downloads) {
            const p = await d.path();
            byName[d.suggestedFilename()] = JSON.parse(fs.readFileSync(p, "utf8"));
        }
        expect(Object.keys(byName).sort()).toEqual(["features.json", "walkways.json"]);

        const diskFeatures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "features.json"), "utf8"));
        const diskWalkways = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "walkways.json"), "utf8"));

        const downloadedFeaturesById = byId(byName["features.json"].features);
        const diskFeaturesById = byId(diskFeatures.features);
        expect(downloadedFeaturesById.size).toBe(diskFeaturesById.size);
        for (const [id, f] of diskFeaturesById) {
            expect(downloadedFeaturesById.has(id)).toBe(true);
            expect(downloadedFeaturesById.get(id).geometry).toEqual(f.geometry);
        }

        const downloadedWalkwaysById = byId(byName["walkways.json"].features);
        const diskWalkwaysById = byId(diskWalkways.features);
        expect(downloadedWalkwaysById.size).toBe(diskWalkwaysById.size);
        for (const [id, w] of diskWalkwaysById) {
            expect(downloadedWalkwaysById.has(id)).toBe(true);
            expect(downloadedWalkwaysById.get(id).geometry).toEqual(w.geometry);
        }

        await context.close();
    });

    test("moving an entrance with the edit toolbar and saving sends 1 POST, and the new position survives a reload", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const start = [CX - 0.0001, CY];
        const entRes = await context.request.post(`${server.baseURL}/api/features`, {
            data: { type: "Feature", geometry: { type: "Point", coordinates: start }, properties: { type: "entrance", name: "Move Me" } }
        });
        const entrance = await entRes.json();

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const writes = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        const startPx = await pixelForLatLng(page, start);

        await page.locator(TOOLBAR.editVertices).click();
        await page.waitForTimeout(300);
        await page.mouse.move(startPx.x, startPx.y);
        await page.mouse.down();
        await page.mouse.move(startPx.x + 30, startPx.y + 10, { steps: 5 });
        await page.mouse.move(startPx.x + 60, startPx.y + 40, { steps: 5 });
        await page.mouse.up();
        await settle(page, 300);
        await page.locator(".leaflet-draw-actions").getByText("Save", { exact: true }).click();
        await settle(page, 600);

        expect(writes.list).toHaveLength(1);
        const saved = JSON.parse(writes.list[0].postData);
        expect(saved.properties._id).toBe(entrance.properties._id);
        expect(saved.geometry.coordinates).not.toEqual(start);

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);
        const afterReload = await (await context.request.get(`${server.baseURL}/api/features`)).json();
        const match = afterReload.features.find((f) => f.properties._id === entrance.properties._id);
        expect(match.geometry.coordinates).toEqual(saved.geometry.coordinates);

        await context.close();
    });

    test("moving a building vertex and saving sends 1 POST; the toolbar delete tool sends 1 DELETE", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const coords = [
            [CX - 0.0002, CY - 0.0001],
            [CX + 0.0001, CY - 0.0001],
            [CX + 0.0001, CY + 0.0001],
            [CX - 0.0002, CY + 0.0001],
            [CX - 0.0002, CY - 0.0001]
        ];
        const bRes = await context.request.post(`${server.baseURL}/api/features`, {
            data: { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: { type: "building", name: "Edit Me", prefix: "EM" } }
        });
        const building = await bRes.json();

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const posts = trackRequests(page, (r) => r.method() === "POST" && r.url().includes("/api/features"));
        const vertexPx = await pixelForLatLng(page, coords[0]);

        await page.locator(TOOLBAR.editVertices).click();
        await page.waitForTimeout(300);
        await page.mouse.move(vertexPx.x, vertexPx.y);
        await page.mouse.down();
        await page.mouse.move(vertexPx.x - 30, vertexPx.y - 20, { steps: 5 });
        await page.mouse.up();
        await settle(page, 300);
        await page.locator(".leaflet-draw-actions").getByText("Save", { exact: true }).click();
        await settle(page, 600);

        expect(posts.list).toHaveLength(1);
        expect(JSON.parse(posts.list[0].postData).properties._id).toBe(building.properties._id);

        const deletes = trackRequests(page, (r) => r.method() === "DELETE" && r.url().includes("/api/features/"));
        await page.locator(TOOLBAR.deleteTool).click();
        await page.waitForTimeout(300);
        const insidePx = await pixelForLatLng(page, [CX - 0.00005, CY]);
        await page.mouse.click(insidePx.x, insidePx.y);
        await page.waitForTimeout(300);
        await page.locator(".leaflet-draw-actions").getByText("Save", { exact: true }).click();
        await settle(page, 600);

        expect(deletes.list).toHaveLength(1);
        expect(deletes.list[0].url.endsWith("/" + building.properties._id)).toBe(true);

        await context.close();
    });

    test("with the session cookie cleared, saving in the building inspector shows a visible error, throws no page error and leaves the name unchanged", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const coords = [
            [CX - 0.0002, CY - 0.0001],
            [CX + 0.0001, CY - 0.0001],
            [CX + 0.0001, CY + 0.0001],
            [CX - 0.0002, CY + 0.0001],
            [CX - 0.0002, CY - 0.0001]
        ];
        const bRes = await context.request.post(`${server.baseURL}/api/features`, {
            data: { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: { type: "building", name: "Original Name", prefix: "ON" } }
        });
        const building = await bRes.json();

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        let dialogMessage = null;
        page.once("dialog", async (d) => { dialogMessage = d.message(); await d.accept(); });

        const insidePx = await pixelForLatLng(page, [CX - 0.00005, CY]);
        await page.mouse.click(insidePx.x, insidePx.y);
        await page.waitForTimeout(300);
        expect(await page.locator("#feature-inspector").isVisible()).toBe(true);

        await context.clearCookies();

        await page.fill("#inspect-name", "Hacked Name");
        await page.locator("#inspect-save").click();
        await settle(page, 600);

        expect(dialogMessage).toContain("Could not save building");
        expect(pageErrors).toEqual([]);

        const after = await (await context.request.get(`${server.baseURL}/api/features`)).json();
        const match = after.features.find((f) => f.properties._id === building.properties._id);
        expect(match.properties.name).toBe("Original Name");

        await context.close();
    });
});
