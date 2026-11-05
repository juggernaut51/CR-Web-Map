const { test, expect } = require("@playwright/test");
const path = require("path");
const { spawn } = require("child_process");
const { resetTestDatabase } = require("./helpers/db");
const { startServer } = require("./helpers/server");

const PORT = 5301;
const REPO_ROOT = path.join(__dirname, "..");

let server;

test.beforeAll(async () => {
    const dbConfig = await resetTestDatabase();
    server = await startServer({ port: PORT, dbConfig });
});

test.afterAll(async () => {
    if (server) await server.stop();
});

/**
 * Extracts the ?v=... value from every local (/static/...) asset URL in an HTML page.
 * @param {string} html
 * @returns {Set<string>}
 */
function localAssetVersions(html) {
    const versions = new Set();
    const re = /(?:href|src)="\/static\/[^"]*\?v=([^"&]+)"/g;
    let m;
    while ((m = re.exec(html))) versions.add(m[1]);
    return versions;
}

test.describe("server auth and assets", () => {
    test("logged-out GET /admin redirects to /", async ({ request }) => {
        const res = await request.get(`${server.baseURL}/admin`, { maxRedirects: 0 });
        expect(res.status()).toBe(302);
        expect(res.headers()["location"]).toBe("/");
    });

    test("logged-out GET /api/bugs returns 401 JSON", async ({ request }) => {
        const res = await request.get(`${server.baseURL}/api/bugs`);
        expect(res.status()).toBe(401);
        expect(res.headers()["content-type"]).toContain("application/json");
        const body = await res.json();
        expect(body).toHaveProperty("error");
    });

    test("every local asset URL on /, /admin and the 404 page carries the same ?v= value", async ({ request }) => {
        const home = await request.get(`${server.baseURL}/`);
        expect(home.status()).toBe(200);
        const homeVersions = localAssetVersions(await home.text());
        expect(homeVersions.size).toBe(1);

        const notFound = await request.get(`${server.baseURL}/this-route-does-not-exist`);
        expect(notFound.status()).toBe(404);
        const notFoundVersions = localAssetVersions(await notFound.text());
        expect(notFoundVersions.size).toBe(1);

        const login = await request.post(`${server.baseURL}/login`, {
            form: { password: server.adminPassword },
            maxRedirects: 0
        });
        expect(login.status()).toBe(302);

        const admin = await request.get(`${server.baseURL}/admin`);
        expect(admin.status()).toBe(200);
        const adminVersions = localAssetVersions(await admin.text());
        expect(adminVersions.size).toBe(1);

        const allVersions = new Set([...homeVersions, ...notFoundVersions, ...adminVersions]);
        expect(allVersions.size).toBe(1);
    });
});

test.describe("required secrets", () => {
    /**
     * Spawns the server with one required env var blanked out and asserts it exits
     * with code 1 without ever answering HTTP requests.
     * @param {string} missingVar
     */
    function expectExitCode1ForMissing(missingVar) {
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                PORT: "0",
                ADMIN_PASSWORD: "placeholder",
                SESSION_SECRET: "placeholder-session-secret",
                [missingVar]: ""
            };
            const child = spawn("node", ["server.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
            let output = "";
            child.stdout.on("data", (d) => { output += d.toString(); });
            child.stderr.on("data", (d) => { output += d.toString(); });

            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`Server did not exit after missing ${missingVar}. Output:\n${output}`));
            }, 5000);

            child.on("exit", (code) => {
                clearTimeout(timer);
                try {
                    expect(code).toBe(1);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    test("exits with code 1 when ADMIN_PASSWORD is empty", async () => {
        await expectExitCode1ForMissing("ADMIN_PASSWORD");
    });

    test("exits with code 1 when SESSION_SECRET is empty", async () => {
        await expectExitCode1ForMissing("SESSION_SECRET");
    });
});
