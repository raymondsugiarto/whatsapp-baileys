import Fastify from "fastify";
import type { Logger } from "pino";
import { SIGNATURE_HEADER, validSignature } from "./sign.js";
import { NotConnectedError, type SessionManager } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Internal API that receivable-api calls. Every route except /health
 * needs a valid signature over the raw body ("" for GET). */
export function buildServer(sessions: SessionManager, secret: string, log: Logger) {
  const app = Fastify({ loggerInstance: log, bodyLimit: 256 * 1024 });

  // Keep the raw body: the signature covers the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    req.rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch {
      const err = new Error("invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;
    const header = req.headers[SIGNATURE_HEADER];
    if (!validSignature(secret, req.rawBody ?? "", Array.isArray(header) ? header[0] : header)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof NotConnectedError) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request_failed");
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(status).send({ error: status >= 500 ? "internal error" : message });
  });

  type Params = { orgId: string };

  app.post<{ Params: Params }>("/sessions/:orgId/start", async (req) => sessions.start(req.params.orgId));

  app.get<{ Params: Params }>("/sessions/:orgId", async (req) => sessions.state(req.params.orgId));

  app.post<{ Params: Params }>("/sessions/:orgId/logout", async (req, reply) => {
    await sessions.logout(req.params.orgId);
    return reply.code(204).send();
  });

  app.post<{ Params: Params; Body: { to?: string; text?: string } }>("/sessions/:orgId/send", async (req, reply) => {
    const { to, text } = req.body ?? {};
    if (!to || !text) return reply.code(400).send({ error: "to and text are required" });
    return { messageId: await sessions.send(req.params.orgId, to, text) };
  });

  app.post<{ Params: Params; Body: { remoteJid?: string; id?: string } }>("/sessions/:orgId/read", async (req, reply) => {
    const { remoteJid, id } = req.body ?? {};
    if (!remoteJid || !id) return reply.code(400).send({ error: "remoteJid and id are required" });
    await sessions.read(req.params.orgId, remoteJid, id);
    return reply.code(204).send();
  });

  return app;
}
