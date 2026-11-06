import { DefaultAzureCredential } from "@azure/identity";
import { EntraIdCredentialsProviderFactory } from "@redis/entraid";
import { z } from "zod";
import { CatalogStore } from "./catalog/catalog-store.ts";
import { InventoryStore } from "./inventory/inventory-store.ts";

// Locally the containers accept connection strings. In Azure every store is reached with the
// service's managed identity (AZURE_CLIENT_ID selects it) and no keys or passwords exist.
const auth = z.enum(["password", "entra"]).default("password");

export const storageSettings = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH: auth,
  COSMOS_CONNECTION_STRING: z.string().min(1).optional(),
  COSMOS_ENDPOINT: z.string().url().optional(),
  COSMOS_DATABASE: z.string().default("moonshot"),
}).refine(env => Boolean(env.COSMOS_CONNECTION_STRING) !== Boolean(env.COSMOS_ENDPOINT), {
  message: "Set COSMOS_CONNECTION_STRING for the local emulator or COSMOS_ENDPOINT for Microsoft Entra sign-in, not both.",
});

export const cacheSettings = z.object({
  REDIS_URL: z.string().min(1),
  REDIS_AUTH: auth,
});

type StorageSettings = z.infer<typeof storageSettings>;

let credential: DefaultAzureCredential | undefined;
const azureCredential = () => (credential ??= new DefaultAzureCredential());

export function openInventory(settings: StorageSettings, maxConnections: number): InventoryStore {
  const password = settings.DATABASE_AUTH === "entra"
    ? async () => (await azureCredential().getToken("https://ossrdbms-aad.database.windows.net/.default")).token
    : undefined;
  return new InventoryStore(settings.DATABASE_URL, maxConnections, password);
}

export function openCatalog(settings: StorageSettings, options: { create?: boolean } = {}): Promise<CatalogStore> {
  const account = settings.COSMOS_ENDPOINT
    ? { endpoint: settings.COSMOS_ENDPOINT, credential: azureCredential() }
    : { connectionString: settings.COSMOS_CONNECTION_STRING! };
  return CatalogStore.connect(account, settings.COSMOS_DATABASE, options);
}

export function redisCredentials(settings: z.infer<typeof cacheSettings>) {
  if (settings.REDIS_AUTH !== "entra") return undefined;
  return EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
    credential: azureCredential(),
    scopes: ["https://redis.azure.com/.default"],
    tokenManagerConfig: { expirationRefreshRatio: 0.8 },
  });
}
