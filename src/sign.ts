import { createHmac, timingSafeEqual } from "node:crypto";

/** Header both sides sign every request with (same as the Go API). */
export const SIGNATURE_HEADER = "x-signature-256";

/** "sha256=" + hex(HMAC-SHA256(secret, body)). */
export function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function validSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
