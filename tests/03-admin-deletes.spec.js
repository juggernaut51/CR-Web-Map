const { test, expect } = require("@playwright/test");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");
const { installAssetMocks } = require("./helpers/assets");
const { loginAsAdmin, gotoAdmin, trackRequests, queueDialogs, settle } = require("./helpers/actions");
const {
    CAMPUS_CENTER,
    installMapCapture,
    drawPolygonAtLatLngs,
    ctrlClickAtLatLng
} = require("./helpers/draw");

const [CX, CY] = CAMPUS_CENTER;

const PORT = 5303;
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

async function openDrawerAction(page, action) {
    await page.locator("#utility-toggle").click();
    await page.waitForTimeout(150);
    await page.locator(`[data-action="${action}"]`).click();
    await page.waitForTimeout(200);
}

function midpoint(coords) {
    const a = coords[0];
    const b = coords[coords.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Creates a walkway via the API directly (no UI draw, so no name prompt and no
 * magnetize-to-nearby-nodes snapping) at exact coordinates.
 */
async function postWalkway(context, name, coords) {
    const res = await context.request.post(`${server.baseURL}/api/walkways`, {
        data: {
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: { type: "walkway", name, curved: false, control: coords }
        }
    });
    if (!res.ok()) throw new Error(`Failed to create walkway ${name}: ${res.status()}`);
    return res.json();
}

test.describe("admin deletes", () => {
    test("Ctrl-click selecting 2 walkways and Delete: confirm says 2, dismiss sends nothing, accept deletes both and drops them from the export", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const messages = [];
        queueDialogs(page, [
            async (d) => { messages.push(d.message()); await d.dismiss(); },
            async (d) => { messages.push(d.message()); await d.accept(); }
        ]);

        const walkwayA = await postWalkway(context, "Sel A", [[CX - 0.0006, CY], [CX - 0.0002, CY]]);
        const walkwayB = await postWalkway(context, "Sel B", [[CX + 0.0002, CY], [CX + 0.0006, CY]]);
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        await ctrlClickAtLatLng(page, midpoint(walkwayA.geometry.coordinates));
        await settle(page, 200);
        await ctrlClickAtLatLng(page, midpoint(walkwayB.geometry.coordinates));
        await settle(page, 200);

        const deletes = trackRequests(page, (r) => r.method() === "DELETE" && r.url().includes("/api/walkways"));

        await page.keyboard.press("Delete");
        await settle(page, 400);
        expect(messages[0]).toContain("2");
        expect(deletes.list).toHaveLength(0);

        await page.keyboard.press("Delete");
        await settle(page, 600);
        expect(deletes.list).toHaveLength(2);

        const walkways = await (await context.request.get(`${server.baseURL}/api/walkways`)).json();
        expect(walkways.features.some((f) => f.properties._id === walkwayA.properties._id)).toBe(false);
        expect(walkways.features.some((f) => f.properties._id === walkwayB.properties._id)).toBe(false);

        await context.close();
    });

    test("a polygon erase sends as many DELETEs as its confirm says, and none of those walkways stay on the map", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const messages = [];
        queueDialogs(page, [async (d) => { messages.push(d.message()); await d.accept(); }]);

        const wa = await postWalkway(context, "Erase A", [[CX - 0.0002, CY + 0.00005], [CX + 0.0001, CY + 0.00005]]);
        const wb = await postWalkway(context, "Erase B", [[CX - 0.0002, CY + 0.0001], [CX + 0.0001, CY + 0.0001]]);
        const wc = await postWalkway(context, "Erase C", [[CX - 0.0002, CY + 0.00015], [CX + 0.0001, CY + 0.00015]]);
        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const allCoords = [wa, wb, wc].flatMap((w) => w.geometry.coordinates);
        const lons = allCoords.map((c) => c[0]);
        const lats = allCoords.map((c) => c[1]);
        const margin = 0.00005;
        const enclosing = [
            [Math.min(...lons) - margin, Math.min(...lats) - margin],
            [Math.max(...lons) + margin, Math.min(...lats) - margin],
            [Math.max(...lons) + margin, Math.max(...lats) + margin],
            [Math.min(...lons) - margin, Math.max(...lats) + margin]
        ];

        const before = await (await context.request.get(`${server.baseURL}/api/walkways`)).json();
        const deletes = trackRequests(page, (r) => r.method() === "DELETE" && r.url().includes("/api/walkways"));

        await openDrawerAction(page, "polygon-delete");
        await drawPolygonAtLatLngs(page, enclosing);
        await settle(page, 800);

        const match = /Delete (\d+) walkway segments/.exec(messages[0] || "");
        expect(match).not.toBeNull();
        const expectedCount = Number(match[1]);
        expect(expectedCount).toBeGreaterThanOrEqual(3);
        expect(deletes.list).toHaveLength(expectedCount);

        const after = await (await context.request.get(`${server.baseURL}/api/walkways`)).json();
        for (const w of [wa, wb, wc]) {
            expect(after.features.some((f) => f.properties._id === w.properties._id)).toBe(false);
        }
        expect(after.features.length).toBe(before.features.length - expectedCount);

        await context.close();
    });

    test("remove stray building points: lists the stray, cancel sends nothing, confirm deletes it, a second run finds none", async ({ browser }) => {
        const { context, page } = await newAdminPage(browser);

        const strayRes = await context.request.post(`${server.baseURL}/api/features`, {
            data: {
                type: "Feature",
                geometry: { type: "Point", coordinates: [-124.1972, 40.6972] },
                properties: { type: "building", name: "Stray Hall" }
            }
        });
        expect(strayRes.ok()).toBeTruthy();
        const stray = await strayRes.json();
        const strayId = stray.properties._id;

        await gotoAdmin(page, server.baseURL);
        await page.waitForTimeout(1200);

        const deletes = trackRequests(page, (r) => r.method() === "DELETE" && r.url().includes("/api/features/"));

        let msg1 = null;
        page.once("dialog", async (d) => { msg1 = d.message(); await d.dismiss(); });
        await openDrawerAction(page, "remove-stray-points");
        await settle(page, 400);
        expect(msg1).toContain("1 stray building point");
        expect(msg1).toContain("Stray Hall");
        expect(deletes.list).toHaveLength(0);

        page.once("dialog", (d) => d.accept());
        await openDrawerAction(page, "remove-stray-points");
        await settle(page, 600);
        expect(deletes.list).toHaveLength(1);
        expect(deletes.list[0].url.endsWith("/" + strayId)).toBe(true);

        const featuresAfter = await (await context.request.get(`${server.baseURL}/api/features`)).json();
        expect(featuresAfter.features.some((f) => f.properties._id === strayId)).toBe(false);

        let msg2 = null;
        page.once("dialog", async (d) => { msg2 = d.message(); await d.accept(); });
        await openDrawerAction(page, "remove-stray-points");
        await settle(page, 400);
        expect(msg2).toBe("No stray points found.");

        await context.close();
    });
});
