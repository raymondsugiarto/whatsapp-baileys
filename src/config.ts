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
   * Postgres connection string of the sidecar's OWN database (e.g. the
   * "whatsapp" database; never a client system's). When unset, the
   * standard PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables
   * are used instead (how docker-compose.yml wires it).
   */
  databaseUrl: string | undefined;
  /** Postgres schema for the sidecar's tables (default public). */
  databaseSchema: string;
  logLevel: string;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.WA_DATABASE_URL?.trim() || undefined;
  if (!databaseUrl && !process.env.PGHOST?.trim()) {
    throw new Error("WA_DATABASE_URL (or PGHOST and friends) is required");
  }
  return {
    port: Number(process.env.WA_PORT ?? 4020),
    host: process.env.WA_HOST ?? "0.0.0.0",
    secret: required("WA_SIDECAR_SECRET"),
    apiBaseUrl: required("WA_API_BASE_URL").replace(/\/+$/, ""),
    databaseUrl,
    databaseSchema: process.env.WA_DATABASE_SCHEMA?.trim() || "public",
    logLevel: process.env.WA_LOG_LEVEL ?? "info",
  };
}
