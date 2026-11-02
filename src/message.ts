/**
 * Pure helpers that turn Baileys messages into what receivable-api expects.
 * Kept free of Baileys imports so they are easy to test.
 */

/** Subset of Baileys' WAMessageKey we read. Newer WhatsApp accounts send
 * a privacy id (…@lid) as remoteJid; the phone-number jid then arrives in
 * one of the *Alt / *Pn fields, depending on the Baileys version. */
export interface MessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
  participantPn?: string | null;
}

export interface IncomingMessage {
  key: MessageKey;
  pushName?: string | null;
  message?: Record<string, unknown> | null;
}

/** Body of POST /api/v1/internal/whatsapp/inbound. */
export interface InboundPayload {
  organizationId: string;
  remoteJid: string;
  from: string;
  name: string;
  messageId: string;
  type: string;
  text: string;
}

const USER_SERVER = "s.whatsapp.net";

/** "6281234:12@s.whatsapp.net" → "6281234" (device suffix dropped). */
export function jidUser(jid: string | null | undefined): string {
  if (!jid) return "";
  const user = jid.split("@")[0] ?? "";
  return user.split(":")[0] ?? "";
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith("@" + USER_SERVER);
}

/** Chats we never answer: groups, broadcast lists, status, newsletters. */
export function isIgnoredChat(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return (
    jid.endsWith("@g.us") ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter") ||
    jid === "status@broadcast"
  );
}

/** Where to send: a full jid is kept, digits become …@s.whatsapp.net. */
export function toJid(to: string): string {
  const t = to.trim();
  if (t.includes("@")) return t;
  return t.replace(/[^\d]/g, "") + "@" + USER_SERVER;
}

/** The sender's phone number in digits, or "" when only a @lid is known. */
export function senderPhone(key: MessageKey): string {
  for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participantPn]) {
    if (isPhoneJid(jid)) return jidUser(jid);
  }
  return "";
}

/** Unwraps ephemeral / view-once containers. */
function unwrap(message: Record<string, unknown>): Record<string, unknown> {
  for (const k of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]) {
    const inner = (message[k] as { message?: Record<string, unknown> } | undefined)?.message;
    if (inner) return unwrap(inner);
  }
  return message;
}

const CONTENT_SKIP = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/** First real content key, e.g. "conversation", "imageMessage". */
export function contentType(message: Record<string, unknown> | null | undefined): string {
  if (!message) return "";
  return Object.keys(unwrap(message)).find((k) => !CONTENT_SKIP.has(k)) ?? "";
}

/** Text of a message: plain text, extended text or a media caption. */
export function messageText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return "";
  const m = unwrap(message);
  if (typeof m.conversation === "string") return m.conversation;
  for (const k of ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage"]) {
    const v = m[k] as { text?: string; caption?: string } | undefined;
    if (v?.text) return v.text;
    if (v?.caption) return v.caption;
  }
  return "";
}

/** Cloud API-style type names, so logs look the same for both methods. */
function typeName(content: string): string {
  switch (content) {
    case "conversation":
    case "extendedTextMessage":
      return "text";
    case "":
      return "unknown";
    default:
      return content.replace(/Message$/, "");
  }
}

/**
 * Builds the payload for one received message, or null when it should not
 * reach the API (own messages, groups, status, protocol/empty messages).
 */
export function toInbound(organizationId: string, msg: IncomingMessage): InboundPayload | null {
  const { key } = msg;
  if (key.fromMe || !key.id || isIgnoredChat(key.remoteJid)) return null;
  const content = contentType(msg.message);
  if (!content || content === "protocolMessage" || content === "reactionMessage") return null;
  return {
    organizationId,
    remoteJid: key.remoteJid ?? "",
    from: senderPhone(key) || jidUser(key.remoteJid),
    name: msg.pushName ?? "",
    messageId: key.id,
    type: typeName(content),
    text: messageText(msg.message),
  };
}
