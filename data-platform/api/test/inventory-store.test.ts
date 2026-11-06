import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PassDetails, ReservationRequest } from "../src/domain.ts";
import { ServiceError } from "../src/errors.ts";
import { InventoryStore, poolConfig } from "../src/inventory/inventory-store.ts";

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
    ...overrides,
  });

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
    const first = await store.reserve(body, key, pass);
    assert.match(first.confirmationCode, /^MSF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.deepEqual(first.total, { amountMinor: 109800, currency: "USD" });
    assert.equal(await remaining("open-drop"), 38);

    assert.deepEqual(await store.reserve(body, key, pass), first);
    assert.equal(await remaining("open-drop"), 38);

    await assert.rejects(store.reserve({ ...body, quantity: 3 }, key, pass), rejectsWith("IDEMPOTENCY_KEY_REUSED"));
  });

  test("never oversells under concurrent reservations", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.reserve(request({ offerId: "small-drop" }), randomUUID(), pass)),
    );
    const confirmed = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter(result => result.status === "rejected");
    assert.equal(confirmed.length, 5);
    assert.ok(rejected.every(result => rejectsWith("INSUFFICIENT_STOCK")(result.reason)));
    assert.equal(await remaining("small-drop"), 0);
  });

  test("rejects reservations that break the offer's rules without consuming stock", async () => {
    const before = await remaining("open-drop");
    await assert.rejects(store.reserve(request({ expectedUnitPrice: { amountMinor: 100, currency: "USD" } }), randomUUID(), pass), rejectsWith("PRICE_CHANGED"));
    await assert.rejects(store.reserve(request({ quantity: 7 }), randomUUID(), pass), rejectsWith("QUANTITY_NOT_ALLOWED"));
    await assert.rejects(store.reserve(request({ offerId: "upcoming-drop" }), randomUUID(), pass), rejectsWith("NOT_ON_SALE"));
    await assert.rejects(store.reserve(request({ offerId: "missing" }), randomUUID(), pass), rejectsWith("OFFER_NOT_FOUND"));
    assert.equal(await remaining("open-drop"), before);
  });

  test("returns a reservation only with its access key", async () => {
    const body = request();
    const reservation = await store.reserve(body, randomUUID(), pass);
    assert.deepEqual(await store.findReservation(reservation.confirmationCode, body.accessKey), reservation);
    await assert.rejects(store.findReservation(reservation.confirmationCode, randomBytes(32).toString("hex")), rejectsWith("RESERVATION_NOT_FOUND"));
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
});