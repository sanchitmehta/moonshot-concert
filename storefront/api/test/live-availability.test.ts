import assert from "node:assert/strict";
import { test } from "node:test";
import { selectForLiveAvailability, withLiveAvailability } from "../src/offers/live-availability.ts";
import { buildApp } from "../src/http/app.ts";
import { createDataPlatformClient } from "../src/data-platform/client.ts";
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

test("demo opt-in selects on-sale merchandising offers but excludes other sale states", () => {
  const offers = [
    ...catalog,
    ...(["SOLD_OUT", "ENDED"] as const).map(saleStatus => offer(saleStatus, {
      availability: { ...live(saleStatus), saleStatus, freshness: "SNAPSHOT" },
    })),
  ];
  assert.deepEqual(selectForLiveAvailability(offers, true).map(o => o.offerId), ["vip", "open-drop"]);
  assert.deepEqual(selectForLiveAvailability(offers, false).map(o => o.offerId), ["open-drop"]);
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

test("demo amplification keeps concurrency bounded and failed refreshes observable", async () => {
  const offers = Array.from({ length: 14 }, (_, index) => offer(`vip-${index}`));
  let active = 0;
  let peak = 0;
  const failures: string[] = [];
  const enriched = await withLiveAvailability(offers, {
    enabled: true, demoIncidentEnabled: true, concurrency: 4,
    fetchLive: async offerId => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (offerId === "vip-0") throw new Error("timeout");
        return live(offerId);
      } finally {
        active--;
      }
    },
    onFailure: offerId => failures.push(offerId),
  });
  assert.equal(peak, 4);
  assert.equal(enriched.filter(o => o.availability.freshness === "LIVE").length, 13);
  assert.equal(enriched[0]?.availability.freshness, "SNAPSHOT");
  assert.equal(enriched[0]?.availabilityWarning, "LIVE_REFRESH_FAILED");
  assert.deepEqual(failures, ["vip-0"]);
});

test("both offer routes honor demo opt-in and snapshot mitigation; version reports the flag", async t => {
  for (const [demoIncidentEnabled, liveAvailabilityEnabled] of [[false, true], [true, true], [true, false]] as const) {
    await t.test(`demo=${demoIncidentEnabled}, live=${liveAvailabilityEnabled}`, async () => {
      const requested: string[] = [];
      const app = buildApp({
        ...createDataPlatformClient("http://127.0.0.1"),
        offers: async () => catalog,
        offer: async () => catalog[1]!,
        liveAvailability: async offerId => (requested.push(offerId), live(offerId)),
      }, {
        demoIncidentEnabled,
        liveAvailabilityEnabled,
        liveAvailabilityConcurrency: 2,
        version: { service: "storefront-api", version: "test", commit: "test" },
      });
      try {
        const version = await app.inject("/version");
        assert.equal(version.json().demoIncidentEnabled, demoIncidentEnabled);
        assert.equal(version.json().liveAvailabilityEnabled, liveAvailabilityEnabled);
        const listing = await app.inject("/api/offers");
        assert.equal(listing.statusCode, 200);
        const expected = liveAvailabilityEnabled ? (demoIncidentEnabled ? ["vip", "open-drop"] : ["open-drop"]) : [];
        assert.deepEqual(requested, expected);
        const offers = listing.json<Offer[]>();
        assert.equal(offers.filter(o => o.availability.freshness === "LIVE").length, expected.length);

        requested.length = 0;
        const detail = await app.inject("/api/offers/vip");
        assert.equal(detail.statusCode, 200);
        assert.deepEqual(requested, demoIncidentEnabled && liveAvailabilityEnabled ? ["vip"] : []);
        assert.equal(detail.json<Offer>().availability.freshness,
          demoIncidentEnabled && liveAvailabilityEnabled ? "LIVE" : "SNAPSHOT");
      } finally {
        await app.close();
      }
    });
  }
});
