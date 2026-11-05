import type pg from "pg";

/**
 * The sidecar's own tables, in its own database (WA_DATABASE_*, e.g. the
 * "whatsapp" database). Created on startup; nothing here belongs to any
 * client system.
 *
 *   wa_auth_state  Baileys login keys, one row per key per session.
 *                  id = md5("<session_id>:<key>") in UUID form.
 *
 * Treat it like a password store: anyone with these rows can act as the
 * linked WhatsApp numbers.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_auth_state (
    id          VARCHAR(36) PRIMARY KEY,
    session_id  VARCHAR(64)  NOT NULL,
    key         VARCHAR(255) NOT NULL,          -- "creds" or "<type>-<id>"
    value       TEXT,                           -- JSON (BufferJSON)
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS wa_auth_state_session_idx ON wa_auth_state (session_id);
`;

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}
