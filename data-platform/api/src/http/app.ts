import { randomUUID } from "node:crypto";
import Fastify, { type FastifyServerOptions } from "fastify";
import { z, ZodError } from "zod";
import { inventory as seedInventory } from "../../db/seed/festival.ts";
import type { AvailabilityService } from "../availability/availability-service.ts";
import type { BillingClient } from "../billing/billing-client.ts";
import type { CatalogStore } from "../catalog/catalog-store.ts";
import { toAvailability, type CatalogOffer, type Offer, type StockLevel } from "../domain.ts";
import { conflict, notFound, ServiceError } from "../errors.ts";
import type { InventoryStore } from "../inventory/inventory-store.ts";
import { checkout } from "../reservations/checkout.ts";
import type { QueueStore } from "../waiting-room/queue-store.ts";
import type { components } from "./contract.ts";
import type { Authenticate } from "./entra-auth.ts";

type Schemas = components["schemas"];

export type Dependencies = {
  catalog: CatalogStore;
  inventory: InventoryStore;
  availability: AvailabilityService;
  queues: QueueStore;
  billing: BillingClient;
  admissionQueues?: string[];
  version: { service: string; version: string; commit: string };
  /** Checks the caller on every /v1 request. Omitted only for local development on loopback. */
  authenticate?: Authenticate;
};

const offerParams = z.object({ offerId: z.string().max(64) });
const reservationBody = z.object({
  offerId: z.string().min(1).max(64),
  leadName: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u, "Lead name contains invalid characters"),
  quantity: z.number().int().min(1).max(6),
  expectedUnitPrice: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }).strict(),
  accessKey: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  walletId: z.string().max(32),
  admission: z.object({ queue: z.string(), entryId: z.string().uuid(), token: z.string().min(16).max(128) }).strict(),
}).strict();
const queueParams = z.object({ queue: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });
const entryParams = queueParams.extend({ entryId: z.string().uuid() });
const joinBody = z.object({ offerId: z.string().min(1).max(64), guestKey: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const admitBody = z.object({ count: z.number().int().min(1).max(100) }).strict();
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const accessKeyHeader = z.string().min(32).max(128);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const noInput = z.preprocess(body => (typeof body === "string" && body.trim() ? parseJson(body) : {}), z.object({}).strict());

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
      if (error.status < 500) request.log.info({ code: error.code, status: error.status }, "Request refused");
      return reply.status(error.status).send({ code: error.code, message: error.message, requestId: request.id });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof ZodError || (status !== undefined && status >= 400 && status < 500)) {
      request.log.info({ code: "INVALID_REQUEST", status: 400 }, "Request refused");
      return reply.status(400).send({ code: "INVALID_REQUEST", message: "The request is not valid.", requestId: request.id });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Something went wrong.", requestId: request.id });
  });

  const authenticate = deps.authenticate;
  if (authenticate) {
    app.addHook("onRequest", async request => {
      // The matched route, not the raw URL: the router decodes paths, so `/%761/offers` serves `/v1/offers`.
      const path = request.routeOptions.url ?? request.url;
      if (path.startsWith("/v1/")) await authenticate(request.headers.authorization, path.startsWith("/v1/admin/") ? "admin" : "api");
    });
  }

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (request, reply) => {
    const checks = await Promise.allSettled([deps.inventory.ping(), deps.availability.ping(), deps.catalog.ping(), deps.queues.ping()]);
    const [database, cache, catalog, queues] = checks.map(check => (check.status === "fulfilled" ? "ok" : "failing"));
    const ready = checks.every(check => check.status === "fulfilled");
    if (!ready) request.log.warn({ database, cache, catalog, queues }, "Readiness check failed");
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ok" : "failing", database, cache, catalog, queues });
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

  app.post("/v1/queues/:queue/entries", async (request, reply) => {
    const { queue } = queueParams.parse(request.params);
    const body = joinBody.parse(request.body);
    await deps.catalog.offer(body.offerId);
    const entry = await deps.queues.join(queue, body.offerId, body.guestKey);
    request.log.info({ queue, entryId: entry.entryId, position: entry.position }, "Guest joined the waiting room");
    return reply.status(201).send(entry satisfies Schemas["QueueEntry"]);
  });

  app.get("/v1/queues/:queue/entries/:entryId", async request => {
    const { queue, entryId } = entryParams.parse(request.params);
    const guestKey = accessKeyHeader.parse(request.headers["x-guest-key"]);
    return (await deps.queues.entry(queue, entryId, guestKey)) satisfies Schemas["QueueEntry"];
  });

  app.post("/v1/queues/:queue/admissions", async request => {
    const { queue } = queueParams.parse(request.params);
    const key = idempotencyKey.parse(request.headers["idempotency-key"]);
    const { count } = admitBody.parse(request.body);
    // Drop admissions use a built-in queue independently of the configured standard queues.
    if (queue !== "waitingroom-drops" && deps.admissionQueues && !deps.admissionQueues.includes(queue)) {
      const { waiting, oldestJoinedAt } = await deps.queues.stats(queue);
      if (waiting === 0) return { queue, admitted: [], waiting };
      request.log.warn({ queue, waiting, oldestJoinedAt }, "Admission queue is not configured");
      throw conflict(
        "QUEUE_NOT_CONFIGURED",
        `Queue "${queue}" is not enabled for admission processing. Configure this queue or route admissions to an enabled queue.`,
      );
    }
    const result = await deps.queues.admit(queue, count, key);
    request.log.info({ queue, admitted: result.admitted.length, waiting: result.waiting }, "Admitted guests from the waiting room");
    return result satisfies Schemas["Admissions"];
  });

  app.get("/v1/queues/:queue", async request => {
    const { queue } = queueParams.parse(request.params);
    return (await deps.queues.stats(queue)) satisfies Schemas["QueueStats"];
  });

  app.post("/v1/reservations", async (request, reply) => {
    const key = idempotencyKey.parse(request.headers["idempotency-key"]);
    const { admission, ...body } = reservationBody.parse(request.body);
    const offer = await deps.catalog.offer(body.offerId);
    // A retry of a reservation that already succeeded replays it, even though its admission is now used.
    const retry = await deps.inventory.hasReservation(key);
    request.log.info({ offerId: body.offerId, quantity: body.quantity, queue: admission.queue, entryId: admission.entryId, retry }, "Reservation requested");
    if (!retry) await deps.queues.checkAdmission(queueParams.parse(admission).queue, admission.entryId, admission.token, body.offerId);
    const reservation = await checkout({ inventory: deps.inventory, billing: deps.billing, log: request.log }, body, key, {
      name: offer.name, day: offer.day, access: offer.access, includesShuttle: offer.includesShuttle, perks: offer.perks,
    }, admission.entryId);
    if (!retry) {
      await deps.queues.markUsed(admission.queue, admission.entryId, admission.token)
        .then(() => request.log.info({ queue: admission.queue, entryId: admission.entryId }, "Admission used"))
        .catch(error => request.log.warn({ err: error }, "Could not mark the admission used"));
    }
    await deps.availability.invalidate(body.offerId);
    return reply.status(201).send(reservation satisfies Schemas["Reservation"]);
  });

  app.get("/v1/reservations/:confirmationCode", async request => {
    const { confirmationCode } = z.object({ confirmationCode: z.string().max(32) }).parse(request.params);
    const accessKey = accessKeyHeader.parse(request.headers["x-reservation-access-key"]);
    const reservation = await deps.inventory.findReservation(confirmationCode, accessKey);
    request.log.info({ confirmationCode }, "Reservation opened");
    return reservation satisfies Schemas["Reservation"];
  });

  app.get("/v1/reservations/:confirmationCode/invoice", async request => {
    const { confirmationCode } = z.object({ confirmationCode: z.string().max(32) }).parse(request.params);
    const accessKey = accessKeyHeader.parse(request.headers["x-reservation-access-key"]);
    const reservation = await deps.inventory.findReservation(confirmationCode, accessKey);
    const invoiceNumber = reservation.payment?.invoiceNumber;
    if (!invoiceNumber) throw notFound("INVOICE_NOT_FOUND", "This reservation has no invoice.");
    const invoice = await deps.billing.invoice(invoiceNumber);
    request.log.info({ confirmationCode, invoiceNumber }, "Invoice opened");
    return invoice satisfies Schemas["Invoice"];
  });

  // Admin routes need the admin app role, which grants nothing else.
  app.register(async admin => {
    // The restock takes no input: its body may be missing, empty or {}.
    admin.removeContentTypeParser("application/json");
    admin.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));

    admin.post("/v1/admin/restock", async request => {
      noInput.parse(request.body);
      const restock = await deps.inventory.restock(seedInventory(new Date()));
      await Promise.all(restock.offers.map(offer => deps.availability.invalidate(offer.offerId)));
      const unitsAdded = restock.offers.reduce((sum, offer) => sum + offer.remaining - offer.previousRemaining, 0);
      request.log.info({ offers: restock.offers.length, unitsAdded, skipped: restock.skipped.length }, "Inventory restocked");
      return { restockedAt: new Date().toISOString(), ...restock } satisfies Schemas["Restock"];
    });
  });

  return app;
}
