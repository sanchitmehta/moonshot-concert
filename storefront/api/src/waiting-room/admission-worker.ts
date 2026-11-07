import { metrics } from "@opentelemetry/api";
import type { WaitingRoomPolicy } from "./policy.ts";

const meter = metrics.getMeter("storefront-api");
const admissionCalls = meter.createCounter("waitingroom.admission_calls", { description: "Admission requests sent per queue" });
const admittedGuests = meter.createCounter("waitingroom.admitted", { description: "Guests admitted per queue" });

type Admit = (queue: string, count: number, idempotencyKey: string) => Promise<{ admitted: string[]; waiting: number }>;
type Logger = { info: (details: object, message: string) => void; warn: (details: object, message: string) => void };

/**
 * Each interval, asks the Data Platform to admit `perMinute` guests from every queue in the policy.
 * The idempotency key names the queue and the interval, so a duplicated tick admits nobody twice.
 */
export async function admitOnce(policy: WaitingRoomPolicy, admit: Admit, log: Logger, intervalSeconds: number, now = Date.now()) {
  const interval = Math.floor(now / (intervalSeconds * 1000));
  for (const { queue, perMinute } of policy) {
    const count = Math.max(1, Math.round((perMinute * intervalSeconds) / 60));
    try {
      const result = await admit(queue, count, `admit-${queue}-${interval}`);
      admissionCalls.add(1, { queue });
      admittedGuests.add(result.admitted.length, { queue });
      log.info({ queue, admitted: result.admitted.length, waiting: result.waiting }, "Waiting-room admission");
    } catch (error) {
      log.warn({ queue, err: error }, "Waiting-room admission failed");
    }
  }
}

export function startAdmissionWorker(policy: WaitingRoomPolicy, admit: Admit, log: Logger, intervalSeconds: number) {
  log.info({ queues: policy.map(entry => entry.queue), intervalSeconds }, "Waiting-room admission worker started");
  let running = Promise.resolve();
  const timer = setInterval(() => {
    running = running.then(() => admitOnce(policy, admit, log, intervalSeconds));
  }, intervalSeconds * 1000);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
