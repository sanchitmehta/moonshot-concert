import { useEffect, useRef, useState } from "react";
import {
  Availability, dayName, festivalDates, HeroArt, includesSummary, longDayDate, money, Perks, ReserveLink,
  shortDate, sortOffers, Status, TimeUntil,
} from "../components.tsx";
import { useResource, type Festival, type Offer } from "../api.ts";

const experiences = [
  { value: "", label: "All passes" },
  { value: "general", label: "General admission" },
  { value: "vip", label: "VIP" },
  { value: "drop", label: "Limited drops" },
  { value: "shuttle", label: "Shuttle only" },
] as const;

function Hero({ festival }: { festival?: Festival }) {
  return (
    <section className="hero">
      <HeroArt />
      <div className="hero-content">
        <h1 className="hero-wordmark"><span>Moonshot</span><span>Fest</span></h1>
        <p className="hero-lede">Three days of music in Tycho Crater, with Earth rising behind the main stage.</p>
        {festival && <p className="hero-when">{festivalDates(festival)}, {festival.venue}</p>}
        <div className="hero-actions">
          <a className="button button-gold" href="#passes">Find your pass</a>
          <a className="link" href="#lineup">See the lineup</a>
        </div>
        {festival && <p className="hero-countdown">Gates open in <TimeUntil until={festival.startsAt} /></p>}
      </div>
    </section>
  );
}

function Lineup({ festival }: { festival: Festival }) {
  return (
    <section id="lineup" className="section">
      <div className="wrap">
        <div className="section-head">
          <h2>Three days, nine artists, one crater</h2>
          <p>Each night ends on the Main stage as Earth climbs above the crater rim. The Crater stage runs from the moment gates open.</p>
        </div>
        <ol className="lineup">
          {festival.days.map(day => {
            const acts = festival.lineup.filter(act => act.day === day.day);
            const headliner = acts.find(act => act.headliner);
            return (
              <li className="lineup-day" key={day.day}>
                <time dateTime={day.date}>Day {day.day}, {dayName(day.gatesOpenAt)} {shortDate(day.gatesOpenAt).split(", ")[1]}</time>
                {headliner && <h3>{headliner.artist}</h3>}
                <ul>
                  {acts.filter(act => !act.headliner).map(act => (
                    <li key={act.artist}>{act.artist} <small>on the {act.stage} stage</small></li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function Drops({ offers }: { offers: Offer[] }) {
  if (!offers.length) return null;
  return (
    <section id="drops" className="section drops-section">
      <div className="wrap">
        <div className="section-head">
          <h2>Limited drops</h2>
          <p>Experiences with only a few dozen places each. Counts update while you watch.</p>
        </div>
        <div className="drops">
          {offers.map(offer => (
            <article className="drop" key={offer.offerId}>
              <div>
                <h3>{offer.name}</h3>
                <p className="drop-day">Day {offer.day}, {dayName(offer.salesCloseAt)}</p>
              </div>
              <p className="drop-price">{money(offer.unitPrice)}<small>per pass</small></p>
              <div className="drop-body">
                <p>{offer.description}</p>
                <Perks perks={offer.perks} />
                <div className="drop-foot">
                  <Availability offer={offer} />
                  <ReserveLink offer={offer} />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PassRow({ offer }: { offer: Offer }) {
  const kind = offer.saleType === "LIMITED_DROP" ? "drop-row" : offer.access === null ? "shuttle-only" : offer.access === "VIP" ? "vip" : "general";
  return (
    <li className={`pass-row ${kind}`}>
      <div>
        <h3>{offer.name.replace(/^Day \d+ /, "")}</h3>
        <p className="meta">{includesSummary(offer)}{offer.limitedAvailability && offer.saleType === "STANDARD" ? ", limited availability" : ""}</p>
        <Perks perks={offer.perks} />
      </div>
      <Availability offer={offer} />
      <p className="price">{money(offer.unitPrice)} <small>each</small></p>
      <ReserveLink offer={offer} />
    </li>
  );
}

function Passes({ festival }: { festival?: Festival }) {
  const initial = new URLSearchParams(window.location.search);
  const [day, setDay] = useState(initial.get("day") ?? "");
  const [experience, setExperience] = useState(initial.get("experience") ?? "");
  const query = new URLSearchParams();
  if (day) query.set("day", day);
  if (experience) query.set("experience", experience);
  const offers = useResource<Offer[]>(`/offers?${query}`, { refreshMs: 15_000 });

  return (
    <section id="passes" className="section light">
      <div className="wrap">
        <div className="section-head">
          <h2>Choose your pass</h2>
          <p>Every pass covers one festival day. Add the shuttle to ride between the lunar arrival hub and the crater.</p>
        </div>
        <div className="filters">
          <div className="tabs" role="group" aria-label="Festival day">
            <button aria-pressed={day === ""} onClick={() => setDay("")}>All days</button>
            {festival?.days.map(d => (
              <button key={d.day} aria-pressed={day === String(d.day)} onClick={() => setDay(String(d.day))}>
                {shortDate(d.gatesOpenAt)}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Type of pass">
            {experiences.map(option => (
              <button key={option.value} aria-pressed={experience === option.value} onClick={() => setExperience(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <Status {...offers} loading={offers.loading && !offers.data} />
        {offers.data && (offers.data.length
          ? (
            <div className="pass-days" aria-live="polite">
              {[1, 2, 3].map(dayNumber => {
                const dayOffers = sortOffers(offers.data!.filter(offer => offer.day === dayNumber));
                if (!dayOffers.length) return null;
                const info = festival?.days.find(d => d.day === dayNumber);
                return (
                  <section key={dayNumber} className="pass-day" aria-label={`Day ${dayNumber} passes`}>
                    <h3 className="pass-day-title">
                      Day {dayNumber}{info ? <span>{dayName(info.gatesOpenAt)}, {longDayDate(info.gatesOpenAt)}</span> : null}
                    </h3>
                    <ul className="pass-list">{dayOffers.map(offer => <PassRow key={offer.offerId} offer={offer} />)}</ul>
                  </section>
                );
              })}
            </div>
          )
          : <p className="empty">No passes match. Try another day or type of pass.</p>)}
      </div>
    </section>
  );
}

function GettingThere() {
  return (
    <section id="getting-there" className="section">
      <div className="wrap">
        <div className="section-head"><h2>Getting there</h2></div>
        <div className="facts">
          <div>
            <h3>Arrive at the lunar arrival hub</h3>
            <p>Every landing comes in at the hub on the edge of Tycho Crater. From there it is a short ride to the festival site.</p>
          </div>
          <div>
            <h3>Take the shuttle</h3>
            <p>Shuttles run between the hub and the crater from three hours before gates open until the last set ends. Add one to your pass or reserve it on its own.</p>
          </div>
          <div>
            <h3>One pass, one day</h3>
            <p>Each pass is for a single festival day. Reserve up to six passes at a time under one name.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Home() {
  const festival = useResource<Festival>("/festival");
  const drops = useResource<Offer[]>("/offers?experience=drop", { refreshMs: 15_000 });
  const scrolledToHash = useRef(false);

  // Content above the anchors loads asynchronously, so re-apply the URL's #section once it has.
  useEffect(() => {
    if (scrolledToHash.current || !festival.data || !drops.data || !window.location.hash) return;
    scrolledToHash.current = true;
    requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView());
  }, [festival.data, drops.data]);

  return (
    <>
      <Hero festival={festival.data} />
      {festival.error && <div className="wrap"><Status {...festival} /></div>}
      {festival.data && <Lineup festival={festival.data} />}
      <Drops offers={drops.data ?? []} />
      <Passes festival={festival.data} />
      <GettingThere />
    </>
  );
}
