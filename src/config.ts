/** Settings from the environment (see .env.example). */
export interface Config {
  port: number;
  host: string;
  /** HMAC secret shared with the client system (receivable-api:
   * WHATSAPP_SIDECAR_SECRET). Signs calls both ways. */
  secret: string;
  /** Client system's base URL; incoming messages and link status are
   * POSTed to <apiBaseUrl>/api/v1/internal/whatsapp/{inbound,status}. */
  apiBaseUrl: string;
  /**
   * Connection to the sidecar's OWN database (e.g. the "whatsapp"
   * database; never a client system's), passed to pg.Pool. Built from
   * WA_DATABASE_HOST / _PORT / _USERNAME / _PASSWORD / _DBNAME, or from
   * WA_DATABASE_URL when that is set instead.
   */
  database: DatabaseConfig;
  /** Postgres schema for the sidecar's tables (default public). */
  databaseSchema: string;
  logLevel: string;
}

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function loadDatabase(): DatabaseConfig {
  const url = env("WA_DATABASE_URL");
  if (url) return { connectionString: url };
  const host = env("WA_DATABASE_HOST");
  if (!host) throw new Error("WA_DATABASE_HOST (or WA_DATABASE_URL) is required");
  return {
    host,
    port: Number(env("WA_DATABASE_PORT") ?? 5432),
    user: required("WA_DATABASE_USERNAME"),
    password: env("WA_DATABASE_PASSWORD"),
    database: env("WA_DATABASE_DBNAME") ?? "whatsapp",
  };
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.WA_PORT ?? 4020),
    host: process.env.WA_HOST ?? "0.0.0.0",
    secret: required("WA_SIDECAR_SECRET"),
    apiBaseUrl: required("WA_API_BASE_URL").replace(/\/+$/, ""),
    database: loadDatabase(),
    databaseSchema: process.env.WA_DATABASE_SCHEMA?.trim() || "public",
    logLevel: process.env.WA_LOG_LEVEL ?? "info",
  };
}
