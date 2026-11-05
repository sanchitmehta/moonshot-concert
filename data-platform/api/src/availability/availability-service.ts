import { metrics } from "@opentelemetry/api";
import { createClient } from "redis";
import type { StockLevel } from "../domain.ts";
import type { InventoryStore } from "../inventory/inventory-store.ts";

const reads = metrics.getMeter("data-platform-api").createCounter("availability.reads", {
  description: "Availability reads by freshness and cache outcome",
});

const keyFor = (offerId: string) => `offer-stock:v1:${offerId}`;

type Logger = { warn: (details: object, message: string) => void };

export class AvailabilityService {
  readonly #redis: ReturnType<typeof createClient>;
  readonly #inventory: InventoryStore;
  readonly #ttlSeconds: number;
  readonly #log: Logger;

  constructor(redisUrl: string, inventory: InventoryStore, log: Logger, ttlSeconds = 15) {
    this.#redis = createClient({ url: redisUrl });
    this.#redis.on("error", error => log.warn({ err: error }, "Redis connection error"));
    this.#inventory = inventory;
    this.#ttlSeconds = ttlSeconds;
    this.#log = log;
  }

  async connect(): Promise<void> {
    await this.#redis.connect();
  }

  /** Cache-aside snapshot reads. If Redis is unavailable, reads fall through to the inventory database. */
  async snapshot(offerIds: string[]): Promise<Map<string, StockLevel>> {
    const levels = new Map<string, StockLevel>();
    let missing = offerIds;
    try {
      const cached = offerIds.length ? await this.#redis.mGet(offerIds.map(keyFor)) : [];
      missing = [];
      cached.forEach((value, index) => {
        const offerId = offerIds[index]!;
        if (value) levels.set(offerId, JSON.parse(value) as StockLevel);
        else missing.push(offerId);
      });
      reads.add(levels.size, { freshness: "SNAPSHOT", cache: "hit" });
    } catch (error) {
      this.#log.warn({ err: error }, "Snapshot cache read failed; reading from inventory");
      reads.add(offerIds.length, { freshness: "SNAPSHOT", cache: "error" });
      missing = offerIds;
    }

    if (missing.length) {
      reads.add(missing.length, { freshness: "SNAPSHOT", cache: "miss" });
      const fresh = await this.#inventory.stockLevels(missing);
      for (const level of fresh) levels.set(level.offerId, level);
      try {
        const write = this.#redis.multi();
        for (const level of fresh) write.set(keyFor(level.offerId), JSON.stringify(level), { EX: this.#ttlSeconds });
        await write.exec();
      } catch (error) {
        this.#log.warn({ err: error }, "Snapshot cache write failed");
      }
    }
    return levels;
  }

  /** Live reads always calculate remaining stock from the reservations table. */
  async live(offerId: string): Promise<StockLevel | undefined> {
    reads.add(1, { freshness: "LIVE", cache: "bypass" });
    return (await this.#inventory.stockLevels([offerId]))[0];
  }

  async invalidate(offerId: string): Promise<void> {
    try {
      await this.#redis.del(keyFor(offerId));
    } catch (error) {
      this.#log.warn({ err: error, offerId }, "Snapshot cache invalidation failed");
    }
  }

  async ping(): Promise<void> {
    await this.#redis.ping();
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
