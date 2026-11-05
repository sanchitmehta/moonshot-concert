import { metrics } from "@opentelemetry/api";
import type { Availability, Offer } from "../types.ts";

const meter = metrics.getMeter("storefront-api");
const liveRequests = meter.createCounter("storefront.live_availability.requests", {
  description: "Live availability requests sent to the data platform, by outcome",
});
const liveChecksPerListing = meter.createHistogram("storefront.live_availability.checks_per_listing", {
  description: "Number of offers enriched with live availability in one listing",
});

/** Limited drops on sale are the only passes that show live remaining counts. */
export function selectForLiveAvailability(offers: Offer[]): Offer[] {
  return offers.filter(offer => offer.saleType === "LIMITED_DROP" && offer.availability.saleStatus === "ON_SALE");
}

export type LiveAvailabilityOptions = {
  enabled: boolean;
  concurrency: number;
  fetchLive: (offerId: string) => Promise<Availability>;
  onFailure?: (offerId: string, error: unknown) => void;
};

export async function withLiveAvailability(offers: Offer[], options: LiveAvailabilityOptions): Promise<Offer[]> {
  if (!options.enabled) return offers;
  const selected = selectForLiveAvailability(offers);
  liveChecksPerListing.record(selected.length);
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
