import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Confirmation } from "./pages/Confirmation.tsx";
import { Home } from "./pages/Home.tsx";
import { Invoice } from "./pages/Invoice.tsx";
import { Reserve } from "./pages/Reserve.tsx";

function Page({ path }: { path: string }) {
  if (path === "/") return <main><Home /></main>;
  if (path.startsWith("/reserve/")) return <Reserve offerId={decodeURIComponent(path.slice("/reserve/".length))} />;
  if (path.startsWith("/confirmation/")) {
    return <Confirmation confirmationCode={decodeURIComponent(path.slice("/confirmation/".length))} />;
  }
  if (path.startsWith("/invoice/")) return <Invoice confirmationCode={decodeURIComponent(path.slice("/invoice/".length))} />;
  return (
    <main className="page">
      <div className="wrap">
        <h1>This page drifted off</h1>
        <p style={{ margin: "16px 0 28px" }}>The page you're looking for doesn't exist.</p>
        <a className="button button-gold" href="/">Go to Moonshot Fest</a>
      </div>
    </main>
  );
}

function App() {
  const path = window.location.pathname;
  if (path === "/passes") {
    window.location.replace(`/${window.location.search}#passes`);
    return null;
  }
  const home = path === "/" ? "" : "/";
  return (
    <>
      <a className="visually-hidden" href="#content">Skip to content</a>
      <header className="site-header">
        <div className="wrap">
          <a className="wordmark" href="/">
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <circle cx="17" cy="17" r="15" fill="none"               stroke="#f4c452" strokeWidth="2" />
                            <path d="M21 6.5a11 11 0 1 0 0 21 9 9 0 1 1 0-21z" fill="#f4c452" />
            </svg>
            MOONSHOT FEST
          </a>
          <nav className="site-nav" aria-label="Main">
            <a href={`${home}#lineup`}>Lineup</a>
            <a href={`${home}#passes`}>Passes</a>
            <a href={`${home}#getting-there`}>Getting there</a>
          </nav>
          <a className="button button-small button-gold" href={`${home}#passes`}>Get passes</a>
        </div>
      </header>
      <div id="content"><Page path={path} /></div>
      <footer className="site-footer">
        <div className="wrap">
          <span className="footer-brand">MOONSHOT FEST</span>
          <span>Moonshot Fest, Tycho Crater, the Moon · 20–22 August 2027</span>
          <nav aria-label="Footer">
            <a href={`${home}#lineup`}>Lineup</a>
            <a href={`${home}#passes`}>Passes</a>
            <a href={`${home}#getting-there`}>Getting there</a>
          </nav>
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
