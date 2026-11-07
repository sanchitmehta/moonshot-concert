import { readFileSync } from "node:fs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Signer } from "@aws-sdk/rds-signer";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { DefaultAzureCredential } from "@azure/identity";
import { EntraIdCredentialsProviderFactory } from "@redis/entraid";
import pg from "pg";
import { z } from "zod";
import { CatalogStore } from "./catalog/catalog-store.ts";
import { InventoryStore, poolConfig } from "./inventory/inventory-store.ts";

// Locally the containers accept connection strings. In the cloud every store is reached with the
// service's managed identity (AZURE_CLIENT_ID selects it) and no keys or passwords are configured.
//  - entra:   Azure Database for PostgreSQL accepts a Microsoft Entra token as the password.
//  - aws-iam: the managed identity gets an Entra token for AWS_FEDERATION_RESOURCE (issued with the
//             identity's own client ID as its audience), AWS STS exchanges it for the AWS_ROLE_ARN
//             role, and that role signs an Amazon RDS IAM token used as the password.
export const storageSettings = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH: z.enum(["password", "entra", "aws-iam"]).default("password"),
  DATABASE_CA_FILE: z.string().optional(),
  DATABASE_ADMIN_SECRET_ARN: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ROLE_ARN: z.string().optional(),
  AWS_FEDERATION_RESOURCE: z.string().optional(),
  COSMOS_CONNECTION_STRING: z.string().min(1).optional(),
  COSMOS_ENDPOINT: z.string().url().optional(),
  COSMOS_DATABASE: z.string().default("moonshot"),
}).refine(env => Boolean(env.COSMOS_CONNECTION_STRING) !== Boolean(env.COSMOS_ENDPOINT), {
  message: "Set COSMOS_CONNECTION_STRING for the local emulator or COSMOS_ENDPOINT for Microsoft Entra sign-in, not both.",
}).refine(env => env.DATABASE_AUTH !== "aws-iam" || (env.AWS_REGION && env.AWS_ROLE_ARN && env.AWS_FEDERATION_RESOURCE), {
  message: "DATABASE_AUTH=aws-iam requires AWS_REGION, AWS_ROLE_ARN and AWS_FEDERATION_RESOURCE.",
});

export const cacheSettings = z.object({
  REDIS_URL: z.string().min(1),
  REDIS_AUTH: z.enum(["password", "entra"]).default("password"),
});

type StorageSettings = z.infer<typeof storageSettings>;

let credential: DefaultAzureCredential | undefined;
const azureCredential = () => (credential ??= new DefaultAzureCredential());

let awsSession: Promise<AwsCredentialIdentity> | undefined;

/** AWS credentials for AWS_ROLE_ARN, obtained with the managed identity's Entra token and reused until near expiry. */
function awsCredentials(settings: StorageSettings): () => Promise<AwsCredentialIdentity> {
  const sts = new STSClient({ region: settings.AWS_REGION });
  const refresh = async (): Promise<AwsCredentialIdentity> => {
    const { token } = await azureCredential().getToken(`${settings.AWS_FEDERATION_RESOURCE}/.default`);
    let result;
    try {
      result = await sts.send(new AssumeRoleWithWebIdentityCommand({
        RoleArn: settings.AWS_ROLE_ARN,
        RoleSessionName: "data-platform-api",
        WebIdentityToken: token,
        DurationSeconds: 3600,
      }));
    } catch (error) {
      // Name the token's issuer and audience (never the token) so a trust mismatch is easy to fix.
      const { iss, aud, oaud, ver, sub } = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
      throw new Error(`AWS STS rejected the managed identity token (iss=${iss}, aud=${aud}, oaud=${oaud}, ver=${ver}, sub=${sub}).`, { cause: error });
    }
    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error("AWS STS returned no credentials.");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  };
  return async () => {
    const current = awsSession && (await awsSession.catch(() => undefined));
    if (!current?.expiration || current.expiration.getTime() - Date.now() < 5 * 60_000) awsSession = refresh();
    return awsSession!;
  };
}

function databaseCa(settings: StorageSettings): string | undefined {
  return settings.DATABASE_CA_FILE ? readFileSync(settings.DATABASE_CA_FILE, "utf8") : undefined;
}

export function openInventory(settings: StorageSettings, maxConnections: number): InventoryStore {
  let password: (() => Promise<string>) | undefined;
  if (settings.DATABASE_AUTH === "entra") {
    password = async () => (await azureCredential().getToken("https://ossrdbms-aad.database.windows.net/.default")).token;
  } else if (settings.DATABASE_AUTH === "aws-iam") {
    const url = new URL(settings.DATABASE_URL);
    const signer = new Signer({
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      username: decodeURIComponent(url.username),
      region: settings.AWS_REGION!,
      credentials: awsCredentials(settings),
    });
    password = () => signer.getAuthToken();
  }
  return new InventoryStore(settings.DATABASE_URL, maxConnections, password, databaseCa(settings));
}

/**
 * Amazon RDS only: creates the IAM-authenticated database user named in DATABASE_URL, signing in
 * once as the RDS-managed administrator (whose password lives in AWS Secrets Manager and is never
 * stored here). Skipped when that user can already sign in and create tables. The administrator is
 * never made a member of the user: membership would pull it into rds_iam and disable its password.
 */
export async function prepareInventoryUser(settings: StorageSettings): Promise<void> {
  if (settings.DATABASE_AUTH !== "aws-iam" || !settings.DATABASE_ADMIN_SECRET_ARN) return;
  if (await inventoryUserReady(settings)) return;
  const secrets = new SecretsManagerClient({ region: settings.AWS_REGION, credentials: awsCredentials(settings) });
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: settings.DATABASE_ADMIN_SECRET_ARN }));
  const admin = JSON.parse(SecretString ?? "{}") as { username?: string; password?: string };
  if (!admin.username || !admin.password) throw new Error("The RDS administrator secret has no username or password.");

  const url = new URL(settings.DATABASE_URL);
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  url.username = encodeURIComponent(admin.username);
  const client = new pg.Client(poolConfig(url.toString(), 1, async () => admin.password!, databaseCa(settings)));
  await client.connect();
  try {
    const role = client.escapeIdentifier(user);
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${client.escapeLiteral(user)}) THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
    await client.query(`GRANT rds_iam TO ${role}`);
    await client.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${client.escapeIdentifier(database)} TO ${role}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
  } finally {
    await client.end();
  }
}

async function inventoryUserReady(settings: StorageSettings): Promise<boolean> {
  const store = openInventory(settings, 1);
  try {
    return await store.canCreateTables();
  } catch {
    return false;
  } finally {
    await store.close();
  }
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