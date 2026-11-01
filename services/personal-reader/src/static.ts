import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function html(reply: FastifyReply, contents: string): FastifyReply {
  return reply
    .header("content-security-policy", PRODUCTION_CSP)
    .header("x-content-type-options", "nosniff")
    .type("text/html; charset=utf-8")
    .send(contents);
}

export async function registerStaticUi(
  app: FastifyInstance,
  options: { root: string; debugEnabled: boolean },
): Promise<void> {
  const index = readFileSync(resolve(options.root, "index.html"), "utf8");
  await app.register(fastifyStatic, {
    root: resolve(options.root, "assets"),
    prefix: "/assets/",
    index: false,
    wildcard: true,
    cacheControl: true,
    immutable: true,
    maxAge: "1y",
  });
  const sendIndex = (_request: unknown, reply: FastifyReply): FastifyReply => html(reply, index);
  app.get("/", sendIndex);
  app.get("/queue", sendIndex);
  app.get("/stories/:storyId", sendIndex);
  app.get("/settings", sendIndex);
  if (options.debugEnabled) app.get("/debug", sendIndex);
}
