import { randomUUID } from "node:crypto";
import Fastify, { type FastifyServerOptions } from "fastify";
import { z, ZodError } from "zod";
import type { AvailabilityService } from "../availability/availability-service.ts";
import type { CatalogStore } from "../catalog/catalog-store.ts";
import { toAvailability, type CatalogOffer, type Offer, type StockLevel } from "../domain.ts";
import { notFound, ServiceError } from "../errors.ts";
import type { InventoryStore } from "../inventory/inventory-store.ts";
import type { components } from "./contract.ts";

type Schemas = components["schemas"];

export type Dependencies = {
  catalog: CatalogStore;
  inventory: InventoryStore;
  availability: AvailabilityService;
  version: { service: string; version: string; commit: string };
};

const offerParams = z.object({ offerId: z.string().max(64) });
const reservationBody = z.object({
  offerId: z.string().min(1).max(64),
  leadName: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u, "Lead name contains invalid characters"),
  quantity: z.number().int().min(1).max(6),
  expectedUnitPrice: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }).strict(),
  accessKey: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const accessKeyHeader = z.string().min(32).max(128);

function toOffer(offer: CatalogOffer, level: StockLevel): Offer {
  const { offerId: _offerId, remaining: _remaining, asOf: _asOf, ...terms } = level;
  return { ...offer, ...terms, availability: toAvailability(level, "SNAPSHOT") };
}

export function buildApp(deps: Dependencies, options: FastifyServerOptions = {}) {
  const app = Fastify({
    ...options,
    bodyLimit: 16_384,
    genReqId: request => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
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

  app.get("/health/ready", async (request, reply) => {
    const checks = await Promise.allSettled([deps.inventory.ping(), deps.availability.ping(), deps.catalog.ping()]);
    const [inventory, cache, catalog] = checks.map(check => (check.status === "fulfilled" ? "ok" : "failing"));
    const ready = checks.every(check => check.status === "fulfilled");
    if (!ready) request.log.warn({ inventory, cache, catalog }, "Readiness check failed");
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ok" : "failing", inventory, cache, catalog });
  });

  app.get("/version", async () => deps.version);

  app.get("/v1/festival", async () => (await deps.catalog.festival()) satisfies Schemas["Festival"]);

  app.get("/v1/offers", async request => {
    const offers = await deps.catalog.offers();
    const levels = await deps.availability.snapshot(offers.map(offer => offer.offerId));
    return offers.flatMap(offer => {
      const level = levels.get(offer.offerId);
      if (!level) {
        request.log.warn({ offerId: offer.offerId }, "Catalog offer has no inventory");
        return [];
      }
      return [toOffer(offer, level) satisfies Schemas["Offer"]];
    });
  });

  app.get("/v1/offers/:offerId", async request => {
    const { offerId } = offerParams.parse(request.params);
    const offer = await deps.catalog.offer(offerId);
    const level = (await deps.availability.snapshot([offerId])).get(offerId);
    if (!level) throw notFound("OFFER_NOT_FOUND", "This pass does not exist.");
    return toOffer(offer, level) satisfies Schemas["Offer"];
  });

  app.get("/v1/offers/:offerId/availability", async request => {
    const { offerId } = offerParams.parse(request.params);
    const { freshness } = z.object({ freshness: z.enum(["snapshot", "live"]).default("snapshot") }).parse(request.query);
    await deps.catalog.offer(offerId);
    const level = freshness === "live"
      ? await deps.availability.live(offerId)
      : (await deps.availability.snapshot([offerId])).get(offerId);
    if (!level) throw notFound("OFFER_NOT_FOUND", "This pass does not exist.");
    return toAvailability(level, freshness === "live" ? "LIVE" : "SNAPSHOT") satisfies Schemas["Availability"];
  });

  app.post("/v1/reservations", async (request, reply) => {
    const key = idempotencyKey.parse(request.headers["idempotency-key"]);
    const body = reservationBody.parse(request.body);
    const offer = await deps.catalog.offer(body.offerId);
    const reservation = await deps.inventory.reserve(body, key, {
      name: offer.name, day: offer.day, access: offer.access, includesShuttle: offer.includesShuttle, perks: offer.perks,
    });
    await deps.availability.invalidate(body.offerId);
    return reply.status(201).send(reservation satisfies Schemas["Reservation"]);
  });

  app.get("/v1/reservations/:confirmationCode", async request => {
    const { confirmationCode } = z.object({ confirmationCode: z.string().max(32) }).parse(request.params);
    const accessKey = accessKeyHeader.parse(request.headers["x-reservation-access-key"]);
    return (await deps.inventory.findReservation(confirmationCode, accessKey)) satisfies Schemas["Reservation"];
  });

  return app;
}
