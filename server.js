const express = require("express");
const path = require("path");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const { pool } = require("./db");
const flash = require("connect-flash");
const compression = require("compression");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const { readAllFeatures, upsertFeature, deleteFeatureById } = require("./store");
const { readAllWalkways, upsertWalkway, deleteWalkwayById } = require("./walkwayStore");
const { createBugReportsTable, insertBugReport, getAllBugReports, deleteBugReport } = require("./bugStore");


dotenv.config();

/**
 * Initializes and configures the Express application.
 * @returns {import('express').Express} Configured Express app instance.
 */
function createApp() {
    const app = express();

    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));
    app.set("trust proxy", 1);
    app.disable("etag"); // force fresh responses

    app.use(
        helmet({
            referrerPolicy: {
                policy: "strict-origin-when-cross-origin",
            },

            contentSecurityPolicy: {
                useDefaults: true,
                directives: {
                    "default-src": ["'self'"],
                    "img-src": [
                        "'self'",
                        "data:",
                        "https://www.redwoods.edu",
                        "https://*.tile.openstreetmap.org",
                        "https://unpkg.com",
                        "https://server.arcgisonline.com"
                    ],
                    "script-src": [
                        "'self'",
                        "https://unpkg.com",
                        "'unsafe-eval'"
                    ],
                    "style-src": [
                    "'self'",
                    "'unsafe-inline'",
                    "https://unpkg.com",
                    "https://fonts.googleapis.com"
                    ],
                    "font-src": [
                        "'self'",
                        "https://fonts.gstatic.com"
                    ],
                    // Allow connections to unpkg.com for loading source maps and resources
                    "connect-src": ["'self'", "https://unpkg.com"], 
                    "frame-src": ["'self'"]
                }
            }
        })
    );
    app.use(compression());
    app.use(morgan("combined"));
    app.use(express.json({ limit: "2mb" }));
    app.use(express.urlencoded({ extended: true }));
    app.use(
        session({
            secret: process.env.SESSION_SECRET || "dev-secret",
            resave: false,
            saveUninitialized: false,
            store: new PgStore({
                pool,
                tableName: "session",
                createTableIfMissing: true
            }),
            cookie: {
                sameSite: "lax",
                maxAge: Number(process.env.SESSION_COOKIE_MS || 1000 * 60 * 60 * 24 * 7), // default 7 days
                httpOnly: true,
                secure: true
            }
        })
    );
    app.use(flash());

    app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many login attempts. Please try again in 15 minutes." }
    });

    const bugLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many bug reports submitted. Please wait before trying again." }
    });

    app.get("/", handleHome);
    app.get("/admin", requireAuth, handleAdmin);
    app.post("/login", loginLimiter, handleLogin);
    app.post("/logout", handleLogout);

    app.get("/api/features", apiGetFeatures);
    app.post("/api/features", requireAuth, apiCreateOrUpdateFeature);
    app.delete("/api/features/:id", requireAuth, apiDeleteFeature);

    app.get("/api/walkways", async (_req, res) => {
        const features = await readAllWalkways();
        res.json({ type: "FeatureCollection", features });
    });
    app.post("/api/walkways", requireAuth, async (req, res) => {
        const saved = await upsertWalkway(req.body);
        res.json(saved);
    });
    app.delete("/api/walkways/:id", requireAuth, async (req, res) => {
        await deleteWalkwayById(req.params.id);
        res.json({ ok: true });
    });

    app.post("/api/bugs", bugLimiter, async (req, res) => {
        try {
            const { description, zoom, lat, lng } = req.body;
            if (!description || typeof description !== "string" || description.trim().length === 0 || description.length > 1000) {
                return res.status(400).json({ error: "Description must be between 1 and 1000 characters." });
            }
            const report = await insertBugReport({ description: description.trim(), zoom, lat, lng });
            await notifyDiscord(report);
            res.json({ ok: true });
        } catch (err) {
            console.error("Bug report error:", err);
            res.status(500).json({ error: "Failed to save bug report" });
        }
    });

    app.get("/api/bugs", requireAuth, async (_req, res) => {
        const reports = await getAllBugReports();
        res.json(reports);
    });

    app.delete("/api/bugs/:id", requireAuth, async (req, res) => {
        await deleteBugReport(req.params.id);
        res.json({ ok: true });
    });

    app.use(handleNotFound);
    app.use(handleError);

    return app;
}

/**
 * Renders the public map view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleHome(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const messages = { success: req.flash("success"), error: req.flash("error") };
    res.render("map", { isAdmin: !!req.session.isAdmin, messages });
}

/**
 * Renders the admin editor view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleAdmin(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const messages = { success: req.flash("success"), error: req.flash("error") };
    res.render("admin", { isAdmin: !!req.session.isAdmin, messages });
}

/**
 * Authenticates a user using a shared admin password.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleLogin(req, res) {
    const { password } = req.body;
    if ((process.env.ADMIN_PASSWORD || "admin") === password) {
        req.session.regenerate((err) => {
            if (err) {
                console.error("Session regenerate failed", err);
                req.flash("error", "Login failed. Please try again.");
                return res.redirect("/");
            }
            req.session.isAdmin = true;
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error("Session save failed", saveErr);
                    req.flash("error", "Login failed. Please try again.");
                    return res.redirect("/");
                }
                req.flash("success", "Logged in.");
                res.redirect("/admin");
            });
        });
    } else {
        req.flash("error", "Invalid password.");
        res.redirect("/");
    }
}

/**
 * Logs out the current session.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleLogout(req, res) {
    req.session.isAdmin = false;
    req.flash("success", "Logged out.");
    res.redirect("/");
}

/**
 * Express middleware that ensures the user is authenticated.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
    if (req.session?.isAdmin) return next();
    return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Returns all stored GeoJSON features.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function apiGetFeatures(_req, res) {
    const features = await readAllFeatures();
    res.json({ type: "FeatureCollection", features });
}

/**
 * Creates or updates a GeoJSON feature.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function apiCreateOrUpdateFeature(req, res) {
    const feature = req.body;
    const saved = await upsertFeature(feature);
    res.json(saved);
}

/**
 * Deletes a feature by id.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function apiDeleteFeature(req, res) {
    await deleteFeatureById(req.params.id);
    res.json({ ok: true });
}

/**
 * Handles 404 responses.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */

async function notifyDiscord(report) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;
    const body = {
        embeds: [{
            title: "🐛 New Bug Report",
            color: 0x8e001c,
            fields: [
                { name: "Description", value: report.description || "No description" },
                { name: "Location", value: `Lat: ${report.lat}, Lng: ${report.lng}`, inline: true },
                { name: "Zoom", value: String(report.zoom), inline: true },
                { name: "Time", value: new Date(report.reported_at).toLocaleString() }
            ]
        }]
    };
    try {
        await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
    } catch (err) {
        console.error("Discord webhook error:", err);
    }
}
function handleNotFound(_req, res) {
    res.status(404).render("404", { isAdmin: false, messages: {} });
}

/**
 * Global error handler.
 * @param {Error} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function handleError(err, _req, res, _next) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
}

const port = process.env.PORT || 5000;
createBugReportsTable()
    .then(() => createApp().listen(port, () => {
        console.log(`CR WebApp listening on http://localhost:${port}`);
    }))
    .catch(err => {
        console.error("Failed to initialize database:", err);
        process.exit(1);
    });
