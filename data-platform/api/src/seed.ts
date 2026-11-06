import { fileURLToPath } from "node:url";
import { z } from "zod";
import { catalogOffers, festival, inventory as seedInventory } from "../db/seed/festival.ts";
import { openCatalog, openInventory, prepareInventoryUser, storageSettings } from "./store-connections.ts";

// Applies database migrations and the approved festival content. Safe to run on every deployment:
// migrations run once, existing inventory rows are kept, and catalog documents are upserted.
const storage = storageSettings.parse(process.env);
// In Azure the catalog database and container are provisioned by Terraform; data-plane roles cannot create them.
const { COSMOS_CREATE } = z.object({ COSMOS_CREATE: z.enum(["true", "false"]).default("true") }).parse(process.env);

await prepareInventoryUser(storage);
const inventory = openInventory(storage, 2);
try {
  await inventory.migrate(fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await inventory.seed(seedInventory(new Date()));
  const catalog = await openCatalog(storage, { create: COSMOS_CREATE === "true" });
  await catalog.seed(festival, catalogOffers);
  console.log(`Seeded ${catalogOffers.length} offers.`);
} finally {
  await inventory.close();
}