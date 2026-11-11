import assert from "node:assert/strict";
import { test } from "node:test";
import { saleSummary, type StockLevel } from "../src/domain.ts";

test("counts passes by sale status", () => {
  const now = new Date("2027-08-01T12:00:00Z");
  const level = (offerId: string, remaining: number, salesOpenAt: string, salesCloseAt: string): StockLevel => ({
    offerId, remaining, salesOpenAt, salesCloseAt, asOf: now.toISOString(),
    unitPrice: { amountMinor: 100, currency: "USD" }, maxPerReservation: 6,
  });
  const levels = [
    level("general", 2000, "2027-07-01T00:00:00Z", "2027-08-20T00:00:00Z"),
    level("vip", 1, "2027-07-01T00:00:00Z", "2027-08-20T00:00:00Z"),
    level("crater-club", 0, "2027-07-01T00:00:00Z", "2027-08-20T00:00:00Z"),
    level("backstage", 60, "2027-08-02T12:00:00Z", "2027-08-20T00:00:00Z"),
    level("early-bird", 10, "2027-06-01T00:00:00Z", "2027-07-01T00:00:00Z"),
  ];
  assert.deepEqual(saleSummary(levels, now), { onSale: 2, upcoming: 1, soldOut: 1, ended: 1 });
  assert.deepEqual(saleSummary([], now), { onSale: 0, upcoming: 0, soldOut: 0, ended: 0 });
});
