import { readFileSync } from "node:fs";
import { z } from "zod";
import { AvailabilityService } from "./availability/availability-service.ts";
import { CatalogStore } from "./catalog/catalog-store.ts";
import { buildApp } from "./http/app.ts";
import { InventoryStore } from "./inventory/inventory-store.ts";

const loopback = ["127.0.0.1", "localhost", "::1"];

const config = z.object({
  PORT: z.coerce.number().int().default(5100),
  HOST: z.string().default("127.0.0.1"),
  AUTH_MODE: z.enum(["none"], {
    message: "Set AUTH_MODE=none for local development. Microsoft Entra authentication is added for cloud deployment.",
  }),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  REDIS_URL: z.string().min(1),
  COSMOS_CONNECTION_STRING: z.string().min(1),
  COSMOS_DATABASE: z.string().default("moonshot"),
  AVAILABILITY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(15),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);

if (config.AUTH_MODE === "none" && !loopback.includes(config.HOST)) {
  throw new Error("AUTH_MODE=none is only allowed when the service listens on a loopback address.");
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const log = { warn: (details: object, message: string) => app.log.warn(details, message) };
const inventory = new InventoryStore(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const availability = new AvailabilityService(config.REDIS_URL, inventory, log, config.AVAILABILITY_CACHE_TTL_SECONDS);
const catalog = await CatalogStore.connect(config.COSMOS_CONNECTION_STRING, config.COSMOS_DATABASE);

const app = buildApp(
  { catalog, inventory, availability, version: { service: "data-platform-api", version, commit: config.BUILD_COMMIT } },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

await availability.connect();
// Load the catalog before accepting traffic so the first request does not pay the cold-start cost.
await catalog.festival();

const shutdown = async () => {
  await app.close();
  await Promise.allSettled([availability.close(), inventory.close()]);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
