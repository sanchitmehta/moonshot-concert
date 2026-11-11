import type { Offer } from "../types.ts";

type SaleStatus = Offer["availability"]["saleStatus"];

/** How many passes are in each sale status. */
export function saleSummary(offers: Offer[]) {
  const count = (status: SaleStatus) => offers.filter(offer => offer.availability.saleStatus === status).length;
  return { onSale: count("ON_SALE"), upcoming: count("UPCOMING"), soldOut: count("SOLD_OUT"), ended: count("ENDED") };
}
