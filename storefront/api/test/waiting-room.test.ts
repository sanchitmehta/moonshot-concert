import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DataPlatformClient } from "../src/data-platform/client.ts";
import { buildApp } from "../src/http/app.ts";
import { admitOnce } from "../src/waiting-room/admission-worker.ts";
import { estimatedWaitMinutes, parsePolicy, queueToJoin } from "../src/waiting-room/policy.ts";

const policy = parsePolicy(JSON.stringify([
  { queue: "waitingroom-standard", saleType: "STANDARD", perMinute: 4 },
  { queue: "waitingroom-drops", saleType: "LIMITED_DROP", perMinute: 1 },
]));
const silent = { info: () => undefined, warn: () => undefined };

describe("waiting-room policy", () => {
  test("sends each guest to the first queue listed for their pass's sale type", () => {
    const withOlderQueue = parsePolicy(JSON.stringify([
      { queue: "waitingroom-standard-v2", saleType: "STANDARD", perMinute: 4 },
      { queue: "waitingroom-standard", saleType: "STANDARD", perMinute: 4 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", perMinute: 1 },
    ]));
    assert.equal(queueToJoin(withOlderQueue, "STANDARD").queue, "waitingroom-standard-v2");
    assert.equal(queueToJoin(policy, "LIMITED_DROP").queue, "waitingroom-drops");
  });

  test("rejects a policy that leaves a sale type without a queue or lists a queue twice", () => {
    assert.throws(() => parsePolicy(JSON.stringify([{ queue: "waitingroom-standard", saleType: "STANDARD", perMinute: 4 }])));
    assert.throws(() => parsePolicy(JSON.stringify([
      { queue: "waitingroom-all", saleType: "STANDARD", perMinute: 4 },
      { queue: "waitingroom-all", saleType: "LIMITED_DROP", perMinute: 1 },
    ])));
  });

  test("estimates the wait from the queue's admission rate, and not for a queue it does not drain", () => {
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-standard", 10), 3);
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-drops", 10), 10);
    assert.equal(estimatedWaitMinutes(policy, "waitingroom-elsewhere", 10), null);
  });
});

describe("admission worker", () => {
  test("asks to admit from every listed queue once per interval", async () => {
    const calls: [string, number, string][] = [];
    const admit = async (queue: string, count: number, key: string) => {
      calls.push([queue, count, key]);
      return { admitted: [], waiting: 0 };
    };
    const now = Date.UTC(2027, 7, 20, 16, 0, 30);
    await admitOnce(policy, admit, silent, 60, now);
    await admitOnce(policy, admit, silent, 60, now + 10_000);
    const minute = Math.floor(now / 60_000);
    assert.deepEqual(calls.slice(0, 2), [
      ["waitingroom-standard", 4, `admit-waitingroom-standard-${minute}`],
      ["waitingroom-drops", 1, `admit-waitingroom-drops-${minute}`],
    ]);
    assert.deepEqual(calls.slice(2), calls.slice(0, 2), "a repeated tick in the same interval reuses its keys");
  });

  test("scales the count to shorter intervals and keeps going when one queue fails", async () => {
    const calls: [string, number][] = [];
    const admit = async (queue: string, count: number) => {
      calls.push([queue, count]);
      if (queue === "waitingroom-standard") throw new Error("unavailable");
      return { admitted: ["a"], waiting: 3 };
    };
    await admitOnce(policy, admit, silent, 15);
    assert.deepEqual(calls, [["waitingroom-standard", 1], ["waitingroom-drops", 1]]);
  });
});

describe("waiting-room routes", () => {
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
    assert.deepEqual(place.json(), { offerId: "crater-club", status: "WAITING", position: 2, estimatedWaitMinutes: 2 });
    await app.close();
  });
});