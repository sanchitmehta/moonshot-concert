import { useState, type FormEvent } from "react";
import { Availability, dayName, includesSummary, money, Perks, Status } from "../components.tsx";
import { api, randomToken, RequestError, useResource, type Money, type Offer, type Reservation } from "../api.ts";

type Attempt = { idempotencyKey: string; accessKey: string; leadName: string; quantity: number; expectedUnitPrice: Money };

const storageKey = (offerId: string) => `moonshot-fest:reservation:${offerId}`;

function loadAttempt(offerId: string): Attempt | undefined {
  try {
    const stored = sessionStorage.getItem(storageKey(offerId));
    return stored ? (JSON.parse(stored) as Attempt) : undefined;
  } catch {
    return undefined;
  }
}

export function Reserve({ offerId }: { offerId: string }) {
  const offer = useResource<Offer>(`/offers/${encodeURIComponent(offerId)}`);
  const [attempt, setAttempt] = useState(() => loadAttempt(offerId));
  const [leadName, setLeadName] = useState(attempt?.leadName ?? "");
  const [quantity, setQuantity] = useState(attempt?.quantity ?? 1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const pass = offer.data;
  const unitPrice = attempt?.expectedUnitPrice ?? pass?.unitPrice;
  const count = attempt?.quantity ?? quantity;
  const maxQuantity = pass ? Math.max(1, Math.min(pass.maxPerReservation, pass.availability.remaining)) : 1;
  const onSale = pass?.availability.saleStatus === "ON_SALE";

  const clearAttempt = () => {
    sessionStorage.removeItem(storageKey(offerId));
    setAttempt(undefined);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pass || submitting) return;
    const current: Attempt = attempt ?? {
      idempotencyKey: randomToken(16),
      accessKey: randomToken(32),
      leadName: leadName.trim(),
      quantity,
      expectedUnitPrice: pass.unitPrice,
    };
    sessionStorage.setItem(storageKey(offerId), JSON.stringify(current));
    setAttempt(current);
    setSubmitting(true);
    setError(undefined);
    try {
      const reservation = await api<Reservation>("/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.idempotencyKey },
        body: JSON.stringify({
          offerId, leadName: current.leadName, quantity: current.quantity,
          expectedUnitPrice: current.expectedUnitPrice, accessKey: current.accessKey,
        }),
      });
      clearAttempt();
      window.location.assign(`/confirmation/${encodeURIComponent(reservation.confirmationCode)}#key=${current.accessKey}`);
    } catch (caught) {
      const failure = caught instanceof RequestError ? caught : new RequestError(0, "UNKNOWN", "Something went wrong.");
      if (failure.status > 0 && failure.status < 500) {
        clearAttempt();
        setError(failure.message);
        if (failure.code === "PRICE_CHANGED" || failure.code === "INSUFFICIENT_STOCK") offer.retry();
      } else {
        setError("Your reservation isn't confirmed yet. Try again: retrying won't reserve twice.");
      }
      setSubmitting(false);
    }
  }

  return (
    <main className="light page">
      <div className="wrap">
        <a className="back" href="/#passes">Back to passes</a>
        <Status {...offer} loading={offer.loading && !pass} />
        {pass && unitPrice && (
          <div className="reserve">
            <div className="reserve-intro">
              <p>Day {pass.day}, {dayName(pass.salesCloseAt)}. {includesSummary(pass)}.</p>
              <h1>{pass.name}</h1>
              <p>{pass.description}</p>
              <Perks perks={pass.perks} />
              <p style={{ marginTop: 24 }}><Availability offer={pass} /></p>
            </div>

            <form className="form-card" onSubmit={submit} aria-label={`Reserve ${pass.name}`}>
              <label className="field">
                Name on the pass
                <input
                  type="text" autoComplete="name" maxLength={80} required
                  value={attempt?.leadName ?? leadName} disabled={!!attempt || submitting}
                  onChange={event => setLeadName(event.target.value)}
                />
                <span className="hint">One name covers every pass in this reservation.</span>
              </label>

              <div className="field">
                <span id="quantity-label">Number of passes</span>
                <div className="stepper" role="group" aria-labelledby="quantity-label">
                  <button type="button" aria-label="One fewer pass" disabled={!!attempt || submitting || count <= 1} onClick={() => setQuantity(value => value - 1)}>−</button>
                  <output aria-live="polite">{count}</output>
                  <button type="button" aria-label="One more pass" disabled={!!attempt || submitting || count >= maxQuantity} onClick={() => setQuantity(value => value + 1)}>+</button>
                </div>
                <span className="hint">Up to {pass.maxPerReservation} per reservation.</span>
              </div>

              <div className="total">
                <span>{count} × {money(unitPrice)}</span>
                <strong>{money({ ...unitPrice, amountMinor: unitPrice.amountMinor * count })}</strong>
              </div>

              {error && <div className="notice error" role="alert">{error}</div>}

              {onSale || attempt ? (
                <button className="button button-gold button-block" disabled={submitting || (!attempt && !leadName.trim())}>
                  {submitting ? "Reserving" : attempt ? "Try again" : `Reserve ${count} ${count === 1 ? "pass" : "passes"}`}
                </button>
              ) : (
                <p className="notice" role="status">This pass isn't on sale right now.</p>
              )}
              {attempt && !submitting && (
                <button type="button" className="text-button" onClick={clearAttempt}>Start a new reservation</button>
              )}
              <p className="fine-print">Price and availability are confirmed when you reserve. No payment is taken now.</p>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
