import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import { z, ZodError } from "zod";
import { UpstreamError, type DataPlatformClient } from "../data-platform/client.ts";
import { withLiveAvailability } from "../offers/live-availability.ts";
import type { Offer } from "../types.ts";

export type StorefrontConfig = {
  liveAvailabilityEnabled: boolean;
  demoIncidentEnabled: boolean;
  liveAvailabilityConcurrency: number;
  webDistDir?: string;
  version: { service: string; version: string; commit: string };
};

const offerFilters = z.object({
  day: z.coerce.number().int().min(1).max(3).optional(),
  experience: z.enum(["general", "vip", "drop", "shuttle"]).optional(),
  shuttle: z.enum(["included", "excluded"]).optional(),
}).strict();

const reservationBody = z.object({
  offerId: z.string().min(1).max(64),
  leadName: z.string().trim().min(1).max(80),
  quantity: z.number().int().min(1).max(6),
  expectedUnitPrice: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }).strict(),
  accessKey: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

function matches(offer: Offer, filters: z.infer<typeof offerFilters>): boolean {
  if (filters.day && offer.day !== filters.day) return false;
  if (filters.shuttle && offer.includesShuttle !== (filters.shuttle === "included")) return false;
  switch (filters.experience) {
    case "general": return offer.access === "GENERAL" && offer.saleType === "STANDARD";
    case "vip": return offer.access === "VIP" && offer.saleType === "STANDARD";
    case "drop": return offer.saleType === "LIMITED_DROP";
    case "shuttle": return offer.access === null;
    default: return true;
  }
}

export function buildApp(dataPlatform: DataPlatformClient, config: StorefrontConfig, options: FastifyServerOptions = {}) {
  const app = Fastify({
    ...options,
    bodyLimit: 16_384,
    genReqId: request => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  const enrich = (offers: Offer[], log: { warn: (details: object, message: string) => void }) =>
    withLiveAvailability(offers, {
      enabled: config.liveAvailabilityEnabled,
      demoIncidentEnabled: config.demoIncidentEnabled,
      concurrency: config.liveAvailabilityConcurrency,
      fetchLive: dataPlatform.liveAvailability,
      onFailure: (offerId, error) => log.warn({ offerId, err: error }, "Live availability refresh failed; showing snapshot"),
    });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UpstreamError) {
      if (error.status >= 500) request.log.warn({ code: error.code, err: error.cause }, "Data platform unavailable");
      return reply.status(error.status).send({ code: error.code, message: error.message, requestId: request.id });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof ZodError || (status !== undefined && status >= 400 && status < 500)) {
      return reply.status(400).send({ code: "INVALID_REQUEST", message: "The request is not valid.", requestId: request.id });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Something went wrong.", requestId: request.id });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = await dataPlatform.ready().catch(() => false);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ok" : "failing", dataPlatform: ready ? "ok" : "failing" });
  });
  app.get("/version", async () => ({
    ...config.version,
    liveAvailabilityEnabled: config.liveAvailabilityEnabled,
    demoIncidentEnabled: config.demoIncidentEnabled,
  }));

  if (config.demoIncidentEnabled && config.liveAvailabilityEnabled) {
    app.log.warn("Demo incident enabled: on-sale limitedAvailability offers use live reads");
  }

  app.get("/api/festival", async () => dataPlatform.festival());

  app.get("/api/offers", async request => {
    const filters = offerFilters.parse(request.query);
    const offers = (await dataPlatform.offers()).filter(offer => matches(offer, filters));
    return enrich(offers, request.log);
  });

  app.get("/api/offers/:offerId", async request => {
    const { offerId } = z.object({ offerId: z.string().max(64) }).parse(request.params);
    const [offer] = await enrich([await dataPlatform.offer(offerId)], request.log);
    return offer;
  });

  app.post("/api/reservations", async (request, reply) => {
    const key = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(request.headers["idempotency-key"]);
    const body = reservationBody.parse(request.body);
    return reply.status(201).send(await dataPlatform.reserve(body, key));
  });

  app.get("/api/reservations/:confirmationCode", async request => {
    const { confirmationCode } = z.object({ confirmationCode: z.string().max(32) }).parse(request.params);
    const accessKey = z.string().min(32).max(128).parse(request.headers["x-reservation-access-key"]);
    return dataPlatform.reservation(confirmationCode, accessKey);
  });

  const webRoot = config.webDistDir;
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url.startsWith("/api/")) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Not found.", requestId: request.id });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
