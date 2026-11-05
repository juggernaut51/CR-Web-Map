// Routes every external host the app's pages load (unpkg map libraries, tile servers,
// Google Fonts, the campus logo) to local files or blank responses, so tests need no
// internet access.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");

// 1x1 transparent PNG, used for anything that just needs to decode as an image.
const BLANK_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
);
const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

/**
 * Maps an unpkg URL path (e.g. "/leaflet@1.9.4/dist/leaflet.css" or
 * "/@turf/turf@6.5.0/turf.min.js") to the matching file under node_modules.
 * @param {string} pathname
 * @returns {string|null}
 */
function resolveUnpkgPath(pathname) {
    const clean = pathname.replace(/^\/+/, "");
    const m = clean.match(/^(@[^/]+\/[^@/]+|[^@/]+)@([^/]+)\/(.+)$/);
    if (!m) return null;
    const [, pkg, , rest] = m;
    return path.join(REPO_ROOT, "node_modules", pkg, rest);
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath);
    if (ext === ".css") return "text/css";
    if (ext === ".js") return "application/javascript";
    if (ext === ".map") return "application/json";
    return "application/octet-stream";
}

/**
 * Installs route handlers on a browser context so every external asset the app's
 * pages reference is served locally (map libraries from node_modules) or as an empty
 * stand-in (tiles, fonts, the campus logo).
 * @param {import('@playwright/test').BrowserContext} context
 */
async function installAssetMocks(context) {
    await context.route("https://unpkg.com/**", async (route) => {
        const url = new URL(route.request().url());
        const localPath = resolveUnpkgPath(url.pathname);
        if (localPath && fs.existsSync(localPath)) {
            return route.fulfill({
                status: 200,
                contentType: contentTypeFor(localPath),
                body: fs.readFileSync(localPath)
            });
        }
        return route.fulfill({ status: 404, body: "Not found" });
    });

    await context.route(/^https:\/\/[a-z0-9-]+\.tile\.openstreetmap\.org\//, (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG })
    );

    await context.route("https://server.arcgisonline.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG })
    );

    await context.route("https://www.redwoods.edu/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/svg+xml", body: BLANK_SVG })
    );

    await context.route("https://fonts.googleapis.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/css", body: "" })
    );

    await context.route("https://fonts.gstatic.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.alloc(0) })
    );
}

module.exports = { installAssetMocks };
