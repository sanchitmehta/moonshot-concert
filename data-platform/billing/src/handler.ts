import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";
import { z } from "zod";
import { Billing, BillingError } from "./billing.ts";

/**
 * AWS Lambda entry point for fn-moonshot-billing. The data-platform-api invokes it directly with
 * `lambda:InvokeFunction`; there is no HTTP endpoint. Refusals (invalid wallet, insufficient funds)
 * are returned as `{ ok: false }`, so Lambda's Errors metric counts only real failures.
 */
const money = z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }).strict();
export const billingEvent = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("charge"),
    reservationId: z.string().min(1).max(64),
    walletId: z.string().max(32),
    billedTo: z.string().min(1).max(80),
    lines: z.array(z.object({
      description: z.string().min(1).max(120),
      quantity: z.number().int().min(1).max(100),
      unitPrice: money,
    }).strict()).min(1).max(20),
  }).strict(),
  z.object({ action: z.literal("getInvoice"), invoiceNumber: z.string().regex(/^INV-\d{4}-\d{6,}$/) }).strict(),
]);

export type BillingResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { status: number; code: string; message: string } };

const settings = z.object({
  DATABASE_URL: z.string().min(1),
  // aws-iam in AWS (the function's role signs an RDS IAM token); password locally.
  DATABASE_AUTH: z.enum(["password", "aws-iam"]).default("password"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
});

/** One pool per Lambda container; IAM tokens are signed per connection, so they never expire in use. */
export function openPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const config = settings.parse(env);
  if (config.DATABASE_AUTH === "password") return new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  const url = new URL(config.DATABASE_URL);
  const port = url.port ? Number(url.port) : 5432;
  const user = decodeURIComponent(url.username);
  const signer = new Signer({ hostname: url.hostname, port, username: user, region: env.AWS_REGION! });
  return new pg.Pool({
    host: url.hostname,
    port,
    user,
    database: decodeURIComponent(url.pathname.slice(1)),
    password: () => signer.getAuthToken(),
    // Lambda's NODE_EXTRA_CA_CERTS bundle includes the Amazon RDS certificate authorities.
    ssl: { rejectUnauthorized: true },
    max: config.DATABASE_POOL_MAX,
  });
}

let billing: Billing | undefined;
let ready: Promise<void> | undefined;

async function service(): Promise<Billing> {
  billing ??= new Billing(openPool());
  // Retry migrations on the next invocation if they fail, for example before the database user exists.
  ready ??= billing.migrate().catch(error => {
    ready = undefined;
    throw error;
  });
  await ready;
  return billing;
}

export async function handle(target: Billing, input: unknown): Promise<BillingResponse> {
  const parsed = billingEvent.safeParse(input);
  if (!parsed.success) return { ok: false, error: { status: 400, code: "INVALID_REQUEST", message: "The billing request is not valid." } };
  const event = parsed.data;
  try {
    const result = event.action === "charge" ? await target.charge(event) : await target.invoice(event.invoiceNumber);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof BillingError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
    throw error;
  }
}

export async function handler(event: unknown): Promise<BillingResponse> {
  const started = Date.now();
  const action = (event as { action?: unknown })?.action;
  const reference = (event as { reservationId?: unknown; invoiceNumber?: unknown })?.reservationId
    ?? (event as { invoiceNumber?: unknown })?.invoiceNumber;
  try {
    const response = await handle(await service(), event);
    // Never log wallet IDs, names or amounts per guest; the reference is enough to correlate.
    console.log(JSON.stringify({
      level: "info", message: "Billing request", action, reference,
      outcome: response.ok ? "succeeded" : "refused", code: response.ok ? undefined : response.error.code,
      durationMs: Date.now() - started,
    }));
    return response;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "Billing request failed", action, reference, error: String(error), durationMs: Date.now() - started }));
    throw error;
  }
}
