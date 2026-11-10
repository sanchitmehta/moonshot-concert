import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DataPlatformClient } from "../src/data-platform/client.ts";
import { buildApp } from "../src/http/app.ts";
import { admitOnce } from "../src/waiting-room/admission-worker.ts";
import { estimatedWaitMinutes, parsePolicy, queueToJoin } from "../src/waiting-room/policy.ts";

const policy = parsePolicy(JSON.stringify([
  { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 10 },
]));
const silent = { info: () => undefined, warn: () => undefined };

describe("waiting-room policy", () => {
  test("sends each guest to the first queue listed for their pass's sale type", () => {
    const withOlderQueue = parsePolicy(JSON.stringify([
      { queue: "waitingroom-standard-v2", saleType: "STANDARD", admitCount: 10, everySeconds: 5 },
      { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 10, everySeconds: 5 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 5, everySeconds: 10 },
    ]));
    assert.equal(queueToJoin(withOlderQueue, "STANDARD").queue, "waitingroom-standard-v2");
    assert.equal(queueToJoin(policy, "LIMITED_DROP").queue, "waitingroom-drops");
  });

  test("adds the default drops queue when only standard queues are configured", () => {
    assert.deepEqual(policy, [
      { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 10 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 1, everySeconds: 10 },
    ]);
    assert.deepEqual(parsePolicy(JSON.stringify(policy)), policy);
  });

  test("preserves an explicitly configured drops queue without adding another worker", () => {
    const explicit = [
      { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 10 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 2, everySeconds: 20 },
    ];
    assert.deepEqual(parsePolicy(JSON.stringify(explicit)), explicit);
  });

  test("rejects missing standard queues and duplicate or reserved queue names", () => {
    assert.throws(() => parsePolicy("[]"));
    assert.throws(() => parsePolicy(JSON.stringify([{ queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 1, everySeconds: 10 }])));
    assert.throws(() => parsePolicy(JSON.stringify([{ queue: "waitingroom-drops", saleType: "STANDARD", admitCount: 1, everySeconds: 10 }])));
    assert.throws(() => parsePolicy(JSON.stringify([
      { queue: "waitingroom-all", saleType: "STANDARD", admitCount: 10, everySeconds: 5 },
      { queue: "waitingroom-all", saleType: "LIMITED_DROP", admitCount: 5, everySeconds: 10 },
    ])));
  });

  test("estimates the wait from the queue's admission rate, and not for a queue it does not drain", () => {
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-standard", 10), 1);
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-standard", 130), 5);
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-drops", 35), 6);
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-elsewhere", 10), null);
  });

  test("rejects an interval shorter than 5 seconds", () => {
    assert.throws(() => parsePolicy(JSON.stringify([
      { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 10, everySeconds: 1 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 5, everySeconds: 10 },
    ])));
  });
});

describe("admission worker", () => {
  test("admits the queue's count once per its own interval", async () => {
    const calls: [string, number, string][] = [];
    const admit = async (queue: string, count: number, key: string) => {
      calls.push([queue, count, key]);
      return { admitted: [], waiting: 0 };
    };
    const [standard, drops] = policy;
    const now = Date.UTC(2027, 7, 20, 16, 0, 30);
    await admitOnce(standard!, admit, silent, now);
    await admitOnce(standard!, admit, silent, now + 2_000);
    await admitOnce(drops!, admit, silent, now);
    assert.deepEqual(calls, [
      ["waitingroom-standard", 5, `admit-waitingroom-standard-${Math.floor(now / 10_000)}`],
      ["waitingroom-standard", 5, `admit-waitingroom-standard-${Math.floor(now / 10_000)}`],
      ["waitingroom-drops", 1, `admit-waitingroom-drops-${Math.floor(now / 10_000)}`],
    ]);
  });

  test("logs a failed admission instead of throwing", async () => {
    const warnings: object[] = [];
    const admit = async () => { throw new Error("unavailable"); };
    await admitOnce(policy[0]!, admit, { info: () => undefined, warn: details => warnings.push(details) });
    assert.equal(warnings.length, 1);
  });
});
describe("waiting-room routes", () => {
  test("a queue migration keeps old tickets on their queue and sends new guests to the improved queue", async () => {
    const calls: string[] = [];
    const dataPlatform = {
      offer: async () => ({ offerId: "general", saleType: "STANDARD" }),
      joinQueue: async (queue: string) => {
        calls.push(`join:${queue}`);
        return { entryId: "57578bef-05ff-4de5-8ee1-c83abf9d981f", offerId: "general", status: "WAITING", position: 3 };
      },
      queueEntry: async (queue: string) => {
        calls.push(`read:${queue}`);
        return { offerId: "general", status: "WAITING", position: 3 };
      },
    } as unknown as DataPlatformClient;
    const config = {
      liveAvailabilityEnabled: false, liveAvailabilityConcurrency: 1, waitingRoomPolicy: policy,
      version: { service: "storefront-api", version: "test", commit: "test" },
    };
    const before = buildApp(dataPlatform, config);
    const joined = await before.inject({ method: "POST", url: "/api/waiting-room", payload: { offerId: "general" } });
    const oldTicket = joined.json<{ ticket: string }>().ticket;
    await before.close();
    const improved = parsePolicy(JSON.stringify([
      { queue: "waiting-room-perf-improved", saleType: "STANDARD", admitCount: 5, everySeconds: 10 },
      ...policy.filter(entry => entry.saleType === "STANDARD"),
    ]));
    const after = buildApp(dataPlatform, { ...config, waitingRoomPolicy: improved });
    assert.equal((await after.inject({ method: "GET", url: `/api/waiting-room/${oldTicket}` })).statusCode, 200);
    const newJoin = await after.inject({ method: "POST", url: "/api/waiting-room", payload: { offerId: "general" } });
    assert.equal(newJoin.statusCode, 201);
    const newTicket = newJoin.json<{ ticket: string }>().ticket;
    assert.equal((JSON.parse(Buffer.from(newTicket, "base64url").toString("utf8")) as { queue: string }).queue,
      "waiting-room-perf-improved");
    assert.deepEqual(calls, ["join:waitingroom-standard", "read:waitingroom-standard", "join:waiting-room-perf-improved"]);
    assert.ok(improved.some(entry => entry.queue === "waitingroom-standard"));
    await after.close();
  });

  test("lines a guest up in their pass's queue and finds them again from the ticket", async () => {
    const joined: string[] = [];
    const dataPlatform = {
      offer: async (offerId: string) => ({ offerId, saleType: "LIMITED_DROP" }),
      joinQueue: async (queue: string) => {
        joined.push(queue);
        return { entryId: "57578bef-05ff-4de5-8ee1-c83abf9d981f", offerId: "crater-club", status: "WAITING", position: 3 };
      },
      queueEntry: async () => ({ entryId: "57578bef-05ff-4de5-8ee1-c83abf9d981f", offerId: "crater-club", status: "WAITING", position: 2 }),
    } as unknown as DataPlatformClient;
    const app = buildApp(dataPlatform, {
      liveAvailabilityEnabled: false, liveAvailabilityConcurrency: 1, waitingRoomPolicy: policy,
      version: { service: "storefront-api", version: "test", commit: "test" },
    });
    const join = await app.inject({ method: "POST", url: "/api/waiting-room", payload: { offerId: "crater-club" } });
    assert.equal(join.statusCode, 201);
    assert.deepEqual(joined, ["waitingroom-drops"]);
    const { ticket } = join.json<{ ticket: string }>();
    const place = await app.inject({ method: "GET", url: `/api/waiting-room/${ticket}` });
    assert.equal(place.statusCode, 200, place.body);
    assert.deepEqual(place.json(), { offerId: "crater-club", status: "WAITING", position: 2, estimatedWaitMinutes: 1 });
    await app.close();
  });
});