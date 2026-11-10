// Local development host for Moonshot Fest. The services never depend on Aspire:
// this file only starts containers and passes standard environment variables.
import { createBuilder } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

// Data Platform storage.
const postgres = await builder.addPostgres('postgres').withDataVolume();
const inventoryDb = await postgres.addDatabase('inventory');
const redis = await builder.addRedis('redis').withoutHttpsCertificate();
const cosmos = await builder.addAzureCosmosDB('cosmos').runAsPreviewEmulator({
    configureContainer: async emulator => {
        await emulator.withoutHttpsCertificate();
    },
});

const storage = {
    DATABASE_URL: await inventoryDb.uriExpression(),
    REDIS_URL: await redis.uriExpression(),
    COSMOS_CONNECTION_STRING: cosmos,
};

// Creates tables, the catalog container, and the approved festival content.
const seed = await builder
    .addNodeApp('data-platform-seed', '../data-platform/api', 'src/seed.ts')
    .withEnvironment('DATABASE_URL', storage.DATABASE_URL)
    .withEnvironment('COSMOS_CONNECTION_STRING', storage.COSMOS_CONNECTION_STRING)
    .waitFor(inventoryDb)
    .waitFor(cosmos);

// Moonshot Billing (an AWS Lambda in the cloud) as a local server with the Lambda's event format.
const billing = await builder
    .addNodeApp('billing', '../data-platform/billing', 'src/local-server.ts')
    .withRunScript('start:local')
    .withHttpEndpoint({ env: 'PORT' })
    .withEnvironment('DATABASE_URL', storage.DATABASE_URL)
    .withHttpHealthCheck({ path: '/health' })
    .waitFor(inventoryDb);
const dataPlatform = await builder
    .addNodeApp('data-platform-api', '../data-platform/api', 'src/server.ts')
    .withRunScript('start')
    .withHttpEndpoint({ env: 'PORT' })
    .withEnvironment('AUTH_MODE', 'none')
    .withEnvironment('DATABASE_URL', storage.DATABASE_URL)
    .withEnvironment('REDIS_URL', storage.REDIS_URL)
    .withEnvironment('COSMOS_CONNECTION_STRING', storage.COSMOS_CONNECTION_STRING)
    .withEnvironment('BILLING_URL', await billing.getEndpoint('http'))
    .withOtlpExporter()
    .withHttpHealthCheck({ path: '/health/ready' })
    .waitFor(redis)
    .waitFor(billing)
    .waitForCompletion(seed);

const storefrontApi = await builder
    .addNodeApp('storefront-api', '../storefront/api', 'src/server.ts')
    .withRunScript('start')
    .withHttpEndpoint({ env: 'PORT' })
    .withEnvironment('DATA_PLATFORM_API_URL', await dataPlatform.getEndpoint('http'))
    .withEnvironment('LIVE_AVAILABILITY_ENABLED', 'true')
    .withOtlpExporter()
    .withHttpHealthCheck({ path: '/health/ready' })
    .waitFor(dataPlatform);

await builder
    .addViteApp('storefront-web', '../storefront/web')
    .withEnvironment('STOREFRONT_API_URL', await storefrontApi.getEndpoint('http'))
    .withEnvironment('BROWSER', 'none')
    .withExternalHttpEndpoints()
    .waitFor(storefrontApi);

await builder.build().run();
