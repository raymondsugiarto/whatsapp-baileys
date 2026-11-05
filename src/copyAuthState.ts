/**
 * One-time move of WhatsApp logins from the old shared database (the
 * receivable database's wa_auth_state, column organization_id) into the
 * sidecar's own database, so linked numbers keep working without a new QR.
 *
 *   WA_COPY_FROM_URL=postgres://user:pass@host:5432/finance \
 *   WA_COPY_FROM_SCHEMA=receivable \
 *   pnpm copy-auth
 *
 * Reads the target from the WA_DATABASE_* variables like the
 * sidecar. Safe to run again (upsert); the source rows are left as they are.
 * Stop the old sidecar first so it does not keep writing to the old copy.
 */
import pg from "pg";
import { loadConfig } from "./config.js";
import { ensureSchema } from "./schema.js";

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function main() {
  const cfg = loadConfig();
  const fromUrl = process.env.WA_COPY_FROM_URL?.trim();
  const fromSchema = process.env.WA_COPY_FROM_SCHEMA?.trim() || "public";
  if (!fromUrl) throw new Error("WA_COPY_FROM_URL is required");
  if (!ident.test(fromSchema) || !ident.test(cfg.databaseSchema)) throw new Error("schema name is invalid");

  const from = new pg.Client({ connectionString: fromUrl, options: `-c search_path=${fromSchema}` });
  const to = new pg.Pool({ ...cfg.database, options: `-c search_path=${cfg.databaseSchema}` });
  await from.connect();
  try {
    await ensureSchema(to);
    const rows = await from.query<{
      id: string;
      organization_id: string;
      key: string;
      value: string;
      created_at: Date | null;
      updated_at: Date | null;
    }>("SELECT id, organization_id, key, value, created_at, updated_at FROM wa_auth_state");
    const client = await to.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows.rows) {
        await client.query(
          `INSERT INTO wa_auth_state (id, session_id, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, key = EXCLUDED.key,
             value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [r.id, r.organization_id, r.key, r.value, r.created_at, r.updated_at],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const sessions = new Set(rows.rows.filter((r) => r.key === "creds").map((r) => r.organization_id));
    console.log(`copied ${rows.rowCount} keys; sessions with a login: ${[...sessions].join(", ") || "none"}`);
  } finally {
    await from.end();
    await to.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
