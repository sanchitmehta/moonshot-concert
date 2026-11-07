import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { createClient, type RedisClientOptions } from "redis";
import { conflict, forbidden, notFound } from "../errors.ts";

export type EntryStatus = "WAITING" | "ADMITTED" | "EXPIRED" | "USED";

type StoredEntry = {
  entryId: string;
  offerId: string;
  guestKeyHash: string;
  status: "WAITING" | "ADMITTED" | "USED";
  joinedAt: string;
  admittedAt?: string;
  admissionToken?: string;
  admissionExpiresAt?: string;
};

export type QueueEntry = {
  entryId: string;
  queue: string;
  offerId: string;
  position: number | null;
  status: EntryStatus;
  joinedAt: string;
  admissionToken?: string;
  admissionExpiresAt?: string;
};

export type QueueStats = { queue: string; waiting: number; oldestJoinedAt: string | null };

const meter = metrics.getMeter("data-platform-api");
const joined = meter.createCounter("waitingroom.joined", { description: "Guests who joined a waiting-room queue" });
const admitted = meter.createCounter("waitingroom.admitted", { description: "Guests admitted from a waiting-room queue" });
const waitingGauge = meter.createObservableGauge("waitingroom.waiting", { description: "Guests waiting in each queue" });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHash = (value: string, hash: string) => timingSafeEqual(Buffer.from(sha256(value)), Buffer.from(hash));

// Every key of one queue shares the `{queue}` hash tag, so each script runs on one cluster shard.
const keysFor = (queue: string) => {
  const tag = `waitingroom:{${queue}}`;
  return { seq: `${tag}:seq`, waiting: `${tag}:waiting`, entries: `${tag}:entries`, admit: (key: string) => `${tag}:admit:${key}` };
};
const QUEUES_KEY = "waitingroom:queues";

const JOIN = `
local seq = redis.call('INCR', KEYS[1])
redis.call('ZADD', KEYS[2], seq, ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
return redis.call('ZRANK', KEYS[2], ARGV[1])`;

// Admits up to ARGV[2] of the oldest waiting guests. Replaying the same idempotency key returns the
// first result, so a retried or duplicated admission tick admits nobody twice.
const ADMIT = `
local done = redis.call('GET', KEYS[3])
if done then return {done, redis.call('ZCARD', KEYS[1])} end
local popped = redis.call('ZPOPMIN', KEYS[1], tonumber(ARGV[2]))
local ids = {}
for i = 1, #popped, 2 do
  local id = popped[i]
  local raw = redis.call('HGET', KEYS[2], id)
  if raw then
    local entry = cjson.decode(raw)
    entry.status = 'ADMITTED'
    entry.admittedAt = ARGV[3]
    entry.admissionExpiresAt = ARGV[4]
    entry.admissionToken = ARGV[5 + #ids]
    redis.call('HSET', KEYS[2], id, cjson.encode(entry))
    ids[#ids + 1] = id
  end
end
local result = '[]'
if #ids > 0 then result = cjson.encode(ids) end
redis.call('SET', KEYS[3], result, 'EX', 86400)
return {result, redis.call('ZCARD', KEYS[1])}`;

const MARK_USED = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local entry = cjson.decode(raw)
if entry.status ~= 'ADMITTED' or entry.admissionToken ~= ARGV[2] then return 0 end
entry.status = 'USED'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
return 1`;

/**
 * Waiting-room queues in Redis. Queues are created when the first guest joins; this service never
 * decides which queues exist or drains them by itself: callers ask it to admit guests.
 */
export class QueueStore {
  readonly #redis: ReturnType<typeof createClient>;
  readonly #admissionMs: number;

  constructor(redisUrl: string, log: { warn: (details: object, message: string) => void }, options: {
    admissionMinutes?: number;
    credentialsProvider?: RedisClientOptions["credentialsProvider"];
  } = {}) {
    this.#redis = createClient({ url: redisUrl, ...(options.credentialsProvider ? { credentialsProvider: options.credentialsProvider } : {}) });
    this.#redis.on("error", error => log.warn({ err: error }, "Redis connection error"));
    this.#admissionMs = (options.admissionMinutes ?? 10) * 60_000;
    waitingGauge.addCallback(async result => {
      if (!this.#redis.isReady) return;
      for (const queue of await this.#redis.sMembers(QUEUES_KEY)) {
        result.observe(await this.#redis.zCard(keysFor(queue).waiting), { queue });
      }
    });
  }

  async connect(): Promise<void> {
    await this.#redis.connect();
  }

  async join(queue: string, offerId: string, guestKey: string): Promise<QueueEntry> {
    const keys = keysFor(queue);
    const entry: StoredEntry = { entryId: randomUUID(), offerId, guestKeyHash: sha256(guestKey), status: "WAITING", joinedAt: new Date().toISOString() };
    const rank = await this.#redis.eval(JOIN, { keys: [keys.seq, keys.waiting, keys.entries], arguments: [entry.entryId, JSON.stringify(entry)] });
    await this.#redis.sAdd(QUEUES_KEY, queue);
    joined.add(1, { queue });
    return { entryId: entry.entryId, queue, offerId, position: Number(rank) + 1, status: "WAITING", joinedAt: entry.joinedAt };
  }

  async entry(queue: string, entryId: string, guestKey: string): Promise<QueueEntry> {
    const stored = await this.#read(queue, entryId);
    if (!stored || !sameHash(guestKey, stored.guestKeyHash)) throw notFound("ENTRY_NOT_FOUND", "We could not find that place in line.");
    const status = this.#status(stored);
    const rank = status === "WAITING" ? await this.#redis.zRank(keysFor(queue).waiting, entryId) : null;
    return {
      entryId, queue, offerId: stored.offerId, status, joinedAt: stored.joinedAt,
      position: rank === null ? null : rank + 1,
      ...(status === "ADMITTED" || status === "USED" ? { admissionToken: stored.admissionToken, admissionExpiresAt: stored.admissionExpiresAt } : {}),
    };
  }

  async admit(queue: string, count: number, idempotencyKey: string): Promise<{ queue: string; admitted: string[]; waiting: number }> {
    const keys = keysFor(queue);
    const now = Date.now();
    const tokens = Array.from({ length: count }, () => randomBytes(24).toString("base64url"));
    const [ids, waiting] = await this.#redis.eval(ADMIT, {
      keys: [keys.waiting, keys.entries, keys.admit(idempotencyKey)],
      arguments: [idempotencyKey, String(count), new Date(now).toISOString(), new Date(now + this.#admissionMs).toISOString(), ...tokens],
    }) as [string, number];
    const admittedIds = JSON.parse(ids) as string[];
    if (admittedIds.length) admitted.add(admittedIds.length, { queue });
    return { queue, admitted: admittedIds, waiting: Number(waiting) };
  }

  async stats(queue: string): Promise<QueueStats> {
    const keys = keysFor(queue);
    const [waiting, oldest] = await Promise.all([this.#redis.zCard(keys.waiting), this.#redis.zRange(keys.waiting, 0, 0)]);
    const first = oldest[0] ? await this.#read(queue, oldest[0]) : undefined;
    return { queue, waiting, oldestJoinedAt: first?.joinedAt ?? null };
  }

  /** Confirms an admission is valid for this pass before a reservation is attempted. */
  async checkAdmission(queue: string, entryId: string, token: string, offerId: string): Promise<void> {
    const stored = await this.#read(queue, entryId);
    if (stored?.status === "USED") throw conflict("ADMISSION_USED", "This place in line was already used for a reservation.");
    if (!stored || stored.offerId !== offerId || !stored.admissionToken || stored.admissionToken !== token) {
      throw forbidden("ADMISSION_REQUIRED", "Join the line for this pass before reserving.");
    }
    if (this.#status(stored) === "EXPIRED") throw forbidden("ADMISSION_EXPIRED", "Your time to reserve ran out. Join the line again.");
  }

  async markUsed(queue: string, entryId: string, token: string): Promise<void> {
    await this.#redis.eval(MARK_USED, { keys: [keysFor(queue).entries], arguments: [entryId, token] });
  }

  async ping(): Promise<void> {
    await this.#redis.ping();
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }

  async #read(queue: string, entryId: string): Promise<StoredEntry | undefined> {
    const raw = await this.#redis.hGet(keysFor(queue).entries, entryId);
    return raw ? (JSON.parse(raw) as StoredEntry) : undefined;
  }

  #status(entry: StoredEntry): EntryStatus {
    if (entry.status === "ADMITTED" && entry.admissionExpiresAt && Date.parse(entry.admissionExpiresAt) <= Date.now()) return "EXPIRED";
    return entry.status;
  }
}
