import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Confirmation } from "./pages/Confirmation.tsx";
import { Home } from "./pages/Home.tsx";
import { Passes } from "./pages/Passes.tsx";
import { Reserve } from "./pages/Reserve.tsx";
import "./style.css";

function Page({ path }: { path: string }) {
  if (path === "/") return <Home />;
  if (path === "/passes") return <Passes />;
  if (path.startsWith("/reserve/")) return <Reserve offerId={decodeURIComponent(path.slice("/reserve/".length))} />;
  if (path.startsWith("/confirmation/")) {
    return <Confirmation confirmationCode={decodeURIComponent(path.slice("/confirmation/".length))} />;
  }
  return (
    <section className="section page-section">
      <h1 className="page-title">Lost in space?</h1>
      <a className="button primary" href="/">Back to Moonshot Fest</a>
    </section>
  );
}

function App() {
  const path = window.location.pathname;
  return (
    <>
      <header className="header">
        <a className="brand" href="/" aria-label="Moonshot Fest home"><span>◒</span> moonshot<span className="brand-light"> fest</span></a>
        <nav aria-label="Main navigation">
          <a href="/#lineup">Lineup</a>
          <a href="/passes" aria-current={path === "/passes" ? "page" : undefined}>Passes</a>
        </nav>
        <a className="button outline small" href="/passes">Get passes ↗</a>
      </header>
      <main><Page path={path} /></main>
      <footer>
        <a className="brand" href="/">moonshot fest</a>
        <span>TYCHO CRATER · THE MOON</span>
        <span>A little further. A lot louder.</span>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
