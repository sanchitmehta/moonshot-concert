import { fileURLToPath } from "node:url";
import { z } from "zod";
import { catalogOffers, festival, inventory as seedInventory } from "../db/seed/festival.ts";
import { CatalogStore } from "./catalog/catalog-store.ts";
import { InventoryStore } from "./inventory/inventory-store.ts";

const config = z.object({
  DATABASE_URL: z.string().min(1),
  COSMOS_CONNECTION_STRING: z.string().min(1),
  COSMOS_DATABASE: z.string().default("moonshot"),
}).parse(process.env);

const inventory = new InventoryStore(config.DATABASE_URL, 2);
try {
  await inventory.migrate(fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await inventory.seed(seedInventory(new Date()));
  const catalog = await CatalogStore.connect(config.COSMOS_CONNECTION_STRING, config.COSMOS_DATABASE, { create: true });
  await catalog.seed(festival, catalogOffers);
  console.log(`Seeded ${catalogOffers.length} offers.`);
} finally {
  await inventory.close();
}
