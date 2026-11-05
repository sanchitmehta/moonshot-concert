import { Countdown, longDate, Moon, OfferCard, Status } from "../components.tsx";
import { useResource, type Festival, type Offer } from "../api.ts";

export function Home() {
  const festival = useResource<Festival>("/festival");
  const drops = useResource<Offer[]>("/offers?experience=drop", { refreshMs: 15_000 });
  const data = festival.data;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="status-dot" /> THREE DAYS. ONE CRATER. NO GRAVITY.</p>
          <h1>Out of this<br />world.<br /><em>Into the music.</em></h1>
          <p className="hero-description">
            {data?.tagline ?? "A little further. A lot louder."} Two stages, nine artists, and an Earthrise you will never forget.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="/passes">Find your pass <span>↗</span></a>
            <a className="underlined" href="#lineup">See the lineup ↓</a>
          </div>
          {data && <p className="location">{longDate(data.startsAt)} – {longDate(data.days[2]!.date)}<br />{data.venue}</p>}
        </div>
        <Moon />
      </section>

      <Status {...festival} />

      {data && (
        <>
          <section className="countdown-strip">
            <div><p className="eyebrow">GATES OPEN IN</p><h2>Next stop: the Moon.</h2></div>
            <Countdown until={data.startsAt} label="Time until gates open" />
          </section>

          <section id="lineup" className="section">
            <div className="section-heading">
              <div><p className="eyebrow">THE LINEUP</p><h2>Worth the journey.</h2></div>
              <span className="small-note">3 DAYS · MAIN AND CRATER STAGES</span>
            </div>
            <div className="lineup">
              {data.days.map(day => (
                <div className="artist" key={day.day}>
                  <span>DAY {day.day} · {longDate(day.date).toUpperCase()}</span>
                  {data.lineup.filter(act => act.day === day.day).map(act => (
                    act.headliner ? <h3 key={act.artist}>{act.artist}</h3> : <p key={act.artist} className="support-act">{act.artist} · {act.stage}</p>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {drops.data && drops.data.length > 0 && (
        <section className="section">
          <div className="section-heading">
            <div><p className="eyebrow">EXCLUSIVE DROPS</p><h2>Small drops. Big moments.</h2></div>
            <a className="underlined" href="/passes?experience=drop">All drops ↗</a>
          </div>
          <div className="offer-grid">{drops.data.map(offer => <OfferCard key={offer.offerId} offer={offer} />)}</div>
        </section>
      )}
    </>
  );
}
