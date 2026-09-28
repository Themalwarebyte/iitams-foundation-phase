import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * IITAMS Visual Background System
 * ===============================
 * A reusable, professional animated background for the login page, landing
 * hero and dashboard headers. Layers:
 *
 *   1. Base ink gradient (deep institutional blue → near-black teal)
 *   2. Fine engineering grid (static, CSS-only)
 *   3. Aurora glow blobs (very slow CSS drift)
 *   4. Network node particles (canvas, gentle drift + faint links)
 *   5. Optional photographic layer with cinematic pan + cross-fade
 *
 * Accessibility & performance:
 *   - `useReducedMotion()` (Framer) + `matchMedia` freeze all canvas/CSS motion
 *     and render the static fallback (grid + gradient, no particles, no pan).
 *   - Canvas particle count adapts to viewport; a single rAF loop is shared.
 *   - Text contrast is preserved by the dark ink base and scrim utilities.
 */

const NODE_STYLE = {
  minRadius: 0.9,
  maxRadius: 2.1,
  maxSpeed: 0.16, // px per frame — deliberately slow
  linkDistance: 130,
  linkOpacity: 0.14,
  nodeOpacity: 0.5,
  accentNodeColor: "#4EB5F5",
  baseNodeColor: "#9EC9E8",
  accentShare: 0.22,
  linkColor: "#7FB7E3",
};

interface VisualBackgroundProps {
  /** "full" fills the viewport; "banner" suits section headers. */
  variant?: "full" | "banner";
  /** Optional photo layers (object URLs / imported assets) cross-faded slowly. */
  images?: string[];
  /** Extra classes for the root element. */
  className?: string;
  /** Render particles (disable for very small banners). */
  particles?: boolean;
  /** Accessible description for assistive tech. */
  ariaLabel?: string;
  children?: React.ReactNode;
}

export function VisualBackground({
  variant = "full",
  images = [],
  className,
  particles = true,
  ariaLabel = "Decorative animated network background",
  children,
}: VisualBackgroundProps) {
  const prefersReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    // Belt and braces: also honor the media query directly so the canvas
    // freezes even if Framer's provider isn't mounted yet.
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isStatic = Boolean(prefersReducedMotion) || reducedMotion;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const particleCount = useMemo(() => {
    if (typeof window === "undefined") return 0;
    const area = window.innerWidth * window.innerHeight;
    const density = variant === "full" ? 14000 : 22000;
    return Math.min(90, Math.max(14, Math.round(area / density)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  useEffect(() => {
    if (isStatic || !particles || particleCount === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    interface Node {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      accent: boolean;
      tw: number;
    }

    const nodes: Node[] = Array.from({ length: particleCount }, () => ({
      x: Math.random() * canvas.clientWidth,
      y: Math.random() * canvas.clientHeight,
      vx: (Math.random() - 0.5) * NODE_STYLE.maxSpeed * 2,
      vy: (Math.random() - 0.5) * NODE_STYLE.maxSpeed * 2,
      r:
        NODE_STYLE.minRadius +
        Math.random() * (NODE_STYLE.maxRadius - NODE_STYLE.minRadius),
      accent: Math.random() < NODE_STYLE.accentShare,
      tw: Math.random() * Math.PI * 2,
    }));

    const step = () => {
      if (!running) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // links first (under nodes)
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < NODE_STYLE.linkDistance) {
            const alpha =
              (1 - dist / NODE_STYLE.linkDistance) * NODE_STYLE.linkOpacity;
            ctx.strokeStyle = `rgba(127, 183, 227, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        n.tw += 0.008;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if(n.y > h + 20) n.y = -20;

        const twinkle = 0.65 + 0.35 * Math.sin(n.tw);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle =
          (n.accent ? NODE_STYLE.accentNodeColor : NODE_STYLE.baseNodeColor) +
          Math.round((NODE_STYLE.nodeOpacity * twinkle * 255)).toString(16).padStart(2, "0");
        ctx.fill();
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [isStatic, particles, particleCount]);

  return (
    <div
      role="img"
      aria-label={isStatic ? "Decorative network background (static)" : ariaLabel}
      className={cn(
        "relative overflow-hidden bg-ink text-white",
        variant === "full" ? "min-h-full" : "min-h-[220px]",
        className,
      )}
    >
      {/* 1. Ink gradient base */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(155deg, oklch(0.26 0.05 243) 0%, oklch(0.2 0.05 246) 55%, oklch(0.16 0.04 248) 100%)",
        }}
      />
      {/* 2. Engineering grid (static fallback keeps this layer) */}
      <div aria-hidden className="absolute inset-0 bg-grid-network" />
      {/* 3. Aurora glow */}
      <div aria-hidden className="absolute inset-0 bg-aurora" />
      {/* 4. Particle canvas */}
      {particles && !isStatic && (
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full"
        />
      )}
      {/* 5. Photo/artwork layer(s) with cinematic pan + cross-fade.
          The parent clamps opacity at a subtle level so the cross-fading
          child never overpowers the particle layer or the text. */}
      {images.length > 0 && (
        <div aria-hidden className="absolute inset-0">
          {images.map((src, i) => (
            <div
              key={src + i}
              className="absolute inset-0"
              style={{ opacity: 0.22 }}
            >
              <div
                data-cinematic
                className="absolute inset-0 bg-cover bg-center"
                style={{
                  backgroundImage: `url(${src})`,
                  animation: isStatic
                    ? undefined
                    : `cinematic-pan 46s ease-in-out ${i % 2 === 0 ? "" : "reverse"} infinite alternate, bg-crossfade ${images.length * 14}s linear infinite`,
                  animationDelay: `${i * 7}s`,
                }}
              />
            </div>
          ))}
          <div className="absolute inset-0 bg-ink/60" />
        </div>
      )}
      {/* Bottom scrim to protect heading contrast */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3"
        style={{
          background:
            "linear-gradient(to top, oklch(0.16 0.04 248 / 85%), transparent)",
        }}
      />
      {children && <div className="relative z-10">{children}</div>}
    </div>
  );
}
