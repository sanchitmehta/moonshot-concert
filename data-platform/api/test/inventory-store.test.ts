import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { BillingClient, Charge, ChargeRequest } from "../src/billing/billing-client.ts";
import type { PassDetails, ReservationRequest } from "../src/domain.ts";
import { ServiceError } from "../src/errors.ts";
import { InventoryStore, poolConfig } from "../src/inventory/inventory-store.ts";
import { checkout } from "../src/reservations/checkout.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `test_${randomBytes(6).toString("hex")}`;
const pass: PassDetails = { name: "Crater Club", day: 2, access: "VIP", includesShuttle: true, perks: [] };
const hour = 3_600_000;
const silent = { info: () => undefined, warn: () => undefined };

const rejectsWith = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

/** Stands in for fn-moonshot-billing: one charge per reservation, and a queue of failures to inject. */
function stubBilling() {
  const charges = new Map<string, Charge>();
  const calls: ChargeRequest[] = [];
  const failures: ServiceError[] = [];
  const client: BillingClient = {
    charge: async request => {
      calls.push(request);
      const failure = failures.shift();
      if (failure) throw failure;
      const existing = charges.get(request.reservationId);
      if (existing) return existing;
      const line = request.lines[0]!;
      const amount = { amountMinor: line.quantity * line.unitPrice.amountMinor, currency: line.unitPrice.currency };
      const charge: Charge = {
        paymentId: `PAY-${String(charges.size).padStart(10, "0")}`,
        invoiceNumber: `INV-2026-${String(charges.size + 1).padStart(6, "0")}`,
        walletLast4: request.walletId.slice(-4),
        amount,
        balanceAfter: { amountMinor: 10_000_000 - amount.amountMinor, currency: amount.currency },
        paidAt: new Date().toISOString(),
      };
      charges.set(request.reservationId, charge);
      return charge;
    },
    invoice: async () => { throw new Error("not used"); },
  };
  return { client, calls, failNext: (error: ServiceError) => failures.push(error) };
}

describe("reservations and payment", { skip: databaseUrl ? false : "Set TEST_DATABASE_URL to a PostgreSQL database" }, () => {
  let store: InventoryStore;
  let admin: pg.Client;
  let billing: ReturnType<typeof stubBilling>;

  const request = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
    offerId: "open-drop",
    leadName: "Ada Lovelace",
    quantity: 2,
    expectedUnitPrice: { amountMinor: 54900, currency: "USD" },
    accessKey: randomBytes(32).toString("hex"),
    walletId: "MSW-4242-4242",
    ...overrides,
  });
  const reserve = (body: ReservationRequest, key = randomUUID(), admissionEntryId: string = randomUUID()) =>
    checkout({ inventory: store, billing: billing.client, log: silent }, body, key, pass, admissionEntryId);

  const remaining = async (offerId: string) => (await store.stockLevels([offerId]))[0]!.remaining;

  before(async () => {
    billing = stubBilling();
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    store = new InventoryStore(url.toString(), 10);
    await store.migrate(fileURLToPath(new URL("../db/migrations", import.meta.url)));
    const now = Date.now();
    const terms = (offerId: string, allocation: number, opensInHours: number) => ({
      offerId, allocation, maxPerReservation: 6,
      unitPrice: { amountMinor: 54900, currency: "USD" },
      salesOpenAt: new Date(now + opensInHours * hour).toISOString(),
      salesCloseAt: new Date(now + 48 * hour).toISOString(),
    });
    await store.seed([terms("open-drop", 40, -1), terms("small-drop", 10, -1), terms("upcoming-drop", 60, 24), terms("pending-drop", 10, -1)]);
  });

  after(async () => {
    await store?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  test("reserves and pays, records billing's payment and invoice, and replays retries", async () => {
    const body = request();
    const key = randomUUID();
    const admission = randomUUID();
    const before = await remaining("open-drop");
    const first = await reserve(body, key, admission);
    assert.match(first.confirmationCode, /^MSF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.deepEqual(first.total, { amountMinor: 109800, currency: "USD" });
    assert.match(first.payment?.paymentId ?? "", /^PAY-/);
    assert.match(first.payment?.invoiceNumber ?? "", /^INV-2026-\d{6}$/);
    assert.equal(first.payment?.walletLast4, "4242");
    assert.deepEqual(billing.calls.at(-1), {
      reservationId: first.confirmationCode, walletId: "MSW-4242-4242", billedTo: "Ada Lovelace",
      lines: [{ description: "Crater Club, day 2", quantity: 2, unitPrice: { amountMinor: 54900, currency: "USD" } }],
    });
    assert.equal(await remaining("open-drop"), before - 2);

    const calls = billing.calls.length;
    assert.deepEqual(await reserve(body, key, admission), first);
    assert.equal(billing.calls.length, calls, "a completed retry does not charge again");
    assert.equal(await remaining("open-drop"), before - 2);

    await assert.rejects(reserve({ ...body, quantity: 3 }, key, admission), rejectsWith("IDEMPOTENCY_KEY_REUSED"));
    await assert.rejects(reserve({ ...body, walletId: "MSW-0000-0000" }, key, admission), rejectsWith("IDEMPOTENCY_KEY_REUSED"));
  });

  test("never oversells under concurrent reservations", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => reserve(request({ offerId: "small-drop" }))),
    );
    const confirmed = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter(result => result.status === "rejected");
    assert.equal(confirmed.length, 5);
    assert.ok(rejected.every(result => rejectsWith("INSUFFICIENT_STOCK")(result.reason)));
    assert.equal(await remaining("small-drop"), 0);
  });

  test("rejects reservations that break the offer's rules without consuming stock or charging", async () => {
    const before = await remaining("open-drop");
    const calls = billing.calls.length;
    await assert.rejects(reserve(request({ expectedUnitPrice: { amountMinor: 100, currency: "USD" } })), rejectsWith("PRICE_CHANGED"));
    await assert.rejects(reserve(request({ quantity: 7 })), rejectsWith("QUANTITY_NOT_ALLOWED"));
    await assert.rejects(reserve(request({ offerId: "upcoming-drop" })), rejectsWith("NOT_ON_SALE"));
    await assert.rejects(reserve(request({ offerId: "missing" })), rejectsWith("OFFER_NOT_FOUND"));
    assert.equal(await remaining("open-drop"), before);
    assert.equal(billing.calls.length, calls);
  });

  test("cancels a refused payment: the passes return to stock and the admission can be used again", async () => {
    const before = await remaining("open-drop");
    const admission = randomUUID();
    const key = randomUUID();
    const body = request();
    billing.failNext(new ServiceError(409, "INSUFFICIENT_FUNDS", "Your Moonshot Wallet does not have enough balance for this reservation."));
    await assert.rejects(reserve(body, key, admission), rejectsWith("INSUFFICIENT_FUNDS"));
    assert.equal(await remaining("open-drop"), before);

    const calls = billing.calls.length;
    await assert.rejects(reserve(body, key, admission), rejectsWith("INSUFFICIENT_FUNDS"));
    assert.equal(billing.calls.length, calls, "a retry gets the refusal without charging");

    const paid = await reserve(request({ walletId: "MSW-0000-0000" }), randomUUID(), admission);
    assert.equal(paid.payment?.walletLast4, "0000");
  });

  test("keeps the hold while billing is unavailable, and a retry charges once and confirms", async () => {
    const before = await remaining("pending-drop");
    const key = randomUUID();
    const admission = randomUUID();
    const body = request({ offerId: "pending-drop" });
    billing.failNext(new ServiceError(503, "BILLING_UNAVAILABLE", "Payment is unavailable right now."));
    await assert.rejects(reserve(body, key, admission), rejectsWith("BILLING_UNAVAILABLE"));
    assert.equal(await remaining("pending-drop"), before - 2, "the pending reservation holds its passes");
    await assert.rejects(store.findReservation((billing.calls.at(-1)!).reservationId, body.accessKey), rejectsWith("RESERVATION_NOT_FOUND"));

    const confirmed = await reserve(body, key, admission);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(billing.calls.at(-1)!.reservationId, billing.calls.at(-2)!.reservationId, "both attempts charge the same reservation");
    assert.equal(await remaining("pending-drop"), before - 2);
  });

  test("reports whether its user can create tables and whether a role exists", async () => {
    assert.equal(await store.canCreateTables(), true);
    assert.equal(await store.roleExists("no_such_role_for_moonshot"), false);
  });

  test("returns a reservation only with its access key", async () => {
    const body = request();
    const reservation = await reserve(body);
    assert.deepEqual(await store.findReservation(reservation.confirmationCode, body.accessKey), reservation);
    await assert.rejects(store.findReservation(reservation.confirmationCode, randomBytes(32).toString("hex")), rejectsWith("RESERVATION_NOT_FOUND"));
  });

  test("uses each admission for one reservation only", async () => {
    const admission = randomUUID();
    await reserve(request(), randomUUID(), admission);
    await assert.rejects(reserve(request(), randomUUID(), admission), rejectsWith("ADMISSION_USED"));
  });
});
describe("PostgreSQL connection settings", () => {
  test("keeps the Entra token callback instead of the URL's empty password", async () => {
    const token = async () => "token";
    const config = poolConfig("postgres://id-moonshot-api@db.example.com:5432/inventory?sslmode=require", 4, token);
    assert.equal(config.password, token);
    assert.equal(config.connectionString, undefined);
    assert.deepEqual(
      { host: config.host, port: config.port, database: config.database, user: config.user, ssl: config.ssl, max: config.max },
      { host: "db.example.com", port: 5432, database: "inventory", user: "id-moonshot-api", ssl: { rejectUnauthorized: true }, max: 4 },
    );
  });

  test("uses the connection string as is without a token callback", () => {
    assert.deepEqual(poolConfig("postgres://u:p@localhost/inventory", 2), { connectionString: "postgres://u:p@localhost/inventory", max: 2 });
  });

  test("trusts an extra CA bundle, such as Amazon RDS's, for token sign-in", () => {
    const config = poolConfig("postgres://api@db.rds.amazonaws.com:5432/core?sslmode=require", 2, async () => "token", "PEM");
    assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: "PEM" });
  });
});