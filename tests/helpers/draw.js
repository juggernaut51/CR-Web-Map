// Helpers for driving the Leaflet.draw toolbar and map clicks in the admin editor.

// The map's initial view (client.js's initMap) is this point at zoom 20, which only
// shows roughly a 140m x 70m patch of campus — not the whole maxBounds extent. Any
// coordinate a test wants to click has to stay within a few dozen meters of this to
// still be on screen; [lng, lat] to match GeoJSON order.
const CAMPUS_CENTER = [-124.19603359276114, 40.69803104641056];

/**
 * Makes every page in this browser context stash its Leaflet map instance on
 * window.__crMap as soon as it's created, by patching L.Map.prototype.setView (which
 * CR.initMap calls immediately after construction). This lets tests convert a feature's
 * real lat/lng — which may differ slightly from where it was clicked, since the app
 * snaps new walkway points within 3m of existing nodes — into the exact pixel to click
 * to select it, instead of assuming the click coordinate is still where the geometry is.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function installMapCapture(context) {
    await context.addInitScript(() => {
        const poll = setInterval(() => {
            if (window.L && window.L.Map && window.L.Map.prototype.setView) {
                clearInterval(poll);
                const orig = window.L.Map.prototype.setView;
                window.L.Map.prototype.setView = function (...args) {
                    window.__crMap = this;
                    return orig.apply(this, args);
                };
            }
        }, 10);
    });
}

/**
 * Converts a [lng,lat] coordinate to page-relative pixel coordinates using the page's
 * captured Leaflet map (see installMapCapture). Requires the map to already be loaded.
 */
async function pixelForLatLng(page, [lng, lat]) {
    const box = await mapBoundingBox(page);
    const point = await page.evaluate(([la, ln]) => {
        const p = window.__crMap.latLngToContainerPoint([la, ln]);
        return { x: p.x, y: p.y };
    }, [lat, lng]);
    return { x: box.x + point.x, y: box.y + point.y };
}

/** Clicks the map at the pixel position of a real [lng,lat] coordinate. */
async function clickAtLatLng(page, coord) {
    const { x, y } = await pixelForLatLng(page, coord);
    await page.mouse.click(x, y);
    return { x, y };
}

/** Ctrl-clicks the map at the pixel position of a real [lng,lat] coordinate. */
async function ctrlClickAtLatLng(page, coord) {
    const { x, y } = await pixelForLatLng(page, coord);
    await page.keyboard.down("Control");
    await page.mouse.click(x, y);
    await page.keyboard.up("Control");
    return { x, y };
}

async function mapBoundingBox(page) {
    const box = await page.locator("#map").boundingBox();
    if (!box) throw new Error("#map has no bounding box — is the page loaded?");
    return box;
}

/**
 * Clicks the map at a fractional position within its bounding box (0..1, 0..1).
 */
async function clickMapAt(page, xPct, yPct) {
    const box = await mapBoundingBox(page);
    const x = box.x + box.width * xPct;
    const y = box.y + box.height * yPct;
    await page.mouse.click(x, y);
    return { x, y };
}

/** Places a point feature (marker tool or a shortcut key) with a single map click. */
async function placePoint(page, xPct = 0.5, yPct = 0.5) {
    return clickMapAt(page, xPct, yPct);
}

/**
 * Ctrl-clicks the map at a fractional position, for multi-selecting a walkway.
 * page.mouse.click() has no `modifiers` option (that's a Locator/page.click() thing),
 * so the Control key has to be held down around the raw mouse click instead.
 */
async function ctrlClickMapAt(page, xPct, yPct) {
    const box = await mapBoundingBox(page);
    const x = box.x + box.width * xPct;
    const y = box.y + box.height * yPct;
    await page.keyboard.down("Control");
    await page.mouse.click(x, y);
    await page.keyboard.up("Control");
    return { x, y };
}

// Leaflet.draw debounces new vertices for ~50ms after each click (_enableNewMarkers),
// so clicks faster than that are dropped.
const VERTEX_DELAY_MS = 150;

/**
 * Draws a polygon by clicking each point, then clicking the first point again to close
 * the loop. This works for both the draw-toolbar's own polygon handler and the separate
 * handler instances admin.js creates for the B/R/P keyboard shortcuts and the polygon
 * erase tool — those never get a toolbar "Finish" action, but Leaflet.draw always wires
 * a click-the-first-vertex-to-close handler once the first point is placed.
 * @param {import('@playwright/test').Page} page
 * @param {Array<[number,number]>} points fractional [xPct,yPct] pairs, at least 3.
 */
async function drawPolygon(page, points) {
    let first = null;
    for (let i = 0; i < points.length; i++) {
        const p = await clickMapAt(page, points[i][0], points[i][1]);
        if (i === 0) first = p;
        await page.waitForTimeout(VERTEX_DELAY_MS);
    }
    await page.mouse.click(first.x, first.y);
    await page.waitForTimeout(VERTEX_DELAY_MS);
}

/**
 * Draws a polyline by clicking each point, then clicking the last point again to finish
 * it — the same vertex-click handler admin.js's W shortcut and the toolbar polyline tool
 * both rely on (see drawPolygon's doc for why this beats the toolbar "Finish" action).
 * @param {import('@playwright/test').Page} page
 * @param {Array<[number,number]>} points fractional [xPct,yPct] pairs, at least 2.
 */
async function drawPolyline(page, points) {
    let last = null;
    for (let i = 0; i < points.length; i++) {
        last = await clickMapAt(page, points[i][0], points[i][1]);
        await page.waitForTimeout(VERTEX_DELAY_MS);
    }
    await page.mouse.click(last.x, last.y);
    await page.waitForTimeout(VERTEX_DELAY_MS);
}

/** Like drawPolygon, but points are real [lng,lat] coordinates instead of fractional ones. */
async function drawPolygonAtLatLngs(page, coords) {
    let first = null;
    for (let i = 0; i < coords.length; i++) {
        const p = await clickAtLatLng(page, coords[i]);
        if (i === 0) first = p;
        await page.waitForTimeout(VERTEX_DELAY_MS);
    }
    await page.mouse.click(first.x, first.y);
    await page.waitForTimeout(VERTEX_DELAY_MS);
}

async function pressKey(page, key) {
    await page.keyboard.press(key);
}

// The Leaflet.draw toolbar and its "actions" flyout sit in the map's top-left corner
// (roughly the top-left 300x180px). Clicks there land on that control, not the map —
// Leaflet's controls call L.DomEvent.disableClickPropagation, which swallows the click
// before it reaches the draw handler. Every test region below stays clear of it, and
// each gets its own cell so shapes from different tests never land within the 3m
// walkway-snap radius of each other.
function regionCenter(index) {
    const cols = 5;
    const col = index % cols;
    const row = Math.floor(index / cols);
    return [0.35 + col * 0.12, 0.3 + row * 0.12];
}

/** A small square of 4 points (fractional coords) around a center, for a building/room/parking draw. */
function squareAround([cx, cy], halfSize = 0.03) {
    return [
        [cx - halfSize, cy - halfSize],
        [cx + halfSize, cy - halfSize],
        [cx + halfSize, cy + halfSize],
        [cx - halfSize, cy + halfSize]
    ];
}

/** A short 2-point line (fractional coords) around a center, for a walkway draw. */
function lineAround([cx, cy], halfSize = 0.03) {
    return [
        [cx - halfSize, cy - halfSize],
        [cx + halfSize, cy + halfSize]
    ];
}

const TOOLBAR = {
    marker: ".leaflet-draw-draw-marker",
    polygon: ".leaflet-draw-draw-polygon",
    polyline: ".leaflet-draw-draw-polyline",
    editVertices: ".leaflet-draw-edit-edit",
    deleteTool: ".leaflet-draw-edit-remove"
};

module.exports = {
    CAMPUS_CENTER,
    installMapCapture,
    pixelForLatLng,
    clickAtLatLng,
    ctrlClickAtLatLng,
    mapBoundingBox,
    clickMapAt,
    ctrlClickMapAt,
    placePoint,
    drawPolygon,
    drawPolyline,
    drawPolygonAtLatLngs,
    pressKey,
    TOOLBAR,
    regionCenter,
    squareAround,
    lineAround
};
