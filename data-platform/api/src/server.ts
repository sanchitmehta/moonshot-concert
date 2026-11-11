import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AvailabilityService } from "./availability/availability-service.ts";
import { httpBillingClient, lambdaBillingClient } from "./billing/billing-client.ts";
import { saleSummary } from "./domain.ts";
import { buildApp } from "./http/app.ts";
import { entraAuthenticator } from "./http/entra-auth.ts";
import { QueueStore } from "./waiting-room/queue-store.ts";
import { awsCredentials, cacheSettings, openCatalog, openInventory, redisCredentials, storageSettings } from "./store-connections.ts";

const loopback = ["127.0.0.1", "localhost", "::1"];

const env = z.object({
  PORT: z.coerce.number().int().default(5100),
  HOST: z.string().default("127.0.0.1"),
  AUTH_MODE: z.enum(["none", "entra"], {
    message: "Set AUTH_MODE=none for local development or AUTH_MODE=entra in Azure.",
  }),
  ENTRA_TENANT_ID: z.string().uuid().optional(),
  ENTRA_AUDIENCES: z.string().optional(),
  ENTRA_REQUIRED_ROLE: z.string().default("DataPlatform.Access"),
  ENTRA_ADMIN_ROLE: z.string().default("DataPlatform.Admin"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  AVAILABILITY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(15),
  ADMISSION_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  ADMISSION_QUEUES: z.string().optional(),
  RESERVATION_HOLD_MINUTES: z.coerce.number().int().min(0).max(1440).default(120),
  // Moonshot Billing: the Lambda function name in the cloud, or the local development server's URL.
  BILLING_FUNCTION: z.string().min(1).optional(),
  BILLING_URL: z.string().url().optional(),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);
const storage = storageSettings.parse(process.env);
const cache = cacheSettings.parse(process.env);

if (env.AUTH_MODE === "none" && !loopback.includes(env.HOST)) {
  throw new Error("AUTH_MODE=none is only allowed when the service listens on a loopback address.");
}
if (Boolean(env.BILLING_FUNCTION) === Boolean(env.BILLING_URL)) {
  throw new Error("Set BILLING_FUNCTION (AWS Lambda) or BILLING_URL (local billing server), not both.");
}
if (env.BILLING_FUNCTION && (!storage.AWS_REGION || !storage.AWS_ROLE_ARN || !storage.AWS_FEDERATION_RESOURCE)) {
  throw new Error("BILLING_FUNCTION requires AWS_REGION, AWS_ROLE_ARN and AWS_FEDERATION_RESOURCE.");
}
if (env.AUTH_MODE === "entra" && (!env.ENTRA_TENANT_ID || !env.ENTRA_AUDIENCES)) {
  throw new Error("AUTH_MODE=entra requires ENTRA_TENANT_ID and ENTRA_AUDIENCES.");
}
if (env.ENTRA_ADMIN_ROLE === env.ENTRA_REQUIRED_ROLE) {
  throw new Error("ENTRA_ADMIN_ROLE must differ from ENTRA_REQUIRED_ROLE: the admin role grants admin routes only.");
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const buildInfo = new URL("./build-info.json", import.meta.url);
const buildCommit = existsSync(buildInfo)
  ? z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(readFileSync(buildInfo, "utf8"))).commit
  : env.BUILD_COMMIT;
const admissionQueues = env.ADMISSION_QUEUES === undefined ? undefined
  : z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).min(1).refine(
    queues => new Set(queues).size === queues.length, "Admission queues must be unique.",
  ).parse(JSON.parse(env.ADMISSION_QUEUES));

const log = {
  info: (details: object, message: string) => app.log.info(details, message),
  warn: (details: object, message: string) => app.log.warn(details, message),
};
const inventory = openInventory(storage, env.DATABASE_POOL_MAX, env.RESERVATION_HOLD_MINUTES);
const availability = new AvailabilityService(cache.REDIS_URL, inventory, log, env.AVAILABILITY_CACHE_TTL_SECONDS, redisCredentials(cache));
const queues = new QueueStore(cache.REDIS_URL, log, { admissionMinutes: env.ADMISSION_MINUTES, credentialsProvider: redisCredentials(cache) });
const catalog = await openCatalog(storage);
const billing = env.BILLING_FUNCTION
  ? lambdaBillingClient(env.BILLING_FUNCTION, storage.AWS_REGION!, awsCredentials(storage))
  : httpBillingClient(env.BILLING_URL!);

const app = buildApp(
  {
    catalog,
    inventory,
    availability,
    queues,
    billing,
    admissionQueues,
    version: { service: "data-platform-api", version, commit: buildCommit },
    authenticate: env.AUTH_MODE === "entra"
      ? entraAuthenticator({
        tenantId: env.ENTRA_TENANT_ID!,
        audiences: env.ENTRA_AUDIENCES!.split(",").map(audience => audience.trim()).filter(Boolean),
        requiredRole: env.ENTRA_REQUIRED_ROLE,
        adminRole: env.ENTRA_ADMIN_ROLE,
      })
      : undefined,
  },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

await Promise.all([availability.connect(), queues.connect()]);
// Load the catalog before accepting traffic so the first request does not pay the cold-start cost.
const festival = await catalog.festival();

/** Bounds a start-up read that is worth a log line but not worth waiting for. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> => Promise.race([
  work,
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms).unref()),
]);
try {
  const offers = await catalog.offers();
  const sale = saleSummary(await within(5000, inventory.stockLevels(offers.map(offer => offer.offerId))));
  app.log.info({ festival: festival.name, passes: offers.length, ...sale }, sale.onSale > 0 ? "Sale is live" : "No passes are on sale");
} catch (error) {
  // The readiness check reports the database; a count for the log is no reason to stay down.
  app.log.warn({ err: error }, "Could not read what is on sale at start-up");
}

const shutdown = async () => {
  await app.close();
  await Promise.allSettled([availability.close(), queues.close(), inventory.close()]);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({
  version,
  commit: buildCommit,
  authMode: env.AUTH_MODE,
  databaseAuth: storage.DATABASE_AUTH,
  databasePoolMax: env.DATABASE_POOL_MAX,
  cacheAuth: cache.REDIS_AUTH,
  availabilityCacheTtlSeconds: env.AVAILABILITY_CACHE_TTL_SECONDS,
  admissionMinutes: env.ADMISSION_MINUTES,
  admissionQueues: admissionQueues?.join(",") ?? "any",
  reservationHoldMinutes: env.RESERVATION_HOLD_MINUTES,
  billing: env.BILLING_FUNCTION ?? "local",
}, "Service started");