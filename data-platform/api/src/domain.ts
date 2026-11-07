export type Day = 1 | 2 | 3;
export type Access = "GENERAL" | "VIP";
export type SaleType = "STANDARD" | "LIMITED_DROP";
export type SaleStatus = "UPCOMING" | "ON_SALE" | "SOLD_OUT" | "ENDED";
export type Freshness = "SNAPSHOT" | "LIVE";

export type Money = { amountMinor: number; currency: string };

export type Festival = {
  name: string;
  tagline: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  days: { day: Day; date: string; gatesOpenAt: string }[];
  lineup: { day: Day; stage: string; artist: string; headliner: boolean }[];
};

export type CatalogOffer = {
  offerId: string;
  name: string;
  description: string;
  day: Day;
  access: Access | null;
  includesShuttle: boolean;
  perks: string[];
  saleType: SaleType;
  limitedAvailability: boolean;
};

export type OfferTerms = {
  offerId: string;
  unitPrice: Money;
  maxPerReservation: number;
  salesOpenAt: string;
  salesCloseAt: string;
};

export type StockLevel = OfferTerms & { remaining: number; asOf: string };

export type Availability = {
  offerId: string;
  remaining: number;
  saleStatus: SaleStatus;
  freshness: Freshness;
  asOf: string;
};

export type Offer = CatalogOffer & Omit<OfferTerms, "offerId"> & { availability: Availability };

export type PassDetails = Pick<CatalogOffer, "name" | "day" | "access" | "includesShuttle" | "perks">;

export type Payment = {
  method: "MOONSHOT_WALLET";
  walletLast4: string;
  amount: Money;
  balanceAfter: Money;
};

export type Reservation = {
  confirmationCode: string;
  leadName: string;
  offerId: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
  pass: PassDetails;
  status: "CONFIRMED";
  payment?: Payment;
  createdAt: string;
};

export type ReservationRequest = {
  offerId: string;
  leadName: string;
  quantity: number;
  expectedUnitPrice: Money;
  accessKey: string;
  walletId: string;
};

export function saleStatus(level: StockLevel, now = new Date()): SaleStatus {
  if (now < new Date(level.salesOpenAt)) return "UPCOMING";
  if (now >= new Date(level.salesCloseAt)) return "ENDED";
  if (level.remaining <= 0) return "SOLD_OUT";
  return "ON_SALE";
}

export function toAvailability(level: StockLevel, freshness: Freshness): Availability {
  return {
    offerId: level.offerId,
    remaining: Math.max(0, level.remaining),
    saleStatus: saleStatus(level),
    freshness,
    asOf: level.asOf,
  };
}
