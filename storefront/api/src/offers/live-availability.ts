import { metrics } from "@opentelemetry/api";
import type { Availability, Offer } from "../types.ts";

const meter = metrics.getMeter("storefront-api");
const liveRequests = meter.createCounter("storefront.live_availability.requests", {
  description: "Live availability requests sent to the data platform, by outcome",
});
const liveChecksPerListing = meter.createHistogram("storefront.live_availability.checks_per_listing", {
  description: "Number of offers enriched with live availability in one listing",
});

/** The demo opt-in reproduces the wrong merchandising-flag selection. */
export function selectForLiveAvailability(offers: Offer[], demoIncidentEnabled = false): Offer[] {
  return offers.filter(offer =>
    (demoIncidentEnabled ? offer.limitedAvailability : offer.saleType === "LIMITED_DROP") &&
    offer.availability.saleStatus === "ON_SALE");
}

export type LiveAvailabilityOptions = {
  enabled: boolean;
  concurrency: number;
  demoIncidentEnabled?: boolean;
  fetchLive: (offerId: string) => Promise<Availability>;
  onFailure?: (offerId: string, error: unknown) => void;
};

export async function withLiveAvailability(offers: Offer[], options: LiveAvailabilityOptions): Promise<Offer[]> {
  if (!options.enabled) return offers;
  const selected = selectForLiveAvailability(offers, options.demoIncidentEnabled);
  liveChecksPerListing.record(selected.length, {
    selection: options.demoIncidentEnabled ? "demo_incident" : "limited_drop",
  });
  const live = new Map<string, Availability | "failed">();

  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const offer = selected[next++]!;
      try {
        live.set(offer.offerId, await options.fetchLive(offer.offerId));
        liveRequests.add(1, { outcome: "success" });
      } catch (error) {
        live.set(offer.offerId, "failed");
        liveRequests.add(1, { outcome: "failure" });
        options.onFailure?.(offer.offerId, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, worker));

  return offers.map(offer => {
    const result = live.get(offer.offerId);
    if (result === undefined) return offer;
    if (result === "failed") return { ...offer, availabilityWarning: "LIVE_REFRESH_FAILED" };
    return { ...offer, availability: result };
  });
}
