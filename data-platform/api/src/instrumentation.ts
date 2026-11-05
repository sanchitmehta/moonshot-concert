import { register } from "node:module";

// Tracing starts only when an OTLP endpoint is configured (Aspire locally, the collector in Azure).
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}
