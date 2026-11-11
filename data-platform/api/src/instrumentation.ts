import { register } from "node:module";

// Locally Aspire sets an OTLP endpoint; in Azure, App Service sets the Application Insights connection string.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { useAzureMonitor, shutdownAzureMonitor } = await import("@azure/monitor-opentelemetry");
  const { registerInstrumentations } = await import("@opentelemetry/instrumentation");
  const { PinoInstrumentation } = await import("@opentelemetry/instrumentation-pino");
  const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");
  useAzureMonitor({
    enableLiveMetrics: true,
    // A log line that carries an error is stored as an exception; keep the line's message with it as `msg`.
    logRecordProcessors: [{
      onEmit: record => { if (record.attributes["exception.type"]) record.setAttribute("msg", record.body); },
      forceFlush: async () => {},
      shutdown: async () => {},
    }],
  });
  // Azure Monitor instruments HTTP servers, PostgreSQL and Redis; these add the service's logs and its outbound fetch calls.
  registerInstrumentations({ instrumentations: [new PinoInstrumentation(), new UndiciInstrumentation()] });
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