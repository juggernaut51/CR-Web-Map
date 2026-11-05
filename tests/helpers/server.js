// Spawns/stops the app server for a test file, against the freshly-reset crmap_test database.
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const REPO_ROOT = path.join(__dirname, "..", "..");

function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const req = http.get(url, (res) => {
                res.resume();
                resolve();
            });
            req.on("error", () => {
                if (Date.now() > deadline) reject(new Error(`Server at ${url} did not start in time`));
                else setTimeout(tryOnce, 150);
            });
        };
        tryOnce();
    });
}

/**
 * Starts `node server.js` against the given test database config, on `port`.
 * @param {{port:number, dbConfig:object, adminPassword?:string, sessionSecret?:string, extraEnv?:object}} opts
 */
async function startServer({
    port,
    dbConfig,
    adminPassword = "test-admin-password",
    sessionSecret = "test-session-secret-long-enough",
    extraEnv = {}
}) {
    const env = {
        ...process.env,
        PORT: String(port),
        POSTGRES_HOST: dbConfig.host,
        POSTGRES_PORT: String(dbConfig.port),
        POSTGRES_USER: dbConfig.user,
        POSTGRES_PASS: dbConfig.password,
        POSTGRES_DB: "crmap_test",
        POSTGRES_SSL: "false",
        SEED_FROM_JSON: "true",
        COOKIE_SECURE: "false",
        ADMIN_PASSWORD: adminPassword,
        SESSION_SECRET: sessionSecret,
        // Never let a webhook URL from the host shell leak in and notify a real
        // Discord channel about test bug reports.
        DISCORD_WEBHOOK_URL: "",
        ...extraEnv
    };

    const child = spawn("node", ["server.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let exited = null;
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("exit", (code) => { exited = code; });

    const baseURL = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(baseURL + "/", 15000);
    } catch (err) {
        child.kill();
        throw new Error(`Server failed to start (exit code ${exited}). Output:\n${output}`);
    }

    return {
        baseURL,
        adminPassword,
        getExitCode: () => exited,
        getOutput: () => output,
        stop: () =>
            new Promise((resolve) => {
                if (exited !== null) return resolve(exited);
                child.once("exit", (code) => resolve(code));
                child.kill();
            })
    };
}

module.exports = { startServer };
