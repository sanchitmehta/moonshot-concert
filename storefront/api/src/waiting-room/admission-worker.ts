import { metrics } from "@opentelemetry/api";
import { UpstreamError } from "../data-platform/client.ts";
import type { WaitingRoomPolicy } from "./policy.ts";

const meter = metrics.getMeter("storefront-api");
const admissionCalls = meter.createCounter("waitingroom.admission_calls", { description: "Admission requests sent per queue" });
const admittedGuests = meter.createCounter("waitingroom.admitted", { description: "Guests admitted per queue" });
const admissionFailures = meter.createCounter("waitingroom.admission_failures", { description: "Admission requests that failed per queue" });

type Admit = (queue: string, count: number, idempotencyKey: string) => Promise<{ admitted: string[]; waiting: number }>;
type Logger = { info: (details: object, message: string) => void; warn: (details: object, message: string) => void };
type PolicyEntry = WaitingRoomPolicy[number];

/**
 * Asks the Data Platform to admit the queue's `admitCount` guests for the current interval.
 * The idempotency key names the queue and the interval, so a duplicated tick admits nobody twice.
 */
export async function admitOnce({ queue, admitCount, everySeconds }: PolicyEntry, admit: Admit, log: Logger, now = Date.now()) {
  const interval = Math.floor(now / (everySeconds * 1000));
  try {
    const result = await admit(queue, admitCount, `admit-${queue}-${interval}`);
    admissionCalls.add(1, { queue });
    admittedGuests.add(result.admitted.length, { queue });
    log.info({ queue, admitted: result.admitted.length, waiting: result.waiting }, "Waiting-room admission");
  } catch (error) {
    const upstream = error instanceof UpstreamError ? error.upstream : undefined;
    const failure = { queue, upstreamStatus: upstream?.status, upstreamCode: upstream?.code };
    admissionFailures.add(1, failure);
    log.warn({ ...failure, err: error }, "Waiting-room admission failed");
  }
}

/** Admits from every queue in the policy, each on its own `everySeconds` schedule. */
export function startAdmissionWorker(policy: WaitingRoomPolicy, admit: Admit, log: Logger) {
  log.info({ queues: policy.map(({ queue, admitCount, everySeconds }) => ({ queue, admitCount, everySeconds })) }, "Waiting-room admission worker started");
  const workers = policy.map(entry => {
    let running = Promise.resolve();
    const timer = setInterval(() => {
      running = running.then(() => admitOnce(entry, admit, log));
    }, entry.everySeconds * 1000);
    return { timer, running: () => running };
  });
  return {
    stop: async () => {
      for (const { timer } of workers) clearInterval(timer);
      await Promise.all(workers.map(({ running }) => running()));
    },
  };
}