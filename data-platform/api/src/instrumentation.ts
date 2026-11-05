import { register } from "node:module";

// Locally Aspire sets an OTLP endpoint; in Azure, App Service sets the Application Insights connection string.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { useAzureMonitor, shutdownAzureMonitor } = await import("@azure/monitor-opentelemetry");
  useAzureMonitor({ enableLiveMetrics: true });
  process.once("SIGTERM", () => void shutdownAzureMonitor());
} else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}