import { useState } from "react";
import { clock, dayName, includesSummary, longDate, money, Status } from "../components.tsx";
import { useResource, type Festival, type Reservation } from "../api.ts";
import { Confetti } from "../motion.tsx";

export function Confirmation({ confirmationCode }: { confirmationCode: string }) {
  const accessKey = new URLSearchParams(window.location.hash.slice(1)).get("key") ?? "";
  const reservation = useResource<Reservation>(`/reservations/${encodeURIComponent(confirmationCode)}`, {
    headers: { "X-Reservation-Access-Key": accessKey },
  });
  const festival = useResource<Festival>("/festival");
  const [copied, setCopied] = useState<string>();
  const data = reservation.data;
  const day = festival.data?.days.find(d => d.day === data?.pass.day);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("Link copied. Keep it private: anyone who has it can view this reservation.");
    } catch {
      setCopied("We couldn't copy the link. Copy the address from your browser's address bar instead.");
    }
  }

  return (
    <main className="page">
      <div className="wrap confirmation">
        {!accessKey && (
          <p className="notice error" role="alert">This link is missing its private key. Open the full link you saved when you made the reservation.</p>
        )}
        {accessKey && <Status {...reservation} loading={reservation.loading && !data} />}
        {data && (
          <>
            <Confetti />
            <p className="print-only print-brand">Moonshot Fest</p>
            <h1>You're going to the Moon</h1>
            <p>Your reservation is confirmed. Save this page's private link or print your pass: the link is the only way to open this reservation again.</p>
            <article className="ticket" aria-label="Your pass">
              <div className="ticket-main">
                <header>
                  <div>
                    <p>{day ? `${dayName(day.gatesOpenAt)}, ${longDate(day.gatesOpenAt)}. Gates open at ${clock(day.gatesOpenAt)} UTC` : `Moonshot Fest, day ${data.pass.day}`}</p>
                    <h2>{data.pass.name}</h2>
                  </div>
                  <span className="ticket-status">Confirmed</span>
                </header>
                <dl className="ticket-grid">
                  <div><dt>Lead guest</dt><dd>{data.leadName}</dd></div>
                  <div><dt>Passes</dt><dd>{data.quantity}</dd></div>
                  <div><dt>What's included</dt><dd>{includesSummary(data.pass)}</dd></div>
                  <div><dt>Total price</dt><dd>{money(data.total)}</dd></div>
                  {data.payment && (
                    <div className="ticket-payment">
                      <dt>Payment</dt>
                      <dd>Paid with Moonshot Wallet •••• {data.payment.walletLast4} · balance {money(data.payment.balanceAfter)}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <div className="ticket-stub">
                <div>
                  <p className="fine-print">Confirmation code</p>
                  <p className="ticket-code">{data.confirmationCode}</p>
                </div>
                <p className="fine-print">Reserved on {longDate(data.createdAt)}</p>
              </div>
            </article>
            <div className="confirmation-actions">
              <button className="button button-gold" onClick={() => void copyLink()}>Copy private link</button>
              <button className="button button-quiet" onClick={() => window.print()}>{data.quantity > 1 ? "Print passes" : "Print pass"}</button>
              <a className="link" href="/#passes">Browse more passes</a>
            </div>
            {copied && <p className="notice no-print" role="status" style={{ marginTop: 20 }}>{copied}</p>}
          </>
        )}
      </div>
    </main>
  );
}
