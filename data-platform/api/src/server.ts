import { readFileSync } from "node:fs";
import { z } from "zod";
import { AvailabilityService } from "./availability/availability-service.ts";
import { buildApp } from "./http/app.ts";
import { entraAuthenticator } from "./http/entra-auth.ts";
import { QueueStore } from "./waiting-room/queue-store.ts";
import { cacheSettings, openCatalog, openInventory, redisCredentials, storageSettings } from "./store-connections.ts";

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
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  AVAILABILITY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(15),
  ADMISSION_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);
const storage = storageSettings.parse(process.env);
const cache = cacheSettings.parse(process.env);

if (env.AUTH_MODE === "none" && !loopback.includes(env.HOST)) {
  throw new Error("AUTH_MODE=none is only allowed when the service listens on a loopback address.");
}
if (env.AUTH_MODE === "entra" && (!env.ENTRA_TENANT_ID || !env.ENTRA_AUDIENCES)) {
  throw new Error("AUTH_MODE=entra requires ENTRA_TENANT_ID and ENTRA_AUDIENCES.");
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const log = { warn: (details: object, message: string) => app.log.warn(details, message) };
const inventory = openInventory(storage, env.DATABASE_POOL_MAX);
const availability = new AvailabilityService(cache.REDIS_URL, inventory, log, env.AVAILABILITY_CACHE_TTL_SECONDS, redisCredentials(cache));
const queues = new QueueStore(cache.REDIS_URL, log, { admissionMinutes: env.ADMISSION_MINUTES, credentialsProvider: redisCredentials(cache) });
const catalog = await openCatalog(storage);

const app = buildApp(
  {
    catalog,
    inventory,
    availability,
    queues,
    version: { service: "data-platform-api", version, commit: env.BUILD_COMMIT },
    authenticate: env.AUTH_MODE === "entra"
      ? entraAuthenticator({
        tenantId: env.ENTRA_TENANT_ID!,
        audiences: env.ENTRA_AUDIENCES!.split(",").map(audience => audience.trim()).filter(Boolean),
        requiredRole: env.ENTRA_REQUIRED_ROLE,
      })
      : undefined,
  },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

await Promise.all([availability.connect(), queues.connect()]);
// Load the catalog before accepting traffic so the first request does not pay the cold-start cost.
await catalog.festival();

const shutdown = async () => {
  await app.close();
  await Promise.allSettled([availability.close(), queues.close(), inventory.close()]);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ port: env.PORT, host: env.HOST });