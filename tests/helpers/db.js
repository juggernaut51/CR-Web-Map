// Test-only Postgres helpers. Reads TEST_POSTGRES_* variables exclusively — never the
// app's own POSTGRES_* variables — and refuses to touch anything but a local database.
const { Pool } = require("pg");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TEST_DB_NAME = "crmap_test";

function getTestDbConfig() {
    const host = process.env.TEST_POSTGRES_HOST || "localhost";
    if (!LOCAL_HOSTS.has(host)) {
        throw new Error(
            `Refusing to run tests against non-local TEST_POSTGRES_HOST="${host}". ` +
            `Tests only run against localhost, 127.0.0.1 or ::1.`
        );
    }
    return {
        host,
        port: Number(process.env.TEST_POSTGRES_PORT || 5432),
        user: process.env.TEST_POSTGRES_USER,
        password: process.env.TEST_POSTGRES_PASS
    };
}

/**
 * Drops and recreates the crmap_test database, leaving it empty.
 * @returns {Promise<{host:string, port:number, user:string, password:string}>}
 */
async function resetTestDatabase() {
    const cfg = getTestDbConfig();
    const admin = new Pool({ ...cfg, database: "postgres" });
    try {
        await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [TEST_DB_NAME]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
        await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    } finally {
        await admin.end();
    }
    return cfg;
}

module.exports = { resetTestDatabase, getTestDbConfig, TEST_DB_NAME };
