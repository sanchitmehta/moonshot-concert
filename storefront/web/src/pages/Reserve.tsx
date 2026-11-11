import { useEffect, useRef, useState, type FormEvent } from "react";
import { Availability, dayName, includesSummary, money, Perks, Status, useNow } from "../components.tsx";
import { api, randomToken, RequestError, useResource, type Money, type Offer, type Reservation } from "../api.ts";
import { confirmedOnRetryKey, loadSession } from "../session.ts";
import { forgetLineProgress, useLineProgress, WaitingRoom, type PlaceInLine } from "./WaitingRoom.tsx";
import "./reserve.css";

/** A reservation this tab has sent. It is kept until the answer is known, so trying again repeats the same request and never makes a second payment. */
type Attempt = {
  idempotencyKey: string;
  accessKey: string;
  leadName: string;
  quantity: number;
  walletId: string;
  expectedUnitPrice: Money;
  /** The last answer: none yet (SENT), the service couldn't finish (UNCONFIRMED), or we couldn't reach it (UNREACHABLE). */
  answer?: "SENT" | "UNCONFIRMED" | "UNREACHABLE";
  /** The turn in line this was sent with is over, so it can no longer be completed. */
  turnEnded?: boolean;
  tries?: number;
  lastTriedAt?: number;
};

const attemptKey = (offerId: string) => `moonshot-fest:reservation:${offerId}`;
const lineKey = (offerId: string) => `moonshot-fest:line:${offerId}`;
const turnOverCodes = ["ADMISSION_EXPIRED", "ADMISSION_REQUIRED", "ADMISSION_USED", "ENTRY_NOT_FOUND"];

/** Moonshot Wallet IDs look like MSW-1234-5678; the last digit is a Luhn check digit. */
export function walletIdValid(input: string): boolean {
  const match = /^MSW-(\d{4})-(\d{4})$/.exec(input.trim().toUpperCase());
  if (!match) return false;
  const digits = match[1]! + match[2]!;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function formatWalletId(input: string): string {
  const digits = input.toUpperCase().replace(/^MSW-?/, "").replace(/\D/g, "").slice(0, 8);
  return digits.length === 0 ? "" : `MSW-${digits.slice(0, 4)}${digits.length > 4 ? `-${digits.slice(4)}` : ""}`;
}

const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const timeOfDay = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

function Corners() {
  return (
    <>
      <span className="rs-corner tr" aria-hidden="true" />
      <span className="rs-corner bl" aria-hidden="true" />
    </>
  );
}

const steps = ["Join the line", "Wait for your turn", "Reserve and pay"];

function Steps({ current }: { current: number }) {
  return (
    <ol className="rs-steps" aria-label="Steps to reserve">
      {steps.map((label, index) => (
        <li key={label} className={index < current ? "is-done" : index === current ? "is-current" : undefined} aria-current={index === current ? "step" : undefined}>
          <span className="rs-step-number" aria-hidden="true">{index < current ? "✓" : index + 1}</span>
          <span className="rs-step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

const heardBack = {
  UNCONFIRMED: "Your payment was submitted, but we couldn't confirm your passes.",
  UNREACHABLE: "We couldn't reach Moonshot Fest, so we don't know yet whether your payment went through.",
  SENT: "This page was reloaded before we heard back, so we don't know yet whether your payment went through.",
};

/** A reservation that was sent but has no confirmation yet, and the moment it gets one. */
function Pending({ attempt, passName, total, secondsLeft, turnOver, busy, confirmed, focus, onRetry, onRestart, onRejoin }: {
  attempt: Attempt;
  passName: string;
  total: string;
  secondsLeft: number | undefined;
  turnOver: boolean;
  busy: boolean;
  confirmed: Reservation | undefined;
  focus: boolean;
  onRetry: () => void;
  onRestart: () => void;
  onRejoin: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // This panel takes the place of the form, which is taller, so bring it into view and move focus with it.
  useEffect(() => {
    if (!focus || !panel.current) return;
    heading.current?.focus({ preventScroll: true });
    const fits = panel.current.getBoundingClientRect().height <= window.innerHeight - 104;
    panel.current.scrollIntoView({ block: fits ? "nearest" : "start" });
  }, [focus]);

  const answer = attempt.answer ?? "SENT";
  const tries = attempt.tries ?? 0;
  const title = confirmed ? "Confirmed. You're going to the Moon."
    : turnOver ? "Your turn ended before this was confirmed"
    : "Your reservation isn't confirmed yet";
  const lede = confirmed ? "Taking you to your pass."
    : turnOver ? `${heardBack[answer]} Your turn has now ended, so this reservation can't be finished from this page. Check your Moonshot Wallet before you reserve again: a new reservation is a separate payment.`
    : `${heardBack[answer]} Your place in line and your details are kept on this page. Try again: retrying won't charge you twice.`;
  const pill = confirmed ? "Confirmed" : turnOver ? "Turn ended" : busy ? "Confirming" : "Not confirmed yet";
  const tone = confirmed ? "confirmed" : turnOver ? "over" : "waiting";

  const progress = [
    {
      label: "Payment",
      state: confirmed || answer === "UNCONFIRMED" ? "done" : "unknown",
      text: confirmed ? (confirmed.payment ? `Paid ${money(confirmed.payment.amount)}` : "Paid") : answer === "UNCONFIRMED" ? "Submitted" : "Not known yet",
    },
    {
      label: "Reservation",
      state: confirmed ? "done" : turnOver ? "stopped" : "waiting",
      text: confirmed ? "Confirmed" : turnOver ? "Not confirmed" : busy ? "Confirming" : "Not confirmed yet",
    },
    {
      label: "Passes",
      state: confirmed ? "done" : "todo",
      text: confirmed ? "Ready" : turnOver ? "Not issued" : "Issued once confirmed",
    },
  ];

  return (
    <section ref={panel} className={`rs-panel rs-pending is-${tone}${busy ? " is-busy" : ""}`} aria-labelledby="pending-title">
      <p className="visually-hidden" role="status">
        {title}{!confirmed && !turnOver && tries > 1 ? ` Tried ${tries} times.` : ""}
      </p>
      <Corners />

      <div className="rs-pending-top">
        <div className="rs-pending-copy">
          <p className="rs-pill"><span className="rs-dot" />{pill}</p>
          <h2 id="pending-title" ref={heading} tabIndex={-1}>{title}</h2>
          <p className="rs-pending-lede">{lede}</p>
        </div>

        {confirmed ? (
          <p className="rs-code">
            <span>Confirmation code</span>
            <strong>{confirmed.confirmationCode}</strong>
          </p>
        ) : turnOver ? (
          <div className="rs-pending-actions">
            <button type="button" className="button button-gold rs-cta" onClick={onRejoin}>Join the line again</button>
            <p className="rs-assure">Joining again starts a new reservation.</p>
          </div>
        ) : (
          <div className="rs-pending-actions">
            <button type="button" className="button button-gold rs-cta" onClick={onRetry} disabled={busy} aria-busy={busy}>
              {busy ? <><span className="rs-spinner" aria-hidden="true" />Confirming</> : "Try again"}
            </button>
            <p className="rs-assure">Retrying is safe. It repeats this same reservation, so you won't be charged twice.</p>
            <p className="rs-tried">
              {tries > 0 && attempt.lastTriedAt ? `Tried ${tries} ${tries === 1 ? "time" : "times"}, last at ${timeOfDay(attempt.lastTriedAt)}. ` : ""}
              {secondsLeft !== undefined && <>Your turn is held for <span role="timer" aria-label="Time left on your turn">{minutesSeconds(secondsLeft)}</span>.</>}
            </p>
          </div>
        )}
      </div>

      <ol className="rs-progress">
        {progress.map(step => (
          <li key={step.label} className={`is-${step.state}`}>
            <span className="rs-node" aria-hidden="true" />
            <span className="rs-progress-label">{step.label}</span>
            <strong>{step.text}</strong>
          </li>
        ))}
      </ol>

      <div className="rs-pending-foot">
        <dl className="rs-facts">
          <div><dt>Pass</dt><dd>{passName} × {attempt.quantity}</dd></div>
          <div><dt>Name on the pass</dt><dd>{attempt.leadName}</dd></div>
          <div><dt>Moonshot Wallet</dt><dd>•••• {attempt.walletId.slice(-4)}</dd></div>
          <div><dt>Total</dt><dd>{total}</dd></div>
        </dl>
        {!confirmed && !turnOver && (
          <p className="rs-restart">
            <button type="button" className="text-button" onClick={onRestart} disabled={busy}>Start a new reservation</button>
            <span>A new reservation is a separate payment.</span>
          </p>
        )}
      </div>
    </section>
  );
}

export function Reserve({ offerId }: { offerId: string }) {
  const offer = useResource<Offer>(`/offers/${encodeURIComponent(offerId)}`);
  const [ticket, setTicket] = useState(() => loadSession<string>(lineKey(offerId)));
  const line = useResource<PlaceInLine>(ticket ? `/waiting-room/${ticket}` : "", { refreshMs: ticket ? 5000 : undefined });
  const [attempt, setAttempt] = useState(() => loadSession<Attempt>(attemptKey(offerId)));
  const [leadName, setLeadName] = useState(attempt?.leadName ?? "");
  const [quantity, setQuantity] = useState(attempt?.quantity ?? 1);
  const [walletId, setWalletId] = useState(attempt?.walletId ?? "");
  const [joining, setJoining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Where the request now in flight, or the last one, was sent from. The form stays in view until its first answer. */
  const [sentFrom, setSentFrom] = useState<"form" | "retry">();
  const [confirmed, setConfirmed] = useState<Reservation>();
  const [error, setError] = useState<string>();

  const pass = offer.data;
  const place = ticket ? line.data : undefined;
  const progress = useLineProgress(offerId, ticket, place, line.updatedAt);
  const now = useNow();
  const unitPrice = attempt?.expectedUnitPrice ?? pass?.unitPrice;
  const count = attempt?.quantity ?? quantity;
  const maxQuantity = pass ? Math.max(1, Math.min(pass.maxPerReservation, pass.availability.remaining)) : 1;
  const onSale = pass?.availability.saleStatus === "ON_SALE";
  const walletReady = walletIdValid(attempt?.walletId ?? walletId);
  const walletWrong = walletId.length === 13 && !walletReady;
  const total = unitPrice ? money({ ...unitPrice, amountMinor: unitPrice.amountMinor * count }) : "";
  const secondsLeft = place?.status === "ADMITTED" && place.admissionExpiresAt
    ? Math.max(0, Math.round((Date.parse(place.admissionExpiresAt) - now) / 1000))
    : undefined;
  const lineLost = !!ticket && line.errorCode === "ENTRY_NOT_FOUND";

  const saveAttempt = (next: Attempt) => {
    sessionStorage.setItem(attemptKey(offerId), JSON.stringify(next));
    setAttempt(next);
  };
  const clearAttempt = () => {
    sessionStorage.removeItem(attemptKey(offerId));
    setAttempt(undefined);
  };
  const leaveLine = () => {
    sessionStorage.removeItem(lineKey(offerId));
    forgetLineProgress(offerId);
    setTicket(undefined);
  };

  // The line no longer knows this place, so waiting here would never end. An unanswered reservation stays in view instead.
  useEffect(() => {
    if (!lineLost || attempt) return;
    leaveLine();
    setError("We couldn't find your place in line. Join the line again to get a new one.");
  }, [lineLost, attempt]);

  async function joinLine() {
    setJoining(true);
    setError(undefined);
    try {
      const joined = await api<PlaceInLine & { ticket: string }>("/waiting-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId }),
      });
      sessionStorage.setItem(lineKey(offerId), JSON.stringify(joined.ticket));
      setTicket(joined.ticket);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We couldn't add you to the line. Please try again.");
    } finally {
      setJoining(false);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!pass || !ticket || submitting) return;
    if (!walletReady) {
      setError("Check your Moonshot Wallet ID. It looks like MSW-1234-5678.");
      return;
    }
    const retry = !!attempt;
    const current: Attempt = attempt ?? {
      idempotencyKey: randomToken(16),
      accessKey: randomToken(32),
      leadName: leadName.trim(),
      quantity,
      walletId: walletId.trim().toUpperCase(),
      expectedUnitPrice: pass.unitPrice,
      answer: "SENT",
    };
    saveAttempt(current);
    setSentFrom(retry ? "retry" : "form");
    setSubmitting(true);
    setError(undefined);
    try {
      const reservation = await api<Reservation>("/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.idempotencyKey },
        body: JSON.stringify({
          offerId, leadName: current.leadName, quantity: current.quantity, walletId: current.walletId,
          expectedUnitPrice: current.expectedUnitPrice, accessKey: current.accessKey, ticket,
        }),
      });
      sessionStorage.removeItem(attemptKey(offerId));
      sessionStorage.removeItem(lineKey(offerId));
      forgetLineProgress(offerId);
      const confirmation = `/confirmation/${encodeURIComponent(reservation.confirmationCode)}#key=${current.accessKey}`;
      if (!retry) {
        window.location.assign(confirmation);
        return;
      }
      // After a wait, show that it went through before moving on.
      sessionStorage.setItem(confirmedOnRetryKey(reservation.confirmationCode), "1");
      setConfirmed(reservation);
      window.setTimeout(() => window.location.assign(confirmation), 1600);
    } catch (caught) {
      const failure = caught instanceof RequestError ? caught : new RequestError(0, "UNKNOWN", "Something went wrong.");
      const tried = { tries: (current.tries ?? 0) + 1, lastTriedAt: Date.now() };
      if (failure.status === 0 || failure.status >= 500) {
        // No clear answer. Keep the attempt, and what an earlier answer already told us about the payment.
        const answer = failure.status >= 500 || current.answer === "UNCONFIRMED" ? "UNCONFIRMED" : "UNREACHABLE";
        saveAttempt({ ...current, ...tried, answer });
      } else if (retry && turnOverCodes.includes(failure.code)) {
        saveAttempt({ ...current, ...tried, turnEnded: true });
      } else {
        // The request was refused, so nothing is waiting on an answer.
        clearAttempt();
        setError(retry ? `${failure.message} Your earlier try wasn't confirmed. Check your Moonshot Wallet before you reserve again.` : failure.message);
        if (turnOverCodes.includes(failure.code)) leaveLine();
        if (failure.code === "PRICE_CHANGED" || failure.code === "INSUFFICIENT_STOCK") offer.retry();
      }
      setSubmitting(false);
    }
  }

  const rejoin = () => {
    clearAttempt();
    leaveLine();
    void joinLine();
  };

  const pending = !!attempt && !(submitting && sentFrom === "form");
  const turnOver = !!attempt && (!!attempt.turnEnded || !ticket || lineLost || place?.status === "EXPIRED");
  const reserving = !!attempt || place?.status === "ADMITTED";
  const step = reserving ? 2 : ticket && place?.status === "WAITING" ? 1 : 0;

  return (
    <main className="page reserve-page">
      <div className="wrap">
        <a className="back" href="/#passes"><span aria-hidden="true">←</span> Back to passes</a>
        <Status {...offer} loading={offer.loading && !pass} />
        {pass && unitPrice && (
          <>
            <header className={`rs-head${ticket || attempt ? " is-compact" : ""}`}>
              <div className="rs-head-main">
                <p className="rs-kicker">Day {pass.day} · {dayName(pass.salesCloseAt)} · {includesSummary(pass)}</p>
                <h1>{pass.name}</h1>
                <p className="rs-lede">{pass.description}</p>
                <Perks perks={pass.perks} className="rs-perks" />
              </div>
              <div className="rs-head-price">
                <p className="rs-price">{money(unitPrice)}<span>per pass</span></p>
                <p className="rs-availability"><Availability offer={pass} tone="dark" /></p>
              </div>
            </header>

            <Steps current={confirmed ? steps.length : step} />

            {pending ? (
              <Pending
                attempt={attempt} passName={pass.name} total={total} secondsLeft={secondsLeft}
                turnOver={turnOver && !submitting} busy={submitting && !confirmed} confirmed={confirmed} focus={!!sentFrom}
                onRetry={() => void submit()} onRestart={clearAttempt} onRejoin={rejoin}
              />
            ) : !ticket ? (
              <section className="rs-panel rs-join" aria-labelledby="join-title">
                <Corners />
                <div className="rs-join-copy">
                  <h2 id="join-title">Join the line</h2>
                  <p>Passes are released in turns to keep things fair. Join the line, and the reserve form opens when it's your turn.</p>
                </div>
                <div className="rs-join-action">
                  {error && <div className="notice error" role="alert">{error}</div>}
                  {onSale ? (
                    <button className="button button-gold rs-cta" onClick={() => void joinLine()} disabled={joining} aria-busy={joining}>
                      {joining ? <><span className="rs-spinner" aria-hidden="true" />Joining</> : "Join the line"}
                    </button>
                  ) : (
                    <p className="notice" role="status">This pass isn't on sale right now.</p>
                  )}
                  {onSale && <p className="rs-assure">You pay only when you reserve.</p>}
                </div>
              </section>
            ) : !place ? (
              !lineLost && <Status error={line.error} loading={line.loading} retry={line.retry} />
            ) : place.status === "WAITING" ? (
              <WaitingRoom place={place} progress={progress} passName={pass.name} offline={!!line.error} onLeave={leaveLine} />
            ) : place.status === "EXPIRED" || (place.status === "USED" && !attempt) ? (
              <section className="rs-panel rs-join is-over" aria-labelledby="over-title">
                <Corners />
                <div className="rs-join-copy">
                  <h2 id="over-title">{place.status === "EXPIRED" ? "Your turn has passed" : "Already reserved"}</h2>
                  <p>{place.status === "EXPIRED"
                    ? "Your 10 minutes to reserve ran out. Join the line again to get a new turn."
                    : "This place in line was already used for a reservation."}</p>
                </div>
                <div className="rs-join-action">
                  {error && <div className="notice error" role="alert">{error}</div>}
                  <button className="button button-gold rs-cta" onClick={rejoin} disabled={joining}>Join the line again</button>
                </div>
              </section>
            ) : (
              <section className="rs-panel rs-turn" aria-labelledby="turn-title">
                <p className="visually-hidden" role="status">It's your turn to reserve.</p>
                <Corners />
                <header className="rs-turn-head">
                  <div>
                    <p className="rs-pill"><span className="rs-dot" />Your turn</p>
                    <h2 id="turn-title">It's your turn</h2>
                    <p>Your place is held while the clock runs. Reserve before it reaches zero.</p>
                  </div>
                  {secondsLeft !== undefined && (
                    <p className={`rs-timer${secondsLeft <= 120 ? " is-low" : ""}`}>
                      <span className="rs-timer-label">Left to reserve</span>
                      <span className="rs-timer-value" role="timer" aria-label="Time left to reserve">{minutesSeconds(secondsLeft)}</span>
                    </p>
                  )}
                </header>

                <form className="rs-form" onSubmit={submit} aria-label={`Reserve ${pass.name}`}>
                  <div className="rs-fields">
                    <label className="rs-field">
                      Name on the pass
                      <input
                        type="text" autoComplete="name" maxLength={80} required
                        value={leadName} disabled={submitting}
                        onChange={event => setLeadName(event.target.value)}
                      />
                      <span className="rs-hint">One name covers every pass in this reservation.</span>
                    </label>

                    <label className="rs-field">
                      Moonshot Wallet ID
                      <input
                        type="text" inputMode="numeric" autoComplete="off" placeholder="MSW-1234-5678" required
                        value={walletId} disabled={submitting} aria-invalid={walletWrong}
                        onChange={event => setWalletId(formatWalletId(event.target.value))}
                      />
                      <span className={`rs-hint${walletWrong ? " is-wrong" : ""}`}>
                        {walletWrong
                          ? "That wallet ID doesn't look right. Check the number on your wallet."
                          : "From the wallet you collected at the Moonshot Earth Centre."}
                      </span>
                    </label>

                    <div className="rs-field">
                      <span id="quantity-label">Number of passes</span>
                      <div className="rs-stepper" role="group" aria-labelledby="quantity-label">
                        <button type="button" aria-label="One fewer pass" disabled={submitting || count <= 1} onClick={() => setQuantity(value => value - 1)}>−</button>
                        <output aria-live="polite">{count}</output>
                        <button type="button" aria-label="One more pass" disabled={submitting || count >= maxQuantity} onClick={() => setQuantity(value => value + 1)}>+</button>
                      </div>
                      <span className="rs-hint">Up to {pass.maxPerReservation} per reservation.</span>
                    </div>
                  </div>

                  <div className="rs-order">
                    <p className="rs-order-title">Your reservation</p>
                    <p className="rs-order-line"><span>{pass.name}</span><span>{count} × {money(unitPrice)}</span></p>
                    <p className="rs-order-total"><span>Total</span><strong>{total}</strong></p>
                    {error && <div className="notice error" role="alert">{error}</div>}
                    <button className="button button-gold rs-cta" disabled={submitting || !leadName.trim() || !walletReady} aria-busy={submitting}>
                      {submitting ? <><span className="rs-spinner" aria-hidden="true" />Reserving</> : `Reserve and pay ${total}`}
                    </button>
                    <p className="rs-fine">Price and availability are confirmed when you reserve. You pay from your Moonshot Wallet.</p>
                  </div>
                </form>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
