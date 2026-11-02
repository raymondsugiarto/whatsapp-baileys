import { test } from "node:test";
import assert from "node:assert/strict";
import { jidUser, senderPhone, toInbound, toJid, contentType, messageText } from "../src/message.ts";
import { rowId } from "../src/authState.ts";
import { sign, validSignature } from "../src/sign.ts";

test("jidUser drops server and device", () => {
  assert.equal(jidUser("6281234567890:12@s.whatsapp.net"), "6281234567890");
  assert.equal(jidUser("6281234567890@s.whatsapp.net"), "6281234567890");
  assert.equal(jidUser(undefined), "");
});

test("toJid keeps jids and builds phone jids", () => {
  assert.equal(toJid("+62 812-3456"), "628123456@s.whatsapp.net");
  assert.equal(toJid("123@lid"), "123@lid");
});

test("senderPhone prefers a phone-number jid", () => {
  assert.equal(senderPhone({ remoteJid: "6281@s.whatsapp.net" }), "6281");
  assert.equal(senderPhone({ remoteJid: "999@lid", senderPn: "6282@s.whatsapp.net" }), "6282");
  assert.equal(senderPhone({ remoteJid: "999@lid", remoteJidAlt: "6283@s.whatsapp.net" }), "6283");
  assert.equal(senderPhone({ remoteJid: "999@lid" }), "");
});

test("text and type from message variants", () => {
  assert.equal(messageText({ conversation: "hi" }), "hi");
  assert.equal(messageText({ extendedTextMessage: { text: "hello" } }), "hello");
  assert.equal(messageText({ ephemeralMessage: { message: { conversation: "eph" } } }), "eph");
  assert.equal(messageText({ imageMessage: { caption: "cap" } }), "cap");
  assert.equal(contentType({ messageContextInfo: {}, conversation: "x" }), "conversation");
});

test("toInbound maps a text message", () => {
  const p = toInbound("org-1", {
    key: { remoteJid: "6281234567890@s.whatsapp.net", id: "M1", fromMe: false },
    pushName: "Budi",
    message: { conversation: "How many invoice today" },
  });
  assert.deepEqual(p, {
    organizationId: "org-1",
    remoteJid: "6281234567890@s.whatsapp.net",
    from: "6281234567890",
    name: "Budi",
    messageId: "M1",
    type: "text",
    text: "How many invoice today",
  });
});

test("toInbound skips own, group, status and protocol messages", () => {
  const msg = { conversation: "x" };
  assert.equal(toInbound("o", { key: { remoteJid: "1@s.whatsapp.net", id: "a", fromMe: true }, message: msg }), null);
  assert.equal(toInbound("o", { key: { remoteJid: "1-2@g.us", id: "a" }, message: msg }), null);
  assert.equal(toInbound("o", { key: { remoteJid: "status@broadcast", id: "a" }, message: msg }), null);
  assert.equal(
    toInbound("o", { key: { remoteJid: "1@s.whatsapp.net", id: "a" }, message: { protocolMessage: {} } }),
    null,
  );
  assert.equal(toInbound("o", { key: { remoteJid: "1@s.whatsapp.net", id: "a" }, message: null }), null);
});

test("image message keeps caption and type", () => {
  const p = toInbound("o", { key: { remoteJid: "1@s.whatsapp.net", id: "a" }, message: { imageMessage: { caption: "nota" } } });
  assert.equal(p?.type, "image");
  assert.equal(p?.text, "nota");
});

test("signature matches the Go format", () => {
  // Same vector as Go: Sign("k", []byte("{}")).
  const s = sign("k", "{}");
  assert.match(s, /^sha256=[0-9a-f]{64}$/);
  assert.ok(validSignature("k", "{}", s));
  assert.ok(!validSignature("k", "{} ", s));
  assert.ok(!validSignature("", "{}", s));
  assert.ok(!validSignature("k", "{}", undefined));
});

test("rowId is a stable uuid-shaped md5", () => {
  const id = rowId("org", "creds");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(id, rowId("org", "creds"));
  assert.notEqual(id, rowId("org2", "creds"));
});
