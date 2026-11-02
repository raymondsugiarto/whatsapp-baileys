import type { Logger } from "pino";
import { SIGNATURE_HEADER, sign } from "./sign.js";
import type { InboundPayload } from "./message.js";

export type LinkStatus = "disconnected" | "connecting" | "qr" | "connected" | "logged_out";

/** Calls receivable-api's internal WhatsApp routes, signed. */
export class GoApi {
  constructor(
    private baseUrl: string,
    private secret: string,
    private log: Logger,
  ) {}

  private async post(path: string, body: unknown): Promise<void> {
    const raw = JSON.stringify(body);
    // Retry a couple of times: the API may be restarting.
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(this.baseUrl + path, {
          method: "POST",
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(this.secret, raw) },
          body: raw,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        const text = await res.text().catch(() => "");
        // 4xx will not get better on retry.
        if (res.status < 500 || attempt >= 3) {
          throw new Error(`receivable-api ${res.status}: ${text}`);
        }
      } catch (err) {
        if (attempt >= 3) throw err;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  async inbound(p: InboundPayload): Promise<void> {
    try {
      await this.post("/api/v1/internal/whatsapp/inbound", p);
    } catch (err) {
      this.log.warn({ err, org: p.organizationId, messageId: p.messageId }, "forward_inbound_failed");
    }
  }

  async status(organizationId: string, status: LinkStatus, phone: string): Promise<void> {
    try {
      await this.post("/api/v1/internal/whatsapp/status", { organizationId, status, phone });
    } catch (err) {
      this.log.warn({ err, org: organizationId, status }, "push_status_failed");
    }
  }
}
