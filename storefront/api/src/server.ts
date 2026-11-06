import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { createDataPlatformClient } from "./data-platform/client.ts";
import { buildApp } from "./http/app.ts";

const config = z.object({
  PORT: z.coerce.number().int().default(5000),
  HOST: z.string().default("127.0.0.1"),
  DATA_PLATFORM_API_URL: z.string().url(),
  // In Azure: the data-platform-api scope, for example api://<client-id>/.default. Unset locally.
  DATA_PLATFORM_API_SCOPE: z.string().optional(),
  LIVE_AVAILABILITY_ENABLED: z.enum(["true", "false"]).default("true"),
  LIVE_AVAILABILITY_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  WEB_DIST_DIR: z.string().optional(),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const scope = config.DATA_PLATFORM_API_SCOPE;
// The managed identity selected by AZURE_CLIENT_ID; tokens are cached and refreshed by the credential.
const credential = scope ? new DefaultAzureCredential() : undefined;
const accessToken = credential && scope ? async () => (await credential.getToken(scope)).token : undefined;

const app = buildApp(
  createDataPlatformClient(config.DATA_PLATFORM_API_URL, { accessToken }),
  {
    liveAvailabilityEnabled: config.LIVE_AVAILABILITY_ENABLED === "true",
    liveAvailabilityConcurrency: config.LIVE_AVAILABILITY_CONCURRENCY,
    webDistDir: config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : undefined,
    version: { service: "storefront-api", version, commit: config.BUILD_COMMIT },
  },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());

await app.listen({ port: config.PORT, host: config.HOST });
