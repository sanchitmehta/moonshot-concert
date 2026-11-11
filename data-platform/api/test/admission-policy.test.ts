import assert from "node:assert/strict";
import { test } from "node:test";
import { notFound } from "../src/errors.ts";
import { buildApp, type Dependencies } from "../src/http/app.ts";

test("admission policy restricts processing without blocking queue joins", async () => {
  const calls: string[] = [];
  const deps = {
    admissionQueues: ["waitingroom-standard-v2"],
    catalog: { offer: async () => ({}) },
    queues: {
      join: async (queue: string) => {
        calls.push(`join:${queue}`);
        return { queue, entryId: "entry", status: "WAITING", position: 1 };
      },
      admit: async (queue: string) => {
        calls.push(`admit:${queue}`);
        return { queue, admitted: [], waiting: 0 };
      },
      stats: async () => ({ waiting: 1 }),
    },
    version: { service: "data-platform-api", version: "test", commit: "test" },
  } as unknown as Dependencies;
  const app = buildApp(deps);
  const join = await app.inject({
    method: "POST", url: "/v1/queues/waitingroom-standard/entries",
    payload: { offerId: "general", guestKey: "a".repeat(32) },
  });

  assert.equal(join.statusCode, 201);
  const request = (queue: string) => app.inject({
    method: "POST", url: `/v1/queues/${queue}/admissions`,
    headers: { "idempotency-key": "a".repeat(32) }, payload: { count: 1 },
  });
  const standard = await request("waitingroom-standard");
  assert.equal(standard.statusCode, 503);
  assert.equal(standard.json().code, "QUEUE_NOT_CONFIGURED");
  assert.equal((await request("waitingroom-drops")).statusCode, 200);
  assert.equal((await request("waitingroom-standard-v2")).statusCode, 200);
  assert.deepEqual(calls, ["join:waitingroom-standard", "admit:waitingroom-drops", "admit:waitingroom-standard-v2"]);
  await app.close();
});

test("drop offers stay visible independently of the standard admission queue configuration", async () => {
  const offers = [
    { offerId: "general", saleType: "STANDARD" },
    { offerId: "drop", saleType: "LIMITED_DROP" },
  ];
  const level = (offerId: string) => ({
    offerId, remaining: 40, asOf: "2026-01-01T00:00:00Z",
    salesOpenAt: "2020-01-01T00:00:00Z", salesCloseAt: "2099-01-01T00:00:00Z",
    unitPrice: { amountMinor: 100, currency: "USD" }, maxPerReservation: 6,
  });
  const admissionQueues = ["waitingroom-standard"];
  const deps = {
    admissionQueues,
    catalog: { offers: async () => offers, offer: async (id: string) => offers.find(offer => offer.offerId === id) },
    availability: { snapshot: async (ids: string[]) => new Map(ids.map(id => [id, level(id)])) },
    version: { service: "data-platform-api", version: "test", commit: "test" },
  } as unknown as Dependencies;
  const app = buildApp(deps);
  const list = async () => (await app.inject({ method: "GET", url: "/v1/offers" })).json() as { offerId: string }[];
  assert.deepEqual((await list()).map(offer => offer.offerId), ["general", "drop"]);
  const direct = await app.inject({ method: "GET", url: "/v1/offers/drop" });
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.json().availability.remaining, 40);
  admissionQueues.splice(0, 1, "waitingroom-standard-v2");
  assert.deepEqual((await list()).map(offer => offer.offerId), ["general", "drop"]);
  await app.close();
});

test("a refused admission logs how many guests are waiting and since when", async () => {
  const lines: Record<string, unknown>[] = [];
  const deps = {
    admissionQueues: ["waitingroom-standard"],
    queues: { stats: async () => ({ waiting: 3, oldestJoinedAt: "2027-08-20T16:00:00.000Z" }) },
    version: { service: "data-platform-api", version: "test", commit: "test" },
  } as unknown as Dependencies;
  const app = buildApp(deps, { logger: { level: "warn", stream: { write: line => lines.push(JSON.parse(line)) } } });
  const refused = await app.inject({
    method: "POST", url: "/v1/queues/waitingroom-elsewhere/admissions",
    headers: { "idempotency-key": "a".repeat(32) }, payload: { count: 1 },
  });
  assert.equal(refused.statusCode, 503);
  const { queue, waiting, oldestJoinedAt } = lines.find(line => line.msg === "Admission queue is not configured") ?? {};
  assert.deepEqual({ queue, waiting, oldestJoinedAt }, { queue: "waitingroom-elsewhere", waiting: 3, oldestJoinedAt: "2027-08-20T16:00:00.000Z" });
  await app.close();
});

test("a refused request logs its code and status", async () => {
  const lines: Record<string, unknown>[] = [];
  const deps = {
    catalog: { offer: async () => { throw notFound("OFFER_NOT_FOUND", "This pass does not exist."); } },
    version: { service: "data-platform-api", version: "test", commit: "test" },
  } as unknown as Dependencies;
  const app = buildApp(deps, { logger: { level: "info", stream: { write: line => lines.push(JSON.parse(line)) } } });
  assert.equal((await app.inject({ method: "GET", url: "/v1/offers/no-such-pass" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/v1/queues/waitingroom-standard/entries", payload: {} })).statusCode, 400);
  assert.deepEqual(
    lines.filter(line => line.msg === "Request refused").map(({ code, status }) => ({ code, status })),
    [{ code: "OFFER_NOT_FOUND", status: 404 }, { code: "INVALID_REQUEST", status: 400 }],
  );
  await app.close();
});
