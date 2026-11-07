import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { ServiceError } from "../src/errors.ts";
import { QueueStore } from "../src/waiting-room/queue-store.ts";

const redisUrl = process.env.TEST_REDIS_URL;
const log = { warn: () => undefined };
const rejectsWith = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;
const guestKey = () => randomBytes(32).toString("base64url");

describe("waiting-room queues", { skip: redisUrl ? false : "Set TEST_REDIS_URL to a Redis server" }, () => {
  let store: QueueStore;
  let expiring: QueueStore;
  const queue = () => `test-${randomBytes(6).toString("hex")}`;

  before(async () => {
    store = new QueueStore(redisUrl!, log);
    expiring = new QueueStore(redisUrl!, log, { admissionMinutes: 0 });
    await Promise.all([store.connect(), expiring.connect()]);
  });

  after(async () => {
    await Promise.allSettled([store?.close(), expiring?.close()]);
  });

  test("lines guests up in joining order and admits the longest-waiting first", async () => {
    const name = queue();
    const guests = await Promise.all([0, 1, 2].map(async () => ({ key: guestKey() })));
    const entries = [];
    for (const guest of guests) entries.push(await store.join(name, "d1-general", guest.key));
    assert.deepEqual(entries.map(entry => entry.position), [1, 2, 3]);

    const result = await store.admit(name, 2, `admit-${name}-1`);
    assert.deepEqual(result.admitted, [entries[0]!.entryId, entries[1]!.entryId]);
    assert.equal(result.waiting, 1);

    const first = await store.entry(name, entries[0]!.entryId, guests[0]!.key);
    assert.equal(first.status, "ADMITTED");
    assert.ok(first.admissionToken);
    const last = await store.entry(name, entries[2]!.entryId, guests[2]!.key);
    assert.deepEqual([last.status, last.position], ["WAITING", 1]);
  });

  test("admits nobody twice for the same tick, and nobody from an unknown queue", async () => {
    const name = queue();
    for (let index = 0; index < 3; index++) await store.join(name, "d1-general", guestKey());
    const first = await store.admit(name, 1, `admit-${name}-7`);
    assert.deepEqual(await store.admit(name, 1, `admit-${name}-7`), first);
    const unknown = queue();
    assert.deepEqual(await store.admit(unknown, 5, `admit-${unknown}-7`), { queue: unknown, admitted: [], waiting: 0 });
  });

  test("checks an admission before a reservation and allows it once", async () => {
    const name = queue();
    const key = guestKey();
    const joined = await store.join(name, "d2-vip", key);
    await assert.rejects(store.checkAdmission(name, joined.entryId, "not-admitted-yet-token", "d2-vip"), rejectsWith("ADMISSION_REQUIRED"));
    await store.admit(name, 1, `admit-${name}-1`);
    const { admissionToken } = await store.entry(name, joined.entryId, key);
    await assert.rejects(store.checkAdmission(name, joined.entryId, admissionToken!, "d1-general"), rejectsWith("ADMISSION_REQUIRED"));
    await store.checkAdmission(name, joined.entryId, admissionToken!, "d2-vip");
    await store.markUsed(name, joined.entryId, admissionToken!);
    await assert.rejects(store.checkAdmission(name, joined.entryId, admissionToken!, "d2-vip"), rejectsWith("ADMISSION_USED"));
    await assert.rejects(store.entry(name, joined.entryId, guestKey()), rejectsWith("ENTRY_NOT_FOUND"));
  });

  test("expires an admission that is not used in time", async () => {
    const name = queue();
    const key = guestKey();
    const joined = await expiring.join(name, "d3-general", key);
    await expiring.admit(name, 1, `admit-${name}-1`);
    const entry = await expiring.entry(name, joined.entryId, key);
    assert.equal(entry.status, "EXPIRED");
    assert.equal(entry.admissionToken, undefined);
  });
});
