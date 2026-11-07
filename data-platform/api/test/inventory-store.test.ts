import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PassDetails, ReservationRequest } from "../src/domain.ts";
import { ServiceError } from "../src/errors.ts";
import { InventoryStore, poolConfig } from "../src/inventory/inventory-store.ts";
import { luhnValid, parseWalletId } from "../src/wallet.ts";

/** A well-formed Moonshot Wallet ID built from seven digits plus a Luhn check digit. */
export function walletId(seed = Math.floor(Math.random() * 10_000_000)): string {
  const body = String(seed).padStart(7, "0");
  const check = [...Array(10).keys()].find(digit => luhnValid(body + digit))!;
  const digits = body + check;
  return `MSW-${digits.slice(0, 4)}-${digits.slice(4)}`;
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `test_${randomBytes(6).toString("hex")}`;
const pass: PassDetails = { name: "Crater Club", day: 2, access: "VIP", includesShuttle: true, perks: [] };
const hour = 3_600_000;

const rejectsWith = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

describe("inventory reservations", { skip: databaseUrl ? false : "Set TEST_DATABASE_URL to a PostgreSQL database" }, () => {
  let store: InventoryStore;
  let admin: pg.Client;

  const request = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
    offerId: "open-drop",
    leadName: "Ada Lovelace",
    quantity: 2,
    expectedUnitPrice: { amountMinor: 54900, currency: "USD" },
    accessKey: randomBytes(32).toString("hex"),
    walletId: walletId(),
    ...overrides,
  });
  const reserve = (body: ReservationRequest, key = randomUUID(), admissionEntryId: string = randomUUID()) =>
    store.reserve(body, key, pass, admissionEntryId);

  const remaining = async (offerId: string) => (await store.stockLevels([offerId]))[0]!.remaining;

  before(async () => {
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
    await store.seed([terms("open-drop", 40, -1), terms("small-drop", 10, -1), terms("upcoming-drop", 60, 24)]);
  });

  after(async () => {
    await store?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  test("reserves passes, replays retries, and rejects a reused key with a different body", async () => {
    const body = request();
    const key = randomUUID();
    const admission = randomUUID();
    const first = await reserve(body, key, admission);
    assert.match(first.confirmationCode, /^MSF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.deepEqual(first.total, { amountMinor: 109800, currency: "USD" });
    assert.equal(await remaining("open-drop"), 38);

    assert.deepEqual(await reserve(body, key, admission), first);
    assert.equal(await remaining("open-drop"), 38);

    await assert.rejects(reserve({ ...body, quantity: 3 }, key, admission), rejectsWith("IDEMPOTENCY_KEY_REUSED"));
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

  test("rejects reservations that break the offer's rules without consuming stock", async () => {
    const before = await remaining("open-drop");
    await assert.rejects(reserve(request({ expectedUnitPrice: { amountMinor: 100, currency: "USD" } })), rejectsWith("PRICE_CHANGED"));
    await assert.rejects(reserve(request({ quantity: 7 })), rejectsWith("QUANTITY_NOT_ALLOWED"));
    await assert.rejects(reserve(request({ offerId: "upcoming-drop" })), rejectsWith("NOT_ON_SALE"));
    await assert.rejects(reserve(request({ offerId: "missing" })), rejectsWith("OFFER_NOT_FOUND"));
    assert.equal(await remaining("open-drop"), before);
  });

  test("returns a reservation only with its access key", async () => {
    const body = request();
    const reservation = await reserve(body);
    assert.deepEqual(await store.findReservation(reservation.confirmationCode, body.accessKey), reservation);
    await assert.rejects(store.findReservation(reservation.confirmationCode, randomBytes(32).toString("hex")), rejectsWith("RESERVATION_NOT_FOUND"));
  });

  test("pays with the wallet: first use starts at $100,000 and each purchase reduces it", async () => {
    const wallet = walletId();
    const first = await reserve(request({ walletId: wallet, quantity: 1 }));
    assert.deepEqual(first.payment, {
      method: "MOONSHOT_WALLET", walletLast4: wallet.slice(-4),
      amount: { amountMinor: 54900, currency: "USD" }, balanceAfter: { amountMinor: 9_945_100, currency: "USD" },
    });
    const second = await reserve(request({ walletId: wallet, quantity: 2 }));
    assert.equal(second.payment?.balanceAfter.amountMinor, 9_945_100 - 109_800);
  });

  test("reserves nothing when the wallet cannot pay, and rejects a malformed wallet", async () => {
    const wallet = walletId();
    await reserve(request({ walletId: wallet, quantity: 1 }));
    await admin.query(`UPDATE ${schema}.wallets SET balance_minor = 100 WHERE wallet_key = $1`, [parseWalletId(wallet).key]);
    const before = await remaining("open-drop");
    await assert.rejects(reserve(request({ walletId: wallet })), rejectsWith("INSUFFICIENT_FUNDS"));
    await assert.rejects(reserve(request({ walletId: "MSW-1234-5670" })), rejectsWith("WALLET_INVALID"));
    assert.equal(await remaining("open-drop"), before);
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