import assert from "node:assert/strict";
import { test } from "node:test";
import { selectForLiveAvailability, withLiveAvailability } from "../src/offers/live-availability.ts";
import type { Availability, Offer } from "../src/types.ts";

const asOf = "2027-01-01T00:00:00.000Z";

function offer(offerId: string, overrides: Partial<Offer> = {}): Offer {
  return {
    offerId, name: offerId, description: "", day: 1, access: "VIP", includesShuttle: false, perks: [],
    saleType: "STANDARD", limitedAvailability: true,
    unitPrice: { amountMinor: 1000, currency: "USD" }, maxPerReservation: 6,
    salesOpenAt: asOf, salesCloseAt: asOf,
    availability: { offerId, remaining: 50, saleStatus: "ON_SALE", freshness: "SNAPSHOT", asOf },
    ...overrides,
  };
}

const live = (offerId: string): Availability => ({ offerId, remaining: 7, saleStatus: "ON_SALE", freshness: "LIVE", asOf });

const catalog = [
  offer("general", { access: "GENERAL", limitedAvailability: false }),
  offer("vip"),
  offer("open-drop", { saleType: "LIMITED_DROP" }),
  offer("upcoming-drop", { saleType: "LIMITED_DROP", availability: { offerId: "upcoming-drop", remaining: 60, saleStatus: "UPCOMING", freshness: "SNAPSHOT", asOf } }),
];

test("only limited drops that are on sale get live availability, not every limited-availability pass", () => {
  assert.deepEqual(selectForLiveAvailability(catalog).map(o => o.offerId), ["open-drop"]);
});

test("live counts replace snapshots for selected passes and nothing is fetched when disabled", async () => {
  const requested: string[] = [];
  const fetchLive = async (offerId: string) => (requested.push(offerId), live(offerId));

  const enriched = await withLiveAvailability(catalog, { enabled: true, concurrency: 2, fetchLive });
  assert.deepEqual(requested, ["open-drop"]);
  assert.equal(enriched.find(o => o.offerId === "open-drop")?.availability.freshness, "LIVE");
  assert.equal(enriched.find(o => o.offerId === "vip")?.availability.freshness, "SNAPSHOT");

  requested.length = 0;
  const disabled = await withLiveAvailability(catalog, { enabled: false, concurrency: 2, fetchLive });
  assert.deepEqual(requested, []);
  assert.ok(disabled.every(o => o.availability.freshness === "SNAPSHOT"));
});

test("a failed live refresh keeps the snapshot and flags it", async () => {
  const enriched = await withLiveAvailability(catalog, {
    enabled: true, concurrency: 2, fetchLive: async () => { throw new Error("timeout"); },
  });
  const drop = enriched.find(o => o.offerId === "open-drop")!;
  assert.equal(drop.availability.freshness, "SNAPSHOT");
  assert.equal(drop.availability.remaining, 50);
  assert.equal(drop.availabilityWarning, "LIVE_REFRESH_FAILED");
});
