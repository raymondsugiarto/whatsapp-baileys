import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { buildServer } from "../src/http.ts";
import { NotConnectedError, type SessionManager } from "../src/sessions.ts";
import { SIGNATURE_HEADER, sign } from "../src/sign.ts";

const SECRET = "s3cret";

function fakeSessions() {
  const calls: string[] = [];
  const s = {
    state: (org: string) => ({ status: "qr", qr: "data:x", phone: "" }),
    start: async (org: string) => {
      calls.push(`start:${org}`);
      return { status: "qr", qr: "data:x", phone: "" };
    },
    logout: async (org: string) => {
      calls.push(`logout:${org}`);
    },
    send: async (org: string, to: string, text: string) => {
      if (org === "offline") throw new NotConnectedError(org);
      calls.push(`send:${org}:${to}:${text}`);
      return "MID";
    },
    read: async (org: string, jid: string, id: string) => {
      calls.push(`read:${org}:${jid}:${id}`);
    },
  };
  return { sessions: s as unknown as SessionManager, calls };
}

test("rejects unsigned and wrongly signed calls", async () => {
  const { sessions } = fakeSessions();
  const app = buildServer(sessions, SECRET, pino({ level: "silent" }));
  const none = await app.inject({ method: "GET", url: "/sessions/o1" });
  assert.equal(none.statusCode, 401);
  const bad = await app.inject({ method: "GET", url: "/sessions/o1", headers: { [SIGNATURE_HEADER]: sign("x", "") } });
  assert.equal(bad.statusCode, 401);
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
});

test("signed routes reach the session manager", async () => {
  const { sessions, calls } = fakeSessions();
  const app = buildServer(sessions, SECRET, pino({ level: "silent" }));

  const get = await app.inject({ method: "GET", url: "/sessions/o1", headers: { [SIGNATURE_HEADER]: sign(SECRET, "") } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().status, "qr");

  // POST with no body, as the Go client sends for start/logout.
  const start = await app.inject({ method: "POST", url: "/sessions/o1/start", headers: { [SIGNATURE_HEADER]: sign(SECRET, "") } });
  assert.equal(start.statusCode, 200);

  const body = JSON.stringify({ to: "6281@s.whatsapp.net", text: "hi" });
  const send = await app.inject({
    method: "POST",
    url: "/sessions/o1/send",
    payload: body,
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(SECRET, body) },
  });
  assert.equal(send.statusCode, 200);
  assert.equal(send.json().messageId, "MID");

  const offline = await app.inject({
    method: "POST",
    url: "/sessions/offline/send",
    payload: body,
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(SECRET, body) },
  });
  assert.equal(offline.statusCode, 409);

  const logout = await app.inject({ method: "POST", url: "/sessions/o1/logout", headers: { [SIGNATURE_HEADER]: sign(SECRET, "") } });
  assert.equal(logout.statusCode, 204);

  assert.deepEqual(calls, ["start:o1", "send:o1:6281@s.whatsapp.net:hi", "logout:o1"]);
});
