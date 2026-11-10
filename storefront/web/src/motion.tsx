import { createElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentPropsWithoutRef, type ReactNode } from "react";

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type RevealProps = Omit<ComponentPropsWithoutRef<"div">, "ref"> & {
  as?: "div" | "article" | "li" | "section";
  delay?: number;
  children?: ReactNode;
};

// Fades and lifts the element into place the first time it scrolls into view.
export function Reveal({ as = "div", delay = 0, className = "", style, ...rest }: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || shown) return;
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setShown(true);
        observer.disconnect();
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  return createElement(as, {
    ...rest,
    ref,
    className: `reveal${shown ? " in" : ""} ${className}`.trim(),
    style: { ...style, "--delay": `${delay}ms` } as CSSProperties,
  });
}

// Publishes a smoothed pointer, scroll and idle-drift position as CSS variables so the hero art layers move at different depths.
export function useHeroParallax() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0, sy: 0 };
    let lastPointer = -Infinity;
    let frame = 0;
    const write = (name: string, value: number) => element.style.setProperty(name, value.toFixed(3));
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      target.x = (event.clientX / window.innerWidth - 0.5) * 2;
      target.y = (event.clientY / window.innerHeight - 0.5) * 2;
      lastPointer = performance.now();
    };
    const tick = (now: number) => {
      // With no pointer input the camera drifts on its own so the depth is visible without touching anything.
      if (now - lastPointer > 1800) {
        target.x = Math.sin(now / 2400) * 0.9;
        target.y = Math.cos(now / 3100) * 0.6;
      }
      current.x += (target.x - current.x) * 0.06;
      current.y += (target.y - current.y) * 0.06;
      current.sy += (Math.min(window.scrollY, 900) - current.sy) * 0.12;
      write("--px", current.x);
      write("--py", current.y);
      write("--sy", current.sy);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.addEventListener("pointermove", onPointer);
    return () => {
      window.removeEventListener("pointermove", onPointer);
      cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}

const confettiColors = ["#f4c452", "#b8c4de", "#eef0f6", "#8fe3c0", "#7db2ff"];

// One-shot burst of falling confetti, used when a reservation is confirmed.
export function Confetti({ count = 80 }: { count?: number }) {
  const [active, setActive] = useState(() => !prefersReducedMotion());
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setActive(false), 6500);
    return () => window.clearTimeout(timer);
  }, [active]);
  const pieces = useMemo(() => Array.from({ length: count }, (_, index) => ({
    left: Math.random() * 100,
    delay: Math.random() * 900,
    duration: 2600 + Math.random() * 2200,
    drift: (Math.random() - 0.5) * 260,
    spin: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720),
    size: 6 + Math.random() * 7,
    color: confettiColors[index % confettiColors.length]!,
    round: index % 4 === 0,
  })), [count]);
  if (!active) return null;
  return (
    <div className="confetti no-print" aria-hidden="true">
      {pieces.map((piece, index) => (
        <span
          key={index}
          style={{
            left: `${piece.left}%`, width: piece.size, height: piece.round ? piece.size : piece.size * 0.45, background: piece.color,
            borderRadius: piece.round ? "50%" : 1, animationDelay: `${piece.delay}ms`, animationDuration: `${piece.duration}ms`,
            "--drift": `${piece.drift}px`, "--spin": `${piece.spin}deg`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
