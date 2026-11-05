import pg from "pg";
import pino from "pino";
import { GoApi } from "./api.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./http.js";
import { ensureSchema } from "./schema.js";
import { SessionManager } from "./sessions.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, base: { service: "receivable-wa" } });

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.databaseSchema)) throw new Error("WA_DATABASE_SCHEMA is invalid");
const pool = new pg.Pool({
  ...cfg.database,
  max: 10,
  // The sidecar's own database (src/schema.ts); public unless set.
  options: `-c search_path=${cfg.databaseSchema}`,
});
const api = new GoApi(cfg.apiBaseUrl, cfg.secret, log);
const sessions = new SessionManager(pool, api, log);
const app = buildServer(sessions, cfg.secret, log);

async function main() {
  await ensureSchema(pool);
  await app.listen({ port: cfg.port, host: cfg.host });
  // Reconnect linked organizations in the background so the port is up
  // for the API right away.
  sessions.restoreAll().catch((err) => log.error({ err }, "restore_sessions_failed"));
}

async function shutdown(signal: string) {
  log.info({ signal }, "shutting_down");
  sessions.stopAll();
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  log.fatal({ err }, "startup_failed");
  process.exit(1);
});
