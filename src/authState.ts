import { createHash } from "node:crypto";
import type pg from "pg";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

/** wa_auth_state.id: md5("<session>:<key>") in UUID form (src/schema.ts). */
export function rowId(sessionId: string, key: string): string {
  const h = createHash("md5").update(`${sessionId}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UPSERT = `INSERT INTO wa_auth_state (id, session_id, key, value, created_at, updated_at)
  VALUES ($1, $2, $3, $4, now(), now())
  ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

/**
 * Baileys login state kept in Postgres, one row per key per session
 * (Baileys' own useMultiFileAuthState is meant for demos only).
 */
export async function usePgAuthState(
  pool: pg.Pool,
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const write = (key: string, value: unknown, db: pg.Pool | pg.PoolClient = pool) =>
    db.query(UPSERT, [rowId(sessionId, key), sessionId, key, JSON.stringify(value, BufferJSON.replacer)]);

  const credsRow = await pool.query<{ value: string }>(
    "SELECT value FROM wa_auth_state WHERE id = $1",
    [rowId(sessionId, "creds")],
  );
  const creds: AuthenticationCreds = credsRow.rows[0]
    ? JSON.parse(credsRow.rows[0].value, BufferJSON.reviver)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (ids.length === 0) return out;
        const res = await pool.query<{ key: string; value: string }>(
          "SELECT key, value FROM wa_auth_state WHERE id = ANY($1)",
          [ids.map((id) => rowId(sessionId, `${type}-${id}`))],
        );
        const prefix = `${type}-`;
        for (const row of res.rows) {
          let value = JSON.parse(row.value, BufferJSON.reviver);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[row.key.slice(prefix.length)] = value;
        }
        return out;
      },
      async set(data: SignalDataSet) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`;
              if (value) await write(key, value, client);
              else await client.query("DELETE FROM wa_auth_state WHERE id = $1", [rowId(sessionId, key)]);
            }
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await write("creds", state.creds);
    },
  };
}

/** Forgets a session's login (after logout). */
export async function clearAuthState(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query("DELETE FROM wa_auth_state WHERE session_id = $1", [sessionId]);
}

/**
 * Sessions with a saved login, for restore on boot. Logout (from the
 * client or from the phone) deletes the login, so every session still
 * holding one was linked when the sidecar stopped.
 */
export async function sessionsToRestore(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ session_id: string }>(
    "SELECT DISTINCT session_id FROM wa_auth_state WHERE key = 'creds' ORDER BY session_id",
  );
  return res.rows.map((r) => r.session_id);
}
