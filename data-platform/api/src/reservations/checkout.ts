import type { BillingClient } from "../billing/billing-client.ts";
import type { PassDetails, Reservation, ReservationRequest } from "../domain.ts";
import { ServiceError } from "../errors.ts";
import type { InventoryStore } from "../inventory/inventory-store.ts";

type Log = (details: object, message: string) => void;
type Logger = { info: Log; warn: Log; error: Log };

/**
 * Reserves and pays: holds the passes, asks billing to charge the wallet, then confirms the reservation.
 * A refused payment cancels the hold. If billing cannot be reached, the hold stays pending until it
 * runs out and the guest's retry with the same Idempotency-Key charges at most once (billing is
 * idempotent per reservation).
 */
export async function checkout(
  deps: { inventory: InventoryStore; billing: BillingClient; log: Logger },
  request: ReservationRequest,
  idempotencyKey: string,
  pass: PassDetails,
  admissionEntryId: string,
): Promise<Reservation> {
  const hold = await deps.inventory.hold(request, idempotencyKey, pass, admissionEntryId);
  if (hold.state === "CONFIRMED") {
    deps.log.info({ confirmationCode: hold.reservation.confirmationCode }, "Retry returned a confirmed reservation");
    return hold.reservation;
  }

  const { held } = hold;
  const passes = { confirmationCode: held.confirmationCode, offerId: request.offerId, quantity: held.quantity, heldUntil: held.heldUntil };
  if (hold.remaining === undefined) deps.log.info(passes, "Retry resumed a pending reservation");
  else deps.log.info({ ...passes, remaining: hold.remaining }, "Passes held");

  const asked = Date.now();
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
  const payment = { confirmationCode: held.confirmationCode, paymentId: charge.paymentId, invoiceNumber: charge.invoiceNumber };
  // Billing answers a retry with the reservation's original charge, so this line can repeat for one payment.
  deps.log.info({ ...payment, billingMs: Date.now() - asked }, "Payment confirmed by billing");
  const paid = { ...payment, offerId: request.offerId, quantity: held.quantity };
  let reservation;
  try {
    reservation = await deps.inventory.confirm(held.confirmationCode, { method: "MOONSHOT_WALLET", ...charge });
  } catch (error) {
    // The wallet was charged. A retry with the same key confirms without charging again; until then
    // this line is what ties the payment to its reservation.
    deps.log.error({ ...paid, err: error }, "Payment taken but reservation not confirmed");
    throw error;
  }
  deps.log.info(paid, "Reservation paid");
  return reservation;
}
