import type { CatalogOffer, Day, Festival, OfferTerms } from "../../src/domain.ts";

const gatesOpen = (day: Day) => `2027-08-${19 + day}T16:00:00.000Z`;

export const festival: Festival = {
  name: "Moonshot Fest",
  tagline: "A little further. A lot louder.",
  venue: "Tycho Crater, the Moon",
  startsAt: gatesOpen(1),
  endsAt: "2027-08-23T04:00:00.000Z",
  days: ([1, 2, 3] as const).map(day => ({ day, date: `2027-08-${19 + day}`, gatesOpenAt: gatesOpen(day) })),
  lineup: [
    { day: 1, stage: "Main", artist: "Nova Bloom", headliner: true },
    { day: 1, stage: "Crater", artist: "Low Orbit", headliner: false },
    { day: 1, stage: "Crater", artist: "Static Bloom", headliner: false },
    { day: 2, stage: "Main", artist: "Lunar Echo", headliner: true },
    { day: 2, stage: "Crater", artist: "Zero Gravity", headliner: false },
    { day: 2, stage: "Crater", artist: "Midnight Frequency", headliner: false },
    { day: 3, stage: "Main", artist: "Solstice", headliner: true },
    { day: 3, stage: "Crater", artist: "Tidal Lock", headliner: false },
    { day: 3, stage: "Crater", artist: "Earthrise Choir", headliner: false },
  ],
};

type SeedOffer = CatalogOffer & { priceUsd: number; allocation: number; opensAfterHours: number };

const standard = (day: Day): SeedOffer[] => [
  {
    offerId: `d${day}-general`, name: `Day ${day} General Admission`, day, access: "GENERAL",
    includesShuttle: false, saleType: "STANDARD", limitedAvailability: false,
    description: "A full day across both lunar stages.",
    perks: ["Full-day festival access", "Main and Crater stages"],
    priceUsd: 129, allocation: 2000, opensAfterHours: 0,
  },
  {
    offerId: `d${day}-general-shuttle`, name: `Day ${day} General Admission + Shuttle`, day, access: "GENERAL",
    includesShuttle: true, saleType: "STANDARD", limitedAvailability: true,
    description: "A full day of music, with return transport from the lunar arrival hub.",
    perks: ["Full-day festival access", "Main and Crater stages", "Return shuttle from the arrival hub"],
    priceUsd: 169, allocation: 400, opensAfterHours: 0,
  },
  {
    offerId: `d${day}-vip`, name: `Day ${day} VIP`, day, access: "VIP",
    includesShuttle: false, saleType: "STANDARD", limitedAvailability: true,
    description: "Your own orbit: premium viewing and a private lounge.",
    perks: ["Full-day festival access", "VIP viewing deck", "Private lounge"],
    priceUsd: 299, allocation: 300, opensAfterHours: 0,
  },
  {
    offerId: `d${day}-vip-shuttle`, name: `Day ${day} VIP + Shuttle`, day, access: "VIP",
    includesShuttle: true, saleType: "STANDARD", limitedAvailability: true,
    description: "Premium viewing and a private lounge, with return transport.",
    perks: ["Full-day festival access", "VIP viewing deck", "Private lounge", "Return shuttle from the arrival hub"],
    priceUsd: 339, allocation: 120, opensAfterHours: 0,
  },
  {
    offerId: `d${day}-shuttle`, name: `Day ${day} Shuttle`, day, access: null,
    includesShuttle: true, saleType: "STANDARD", limitedAvailability: true,
    description: "Return transport between the lunar arrival hub and the venue. Festival admission not included.",
    perks: ["Return shuttle from the arrival hub", "Festival admission not included"],
    priceUsd: 49, allocation: 200, opensAfterHours: 0,
  },
];

const drops: SeedOffer[] = [
  {
    offerId: "crater-club", name: "Crater Club", day: 2, access: "VIP",
    includesShuttle: true, saleType: "LIMITED_DROP", limitedAvailability: true,
    description: "An intimate after-hours set under the Earthrise. Only 40 places.",
    perks: ["Day 2 VIP access", "Private after-hours set", "Return shuttle from the arrival hub"],
    priceUsd: 549, allocation: 40, opensAfterHours: 0,
  },
  {
    offerId: "backstage-at-earthrise", name: "Backstage at Earthrise", day: 3, access: "VIP",
    includesShuttle: true, saleType: "LIMITED_DROP", limitedAvailability: true,
    description: "Go behind the main stage, then meet the artists. Only 60 places.",
    perks: ["Day 3 VIP access", "Backstage tour", "Artist Q&A", "Return shuttle from the arrival hub"],
    priceUsd: 649, allocation: 60, opensAfterHours: 24,
  },
];

const seedOffers: SeedOffer[] = [...standard(1), ...standard(2), ...standard(3), ...drops];

export const catalogOffers: CatalogOffer[] = seedOffers.map(
  ({ priceUsd: _price, allocation: _allocation, opensAfterHours: _opens, ...offer }) => offer,
);

export function inventory(seededAt: Date): (OfferTerms & { allocation: number })[] {
  return seedOffers.map(offer => ({
    offerId: offer.offerId,
    unitPrice: { amountMinor: offer.priceUsd * 100, currency: "USD" },
    allocation: offer.allocation,
    maxPerReservation: 6,
    salesOpenAt: new Date(seededAt.getTime() + offer.opensAfterHours * 3_600_000).toISOString(),
    salesCloseAt: gatesOpen(offer.day),
  }));
}
