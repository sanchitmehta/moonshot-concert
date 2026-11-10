import { longDate, money, Status } from "../components.tsx";
import { useResource, type Invoice as InvoiceData } from "../api.ts";

/** The invoice Moonshot Billing issued for a reservation. Opened from the confirmation page's private link. */
export function Invoice({ confirmationCode }: { confirmationCode: string }) {
  const accessKey = new URLSearchParams(window.location.hash.slice(1)).get("key") ?? "";
  const invoice = useResource<InvoiceData>(accessKey ? `/reservations/${encodeURIComponent(confirmationCode)}/invoice` : "", {
    headers: { "X-Reservation-Access-Key": accessKey },
  });
  const data = invoice.data;
  const confirmationLink = `/confirmation/${encodeURIComponent(confirmationCode)}#key=${accessKey}`;

  return (
    <main className="light page">
      <div className="wrap invoice-page">
        <a className="back no-print" href={confirmationLink}>Back to your reservation</a>
        {!accessKey && (
          <p className="notice error" role="alert">This link is missing its private key. Open the invoice from your reservation's private link.</p>
        )}
        {accessKey && <Status {...invoice} loading={invoice.loading && !data} />}
        {data && (
          <article className="invoice" aria-label={`Invoice ${data.invoiceNumber}`}>
            <header className="invoice-head">
              <div>
                <p className="invoice-brand">MOONSHOT FEST</p>
                <p className="fine-print">Tycho Crater, the Moon</p>
              </div>
              <div className="invoice-title">
                <h1>Invoice</h1>
                <p className="invoice-number">{data.invoiceNumber}</p>
                <span className="ticket-status">Paid</span>
              </div>
            </header>

            <dl className="invoice-facts">
              <div><dt>Billed to</dt><dd>{data.billedTo}</dd></div>
              <div><dt>Issued</dt><dd>{longDate(data.issuedAt)}</dd></div>
              <div><dt>Reservation</dt><dd>{data.reservationId}</dd></div>
            </dl>

            <table className="invoice-lines">
              <thead>
                <tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Amount</th></tr>
              </thead>
              <tbody>
                {data.lines.map(line => (
                  <tr key={line.description}>
                    <td>{line.description}</td>
                    <td>{line.quantity}</td>
                    <td>{money(line.unitPrice)}</td>
                    <td>{money(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row" colSpan={3}>Total paid</th><td>{money(data.total)}</td></tr>
              </tfoot>
            </table>

            <p className="invoice-payment">
              Paid with Moonshot Wallet •••• {data.payment.walletLast4} on {longDate(data.payment.paidAt)}.
              <span className="fine-print"> Payment {data.payment.paymentId}</span>
            </p>
          </article>
        )}
        {data && (
          <div className="confirmation-actions no-print">
            <button className="button button-gold" onClick={() => window.print()}>Print or save as PDF</button>
            <a className="link" href={confirmationLink}>Back to your reservation</a>
          </div>
        )}
      </div>
    </main>
  );
}
