import type { BillingClient } from "../billing/billing-client.ts";
import type { PassDetails, Reservation, ReservationRequest } from "../domain.ts";
import { ServiceError } from "../errors.ts";
import type { InventoryStore } from "../inventory/inventory-store.ts";

type Logger = { info: (details: object, message: string) => void; warn: (details: object, message: string) => void };

const dayName = (pass: PassDetails) => `day ${pass.day}`;

/**
 * Reserves and pays: holds the passes, asks billing to charge the wallet, then confirms the reservation.
 * A refused payment cancels the hold. If billing cannot be reached, the hold stays pending and the
 * guest's retry with the same Idempotency-Key charges at most once (billing is idempotent per reservation).
 */
export async function checkout(
  deps: { inventory: InventoryStore; billing: BillingClient; log: Logger },
  request: ReservationRequest,
  idempotencyKey: string,
  pass: PassDetails,
  admissionEntryId: string,
): Promise<Reservation> {
  const hold = await deps.inventory.hold(request, idempotencyKey, pass, admissionEntryId);
  if (hold.state === "CONFIRMED") return hold.reservation;

  const { held } = hold;
  let charge;
  try {
    charge = await deps.billing.charge({
      reservationId: held.confirmationCode,
      walletId: request.walletId,
      billedTo: held.leadName,
      lines: [{ description: `${held.pass.name}, day ${held.pass.day}`, quantity: held.quantity, unitPrice: held.unitPrice }],
    });
  } catch (error) {
    if (error instanceof ServiceError && error.status < 500) {
      await deps.inventory.cancel(held.confirmationCode, error);
      deps.log.info({ confirmationCode: held.confirmationCode, code: error.code }, "Payment refused; reservation cancelled");
    } else {
      deps.log.warn({ confirmationCode: held.confirmationCode, err: error }, "Billing unavailable; reservation left pending");
    }
    throw error;
  }
  const reservation = await deps.inventory.confirm(held.confirmationCode, { method: "MOONSHOT_WALLET", ...charge });
  deps.log.info({ confirmationCode: held.confirmationCode, paymentId: charge.paymentId, invoiceNumber: charge.invoiceNumber }, "Reservation paid");
  return reservation;
}
