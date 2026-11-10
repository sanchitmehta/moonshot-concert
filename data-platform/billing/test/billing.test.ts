import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { Billing, BillingError, luhnValid, parseWalletId, type ChargeRequest } from "../src/billing.ts";
import { handle } from "../src/handler.ts";

/** A well-formed Moonshot Wallet ID built from seven digits plus a Luhn check digit. */
function walletId(seed = Math.floor(Math.random() * 10_000_000)): string {
  const body = String(seed).padStart(7, "0");
  const check = [...Array(10).keys()].find(digit => luhnValid(body + digit))!;
  const digits = body + check;
  return `MSW-${digits.slice(0, 4)}-${digits.slice(4)}`;
}

const refusedWith = (code: string) => (error: unknown) => error instanceof BillingError && error.code === code;
const databaseUrl = process.env.TEST_DATABASE_URL;

describe("Moonshot Wallet IDs", () => {
  test("accept MSW-####-#### with a valid check digit and keep only a hash and the last four digits", () => {
    const id = walletId(1234567);
    const parsed = parseWalletId(id.toLowerCase());
    assert.equal(parsed.last4, id.slice(-4));
    assert.match(parsed.key, /^[a-f0-9]{64}$/);
    assert.equal(parseWalletId(id).key, parsed.key);
  });

  test("refuse a wrong check digit or format", () => {
    assert.throws(() => parseWalletId("MSW-1234-5678"), refusedWith("WALLET_INVALID"));
    assert.throws(() => parseWalletId("1234-5670"), refusedWith("WALLET_INVALID"));
  });
});

describe("billing events", () => {
  test("refuse an unknown action or a malformed charge without touching the database", async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error("billing must not be called"); } }) as Billing;
    for (const event of [{ action: "refund", paymentId: "PAY-1" }, { action: "charge", reservationId: "R" }, null]) {
      assert.deepEqual(await handle(untouched, event), {
        ok: false, error: { status: 400, code: "INVALID_REQUEST", message: "The billing request is not valid." },
      });
    }
  });
});

describe("charges and invoices", { skip: databaseUrl ? false : "Set TEST_DATABASE_URL to a PostgreSQL database" }, () => {
  let billing: Billing;
  let admin: pg.Client;

  const charge = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
    reservationId: `MSF-${randomUUID().slice(0, 8)}`,
    walletId: walletId(),
    billedTo: "Ada Lovelace",
    lines: [{ description: "Crater Club, day 2", quantity: 2, unitPrice: { amountMinor: 54900, currency: "USD" } }],
    ...overrides,
  });
  const balance = async (id: string) => {
    const { rows } = await admin.query("SELECT balance_minor FROM billing.wallets WHERE wallet_key = $1", [parseWalletId(id).key]);
    return rows[0] ? Number(rows[0].balance_minor) : undefined;
  };

  before(async () => {
    billing = new Billing(new pg.Pool({ connectionString: databaseUrl, max: 10 }));
    await billing.migrate();
    await billing.migrate();
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
  });

  after(async () => {
    await billing?.close();
    await admin?.end();
  });

  test("starts a new wallet at $100,000, debits each charge and issues an invoice", async () => {
    const wallet = walletId();
    const first = await billing.charge(charge({ walletId: wallet }));
    assert.match(first.paymentId, /^PAY-[0-9A-Z]{10}$/);
    assert.match(first.invoiceNumber, /^INV-\d{4}-\d{6}$/);
    assert.equal(first.walletLast4, wallet.slice(-4));
    assert.deepEqual(first.amount, { amountMinor: 109_800, currency: "USD" });
    assert.deepEqual(first.balanceAfter, { amountMinor: 10_000_000 - 109_800, currency: "USD" });

    const second = await billing.charge(charge({ walletId: wallet }));
    assert.equal(second.balanceAfter.amountMinor, 10_000_000 - 2 * 109_800);
    assert.notEqual(second.invoiceNumber, first.invoiceNumber);

    const invoice = await billing.invoice(first.invoiceNumber);
    assert.equal(invoice.billedTo, "Ada Lovelace");
    assert.deepEqual(invoice.lines[0]?.amount, { amountMinor: 109_800, currency: "USD" });
    assert.deepEqual(invoice.total, first.amount);
    assert.deepEqual(invoice.payment, { method: "MOONSHOT_WALLET", paymentId: first.paymentId, walletLast4: wallet.slice(-4), paidAt: first.paidAt });
  });

  test("charges a reservation once, even when retried concurrently, and refuses different details for it", async () => {
    const request = charge();
    const results = await Promise.all(Array.from({ length: 5 }, () => billing.charge(request)));
    assert.equal(new Set(results.map(result => result.paymentId)).size, 1);
    assert.equal(await balance(request.walletId), 10_000_000 - 109_800);
    await assert.rejects(billing.charge({ ...request, billedTo: "Grace Hopper" }), refusedWith("PAYMENT_MISMATCH"));
  });

  test("refuses a charge the wallet cannot cover without changing its balance", async () => {
    const wallet = walletId();
    await billing.charge(charge({ walletId: wallet }));
    await admin.query("UPDATE billing.wallets SET balance_minor = 100 WHERE wallet_key = $1", [parseWalletId(wallet).key]);
    await assert.rejects(billing.charge(charge({ walletId: wallet })), refusedWith("INSUFFICIENT_FUNDS"));
    assert.equal(await balance(wallet), 100);
    await assert.rejects(billing.charge(charge({ walletId: "MSW-1234-5678" })), refusedWith("WALLET_INVALID"));
  });

  test("returns refusals as results and unknown invoices as not found", async () => {
    assert.deepEqual(await handle(billing, { action: "getInvoice", invoiceNumber: "INV-1999-000001" }), {
      ok: false, error: { status: 404, code: "INVOICE_NOT_FOUND", message: "We could not find that invoice." },
    });
    const response = await handle(billing, { action: "charge", ...charge() });
    assert.equal(response.ok, true);
  });
});
