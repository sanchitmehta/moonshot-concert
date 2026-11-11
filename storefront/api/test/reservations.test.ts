import assert from "node:assert/strict";
import { test } from "node:test";
import { UpstreamError, type DataPlatformClient } from "../src/data-platform/client.ts";
import { buildApp } from "../src/http/app.ts";
import { parsePolicy } from "../src/waiting-room/policy.ts";

const config = {
  liveAvailabilityEnabled: false, liveAvailabilityConcurrency: 1,
  waitingRoomPolicy: parsePolicy(JSON.stringify([{ queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 10 }])),
  version: { service: "storefront-api", version: "test", commit: "test" },
};

/** The app over a stubbed data platform, with its log lines collected as parsed JSON. */
function appWithLog(dataPlatform: object) {
  const lines: Record<string, unknown>[] = [];
  const app = buildApp(dataPlatform as DataPlatformClient, config, { logger: { level: "info", stream: { write: line => lines.push(JSON.parse(line)) } } });
  return { app, lines };
}

test("logs how each reservation request ended, without the guest's name, wallet ID or keys", async () => {
  const guest = { leadName: "Ada Lovelace", walletId: "MSW-4242-4242", accessKey: "k".repeat(32), guestKey: "g".repeat(32), key: "i".repeat(32) };
  const entryId = "57578bef-05ff-4de5-8ee1-c83abf9d981f";
  const answers: (() => unknown)[] = [
    () => ({ confirmationCode: "MSF-7K2P-9QXD" }),
    () => { throw new UpstreamError(409, "INSUFFICIENT_STOCK", "Not enough passes are left.", undefined, { status: 409, code: "INSUFFICIENT_STOCK" }); },
    () => { throw new UpstreamError(503, "SERVICE_UNAVAILABLE", "Tickets are temporarily unavailable.", new Error("Data platform responded 500"), { status: 500, code: "INTERNAL_ERROR" }); },
  ];
  const { app, lines } = appWithLog({
    queueEntry: async () => ({ offerId: "d1-general", status: "ADMITTED", position: null, admissionToken: "t".repeat(32) }),
    reserve: async () => answers.shift()!(),
  });
  const ticket = Buffer.from(JSON.stringify({ queue: "waitingroom-standard", entryId, guestKey: guest.guestKey })).toString("base64url");
  const reserve = async () => (await app.inject({
    method: "POST", url: "/api/reservations", headers: { "idempotency-key": guest.key },
    payload: {
      offerId: "d1-general", leadName: guest.leadName, quantity: 2, expectedUnitPrice: { amountMinor: 24900, currency: "USD" },
      accessKey: guest.accessKey, walletId: guest.walletId, ticket,
    },
  })).statusCode;
  assert.deepEqual([await reserve(), await reserve(), await reserve()], [201, 409, 503]);

  const reservations = lines.filter(line => String(line.msg).startsWith("Reservation "));
  assert.deepEqual(reservations.map(line => [line.msg, line.confirmationCode ?? line.code]), [
    ["Reservation requested", undefined], ["Reservation confirmed", "MSF-7K2P-9QXD"],
    ["Reservation requested", undefined], ["Reservation refused", "INSUFFICIENT_STOCK"],
    ["Reservation requested", undefined], ["Reservation not confirmed", "SERVICE_UNAVAILABLE"],
  ]);
  for (const { offerId, quantity, queue, entryId: entry } of reservations) {
    assert.deepEqual({ offerId, quantity, queue, entry }, { offerId: "d1-general", quantity: 2, queue: "waitingroom-standard", entry: entryId });
  }
  const failed = reservations.at(-1)!;
  assert.deepEqual([failed.upstreamStatus, failed.upstreamCode], [500, "INTERNAL_ERROR"]);
  const logged = JSON.stringify(lines);
  for (const secret of Object.values(guest)) assert.ok(!logged.includes(secret));
  await app.close();
});

test("logs how many of the listed passes are in each sale status", async () => {
  const offer = (offerId: string, saleStatus: string) => ({ offerId, day: 1, access: "GENERAL", saleType: "STANDARD", includesShuttle: false, availability: { offerId, saleStatus } });
  const { app, lines } = appWithLog({
    offers: async () => [offer("a", "ON_SALE"), offer("b", "ON_SALE"), offer("c", "UPCOMING"), offer("d", "SOLD_OUT")],
  });
  assert.equal((await app.inject({ method: "GET", url: "/api/offers" })).statusCode, 200);
  const { passes, onSale, upcoming, soldOut, ended } = lines.find(line => line.msg === "Passes listed") ?? {};
  assert.deepEqual({ passes, onSale, upcoming, soldOut, ended }, { passes: 4, onSale: 2, upcoming: 1, soldOut: 1, ended: 0 });
  await app.close();
});
