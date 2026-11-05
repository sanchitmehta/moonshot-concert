import { Agent } from "node:https";
import { CosmosClient, type Container } from "@azure/cosmos";
import type { CatalogOffer, Festival } from "../domain.ts";
import { notFound } from "../errors.ts";

type Snapshot = { festival: Festival; offers: CatalogOffer[]; loadedAt: number };

function endpointOf(connectionString: string): URL {
  const endpoint = /AccountEndpoint=([^;]+)/i.exec(connectionString)?.[1];
  if (!endpoint) throw new Error("The Cosmos DB connection string has no AccountEndpoint.");
  return new URL(endpoint);
}

function stripSystemFields<T>(document: Record<string, unknown>): T {
  const { id: _id, kind: _kind, _rid, _self, _etag, _attachments, _ts, ...rest } = document;
  return rest as T;
}

export class CatalogStore {
  readonly #container: Container;
  readonly #cacheMs: number;
  #snapshot: Snapshot | undefined;

  private constructor(container: Container, cacheMs: number) {
    this.#container = container;
    this.#cacheMs = cacheMs;
  }

  static async connect(connectionString: string, databaseId: string, options: { create?: boolean; cacheMs?: number } = {}) {
    const endpoint = endpointOf(connectionString);
    // The local Cosmos DB emulator uses a self-signed certificate; trust it only on loopback.
    const isLocalEmulator = ["localhost", "127.0.0.1"].includes(endpoint.hostname);
    const client = new CosmosClient({
      connectionString,
      ...(isLocalEmulator && endpoint.protocol === "https:" ? { agent: new Agent({ rejectUnauthorized: false }) } : {}),
    });
    let container: Container;
    if (options.create) {
      const { database } = await client.databases.createIfNotExists({ id: databaseId });
      ({ container } = await database.containers.createIfNotExists({ id: "catalog", partitionKey: { paths: ["/kind"] } }));
    } else {
      container = client.database(databaseId).container("catalog");
    }
    return new CatalogStore(container, options.cacheMs ?? 60_000);
  }

  async festival(): Promise<Festival> {
    return (await this.#load()).festival;
  }

  async offers(): Promise<CatalogOffer[]> {
    return (await this.#load()).offers;
  }

  async offer(offerId: string): Promise<CatalogOffer> {
    const offer = (await this.#load()).offers.find(candidate => candidate.offerId === offerId);
    if (!offer) throw notFound("OFFER_NOT_FOUND", "This pass does not exist.");
    return offer;
  }

  async seed(festival: Festival, offers: CatalogOffer[]): Promise<void> {
    await this.#container.items.upsert({ id: "festival", kind: "festival", ...festival });
    for (const offer of offers) {
      await this.#container.items.upsert({ id: offer.offerId, kind: "offer", ...offer });
    }
  }

  async ping(): Promise<void> {
    await this.#container.read();
  }

  async #load(): Promise<Snapshot> {
    if (this.#snapshot && Date.now() - this.#snapshot.loadedAt < this.#cacheMs) return this.#snapshot;
    const { resource: festivalDocument } = await this.#container.item("festival", "festival").read<Record<string, unknown>>();
    if (!festivalDocument) throw new Error("The festival catalog has not been seeded.");
    const { resources } = await this.#container.items
      .query<Record<string, unknown>>({ query: "SELECT * FROM c WHERE c.kind = @kind", parameters: [{ name: "@kind", value: "offer" }] }, { partitionKey: "offer" })
      .fetchAll();
    const offers = resources.map(document => stripSystemFields<CatalogOffer>(document)).sort((a, b) => a.day - b.day || a.offerId.localeCompare(b.offerId));
    this.#snapshot = { festival: stripSystemFields<Festival>(festivalDocument), offers, loadedAt: Date.now() };
    return this.#snapshot;
  }
}
