import { z } from "zod";

const policyEntry = z.object({
  queue: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  saleType: z.enum(["STANDARD", "LIMITED_DROP"]),
  perMinute: z.number().int().min(1).max(100),
}).strict();

/**
 * The waiting-room policy: which queues exist, which queue a guest joins, and how fast each queue is
 * admitted. A guest joins the first queue listed for their pass's sale type; every listed queue is
 * drained, so an older queue can stay listed until its guests have been admitted.
 */
export const waitingRoomPolicy = z.array(policyEntry).min(1).superRefine((entries, context) => {
  for (const saleType of ["STANDARD", "LIMITED_DROP"] as const) {
    if (!entries.some(entry => entry.saleType === saleType)) {
      context.addIssue({ code: "custom", message: `The waiting-room policy has no queue for ${saleType} passes.` });
    }
  }
  const names = entries.map(entry => entry.queue);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "Each queue may be listed only once." });
});

export type WaitingRoomPolicy = z.infer<typeof waitingRoomPolicy>;
export type SaleType = WaitingRoomPolicy[number]["saleType"];

export const parsePolicy = (json: string): WaitingRoomPolicy => waitingRoomPolicy.parse(JSON.parse(json));

export const queueToJoin = (policy: WaitingRoomPolicy, saleType: SaleType) => policy.find(entry => entry.saleType === saleType)!;

/** Minutes until admission at the queue's current rate, or null when the policy does not drain that queue. */
export function estimatedWaitMinutes(policy: WaitingRoomPolicy, queue: string, position: number | null): number | null {
  const entry = policy.find(candidate => candidate.queue === queue);
  if (!entry || position === null) return null;
  return Math.ceil(position / entry.perMinute);
}
