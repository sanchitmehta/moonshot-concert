import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./motion.tsx";
import { createCanvasSky } from "./sky-canvas.ts";
import { createWebglSky } from "./sky-webgl.ts";
import type { Disc } from "./sky-scene.ts";

// Backing pixels for the canvas: enough to stay sharp on a projector without making a laptop GPU work for it.
const MAX_PIXELS = 2_400_000;
const MAX_DENSITY = 1.5;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The living sky behind the hero: the Moon, Earth, stars and the festival lights at Tycho.
 * It is decoration only. CSS places the Moon (.sky-moon); this follows that box, then adds the moonrise,
 * pointer depth and the slow sink as the page scrolls. Without a canvas the CSS Moon is shown as it is.
 */
export function HeroSky() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sky = ref.current;
    const stage = sky?.parentElement;
    const canvas = sky?.querySelector("canvas");
    const anchor = sky?.querySelector<HTMLElement>(".sky-moon");
    const title = stage?.querySelector<HTMLElement>(".hero-title");
    if (!sky || !stage || !canvas || !anchor) return;

    const renderer = createWebglSky(canvas) ?? createCanvasSky(canvas);
    const still = prefersReducedMotion();
    sky.dataset.mode = renderer ? "live" : "still";

    let width = 0, height = 0;
    let base: Disc = { x: 0, y: 0, r: 0 };
    let titleAt = { x: 0, y: 0 };
    let frame = 0;
    let visible = true;
    let started = 0;
    let lastPointer = -Infinity;
    const target = { x: 0, y: 0 };
    const drift = { x: 0, y: 0 };

    // The title is cut away where the Moon passes in front of it, so the letters appear to stand behind the limb.
    const coverTitle = (moon: Disc) => {
      if (!title) return;
      title.style.setProperty("--mx", `${(moon.x - titleAt.x).toFixed(1)}px`);
      title.style.setProperty("--my", `${(moon.y - titleAt.y).toFixed(1)}px`);
      title.style.setProperty("--mr", `${moon.r.toFixed(1)}px`);
    };

    const draw = (now: number) => {
      if (!started) started = now;
      const seconds = (now - started) / 1000;
      const rise = still ? 1 : 1 - (1 - clamp(seconds / 2.6, 0, 1)) ** 3;
      const scroll = still ? 0 : clamp(window.scrollY / height, 0, 1);
      if (!still) {
        // With no pointer input the camera drifts on its own so the depth is visible without touching anything.
        if (now - lastPointer > 1800) {
          target.x = Math.sin(now / 5200) * 0.7;
          target.y = Math.cos(now / 6700) * 0.5;
        }
        drift.x += (target.x - drift.x) * 0.045;
        drift.y += (target.y - drift.y) * 0.045;
      }
      const r = base.r * (0.92 + 0.08 * rise) * (1 - 0.16 * scroll);
      const moon = {
        x: base.x - drift.x * base.r * 0.045,
        y: base.y + (1 - rise) * height * 0.4 + scroll * height * 0.34 - drift.y * base.r * 0.03,
        r,
      };
      const earthRadius = clamp(base.r * 0.11, 13, 46);
      // On a narrow screen there is no room beside the Moon, so Earth sits below its shoulder instead.
      const beside = base.x + base.r * 1.72 <= width - earthRadius * 2.6;
      const earth = {
        x: (beside ? base.x + base.r * 1.72 : width - earthRadius * 2.6) - drift.x * base.r * 0.11,
        y: base.y + base.r * (beside ? -0.3 : 0.95) + scroll * height * 0.16 - drift.y * base.r * 0.07,
        r: earthRadius,
      };
      coverTitle(moon);
      renderer?.draw({ time: still ? 40 : seconds, moon, earth, drift, rise });
    };

    const tick = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      if (renderer && !still && visible && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const measure = () => {
      width = stage.clientWidth;
      height = stage.clientHeight;
      if (!width || !height) return;
      const stageBox = stage.getBoundingClientRect();
      const moonBox = anchor.getBoundingClientRect();
      base = { x: moonBox.left - stageBox.left + moonBox.width / 2, y: moonBox.top - stageBox.top + moonBox.height / 2, r: moonBox.width / 2 };
      if (title) {
        const titleBox = title.getBoundingClientRect();
        titleAt = { x: titleBox.left - stageBox.left, y: titleBox.top - stageBox.top };
      }
      const density = Math.min(window.devicePixelRatio || 1, MAX_DENSITY, Math.sqrt(MAX_PIXELS / (width * height)));
      renderer?.resize(width, height, density);
      if (!renderer) coverTitle(base);
      else if (still || !visible) draw(performance.now());
    };

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      target.x = (event.clientX / window.innerWidth - 0.5) * 2;
      target.y = (event.clientY / window.innerHeight - 0.5) * 2;
      lastPointer = performance.now();
    };

    const resizes = new ResizeObserver(measure);
    resizes.observe(stage);
    // Nothing is drawn while the hero is scrolled away or the tab is in the background.
    const sight = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      run();
    });
    sight.observe(stage);
    measure();
    run();
    document.addEventListener("visibilitychange", run);
    if (!still) window.addEventListener("pointermove", onPointer);

    return () => {
      cancelAnimationFrame(frame);
      resizes.disconnect();
      sight.disconnect();
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("pointermove", onPointer);
      renderer?.dispose();
    };
  }, []);

  return (
    <div className="sky" ref={ref} aria-hidden="true">
      <div className="sky-moon" />
      <canvas />
    </div>
  );
}
