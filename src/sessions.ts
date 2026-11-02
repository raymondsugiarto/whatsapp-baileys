import type { Boom } from "@hapi/boom";
import type pg from "pg";
import type { Logger } from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from "baileys";
import type { GoApi, LinkStatus } from "./api.js";
import { clearAuthState, sessionsToRestore, usePgAuthState } from "./authState.js";
import { jidUser, toInbound, toJid, type IncomingMessage } from "./message.js";

/** What GET /sessions/:orgId returns. */
export interface SessionState {
  status: LinkStatus;
  /** data: URL (PNG) while status is "qr". */
  qr: string;
  phone: string;
}

interface Session {
  organizationId: string;
  sock?: WASocket;
  status: LinkStatus;
  qr: string;
  phone: string;
  /** Set by logout/stop so the close handler does not reconnect. */
  stopped: boolean;
  retries: number;
}

export class NotConnectedError extends Error {
  constructor(organizationId: string) {
    super(`WhatsApp is not connected for organization ${organizationId}`);
  }
}

/** Close codes after which reconnecting would not help. */
const FINAL_CODES = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.connectionReplaced,
  DisconnectReason.forbidden,
  DisconnectReason.multideviceMismatch,
]);

/** One Baileys socket per organization. */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private version?: [number, number, number];

  constructor(
    private pool: pg.Pool,
    private api: GoApi,
    private log: Logger,
  ) {}

  state(organizationId: string): SessionState {
    const s = this.sessions.get(organizationId);
    if (!s) return { status: "disconnected", qr: "", phone: "" };
    return { status: s.status, qr: s.status === "qr" ? s.qr : "", phone: s.phone };
  }

  /** Starts (or keeps) the organization's socket. A new login shows a QR. */
  async start(organizationId: string): Promise<SessionState> {
    const s = this.sessions.get(organizationId);
    if (s && !s.stopped && s.sock && s.status !== "logged_out" && s.status !== "disconnected") {
      return this.state(organizationId);
    }
    const session: Session = s ?? {
      organizationId,
      status: "connecting",
      qr: "",
      phone: "",
      stopped: false,
      retries: 0,
    };
    session.stopped = false;
    session.retries = 0;
    this.sessions.set(organizationId, session);
    await this.connect(session);
    // Give WhatsApp a moment to hand out the first QR so the console can
    // show it right away.
    await this.waitFor(session, (x) => x.status !== "connecting", 5000);
    return this.state(organizationId);
  }

  /** Unlinks the device and forgets the login. */
  async logout(organizationId: string): Promise<void> {
    const s = this.sessions.get(organizationId);
    if (s) {
      s.stopped = true;
      try {
        if (s.status === "connected") await s.sock?.logout();
        else s.sock?.end(undefined);
      } catch (err) {
        this.log.warn({ err, org: organizationId }, "logout_failed");
      }
      this.sessions.delete(organizationId);
    }
    await clearAuthState(this.pool, organizationId);
    await this.api.status(organizationId, "logged_out", "");
  }

  async send(organizationId: string, to: string, text: string): Promise<string> {
    const sock = this.connected(organizationId);
    const sent = await sock.sendMessage(toJid(to), { text });
    return sent?.key.id ?? "";
  }

  async read(organizationId: string, remoteJid: string, id: string): Promise<void> {
    const sock = this.connected(organizationId);
    await sock.readMessages([{ remoteJid, id, fromMe: false }]);
  }

  /** Reconnects every session that was linked before a restart. */
  async restoreAll(): Promise<void> {
    const orgs = await sessionsToRestore(this.pool);
    this.log.info({ count: orgs.length }, "restoring_sessions");
    for (const org of orgs) {
      await this.start(org).catch((err) => this.log.error({ err, org }, "restore_failed"));
    }
  }

  /** Closes every socket without logging out (process shutdown). */
  stopAll(): void {
    for (const s of this.sessions.values()) {
      s.stopped = true;
      s.sock?.end(undefined);
    }
  }

  private connected(organizationId: string): WASocket {
    const s = this.sessions.get(organizationId);
    if (!s?.sock || s.status !== "connected") throw new NotConnectedError(organizationId);
    return s.sock;
  }

  private setStatus(s: Session, status: LinkStatus) {
    if (s.status === status) return;
    s.status = status;
    if (status !== "qr") s.qr = "";
    void this.api.status(s.organizationId, status, s.phone);
  }

  private async waitFor(s: Session, done: (s: Session) => boolean, ms: number) {
    const until = Date.now() + ms;
    while (!done(s) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  private async connect(s: Session): Promise<void> {
    const org = s.organizationId;
    const log = this.log.child({ org });
    if (!this.version) {
      this.version = await fetchLatestBaileysVersion()
        .then((v) => v.version)
        .catch(() => undefined);
    }
    const { state, saveCreds } = await usePgAuthState(this.pool, org);
    const sock = makeWASocket({
      version: this.version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
      logger: log.child({ module: "baileys" }, { level: "warn" }),
      browser: Browsers.ubuntu("Receivable"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    s.sock = sock;
    if (s.status !== "qr") this.setStatus(s, "connecting");

    sock.ev.on("creds.update", () => {
      saveCreds().catch((err) => log.error({ err }, "save_creds_failed"));
    });

    sock.ev.on("connection.update", async (u) => {
      if (s.sock !== sock) return; // an older socket
      if (u.qr) {
        try {
          s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
          this.setStatus(s, "qr");
        } catch (err) {
          log.error({ err }, "qr_render_failed");
        }
      }
      if (u.connection === "open") {
        s.retries = 0;
        s.phone = jidUser(sock.user?.id);
        this.setStatus(s, "connected");
        log.info({ phone: s.phone }, "connected");
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode ?? 0;
        log.info({ code }, "connection_closed");
        if (s.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone: forget the login.
          this.sessions.delete(org);
          await clearAuthState(this.pool, org).catch((err) => log.error({ err }, "clear_auth_failed"));
          s.phone = "";
          this.setStatus(s, "logged_out");
          return;
        }
        // QR shown but never scanned: stop until the console asks again.
        if (!state.creds.registered && code === DisconnectReason.timedOut) {
          this.setStatus(s, "disconnected");
          return;
        }
        if (FINAL_CODES.has(code) || s.retries >= 10) {
          this.setStatus(s, "disconnected");
          return;
        }
        s.retries++;
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 1000 * 2 ** s.retries);
        setTimeout(() => {
          if (!s.stopped && s.sock === sock) {
            this.connect(s).catch((err) => log.error({ err }, "reconnect_failed"));
          }
        }, delay);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const p = toInbound(org, m as unknown as IncomingMessage);
        if (p) void this.api.inbound(p);
      }
    });
  }
}
