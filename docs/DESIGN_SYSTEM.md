# IITAMS Design System

> Status: **Established (Phase 1)** · Theme: **Modern / institutional** ·
> Implementation: `src/index.css` (tokens) + `src/components/ui` (primitives)

IITAMS presents as a government-grade assurance platform: calm, spacious,
technically sophisticated. The system below is the single source of truth for
colour, type, spacing and component behaviour.

---

## 1. Colour system & provenance

### 1.1 Extraction methodology

The brief required inspecting the **current official Ministry of Information,
Communications and the Digital Economy (MICDE)** web presence and recording
real values rather than guessing. The live site (`https://www.ict.go.ke/`)
and its December 2024 capture (Internet Archive snapshot
`20241227022202`) were inspected; inline `<style>` blocks of the homepage
markup contain the active theme rules, from which the following were sampled:

| Sampled value | Where it appears on ict.go.ke | Role in IITAMS |
| --- | --- | --- |
| `#005A9A` | `.topbar{background:#005a9a}`, header/menu link colour, hover accent | **Primary** (buttons, active nav, focus ring, chart-1) |
| `#004E98` | Header deep-blue variant | **Primary-dark** (hero ink gradient base) |
| `#4EB5F5` | Sky-blue accent on link/icon highlights | **Info accent** (info severity, links, particles) |
| `#C2E9FF` / `#E1F2FF` | Light-blue section tints | Tinted surfaces (soft badges, secondary tiles) |
| `#006341` | `.text-theme{color:#006341}` assurance-green | **Success** (positive status, effective controls) |
| `#FFD900` | Gold used on footer/CTA highlights (Kenya-flag gold) | Warm accent (logo node, sparing highlights) |
| `#0C3D49` | Dark teal text on light panels | **Ink** — dark surfaces, hero gradient end |

The IITAMS palette is *inspired by* the Ministry identity (institutional blue
anchored with Kenyan gold and assurance green) while remaining a distinct
application: the neutral ramp is a quiet blue-tinted slate, and severity
colour semantics (below) are IITAMS-specific.

### 1.2 Token architecture (Tailwind v4, `oklch`)

Tokens are defined as CSS variables in `src/index.css` under `:root` and
`.dark`, and surfaced to Tailwind through `@theme inline`. Values were tuned
from the sampled hexes into OKLCH for perceptually even ramps and
WCAG-friendly contrast:

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--primary` | institutional blue (≈#005A9A) | lightened sky blue | Primary actions, active states, ring |
| `--secondary` / `--accent` | blue-tinted surfaces | elevated blue-greys | Hover surfaces, secondary tiles |
| `--muted` / `--muted-foreground` | quiet neutrals | dimmed neutrals | Secondary text, placeholders |
| `--destructive` / `--critical` | red | brighter red | Destructive actions, critical severity |
| `--success` | assurance green (≈#006341 family) | brighter green | Positive status |
| `--warning` | amber | brighter amber | High severity, cautions |
| `--info` | sky blue (≈#4EB5F5 family) | lighter sky | Medium severity, informational |
| `--ink` / `--ink-deep` | dark teal-navy | darker | Decorative dark surfaces (hero, bands) |
| `--chart-1..5` | blue, sky, green, gold, red | reordered for contrast | Recharts palette |
| `--sidebar-*` | tinted sidebar surfaces | dark equivalents | Shell navigation |

### 1.3 Severity model (colour is never the only signal)

Defined in `src/lib/severity.ts` and rendered by `SeverityBadge` /
`StatusChip` / `RiskScoreBadge`:

| Severity | Colour token | Icon | Filled chip |
| --- | --- | --- | --- |
| Critical | `--critical` | octagon alert | red bg / white text |
| High | `--warning` | triangle alert | amber bg / dark text |
| Medium | `--info` | circle | blue bg / white text |
| Low | `--success` | check circle | green bg / white text |
| Informational | muted | info circle | grey bg / muted text |

Every severity pairs **icon + text label + colour**. Soft badges invert to a
tinted background with a strong-coloured border for dense tables.

### 1.4 Data classification visuals

`Public / Internal / Confidential / Restricted` — green / blue / amber / red
outline badges (see `ClassificationBadge`). Phase 1 renders the indicators;
enforcement policy attaches to the evidence module later.

---

## 2. Typography

| Role | Face | Notes |
| --- | --- | --- |
| UI & body | **Inter** (variable, self-hosted via Google Fonts) | `font-feature-settings: cv02 cv03 cv04 cv11` for unambiguous glyphs |
| Editorial accents | **Source Serif 4** | optional serif for pull-quotes/reports |
| Data & code | system mono stack | tabular numerals for KPI figures |

Rules: `tracking-tight` on headings, `font-bold` for page titles, body text at
14–16px with `leading-6/7`, KPI numbers always `tabular-nums`.

## 3. Spacing, radius & elevation

- Global radius `--radius: 0.625rem`; sm/md/lg/xl derive from it.
- Page gutter `px-4 sm:px-6 lg:px-8`; section rhythm `py-20` (landing) /
  `gap-4/6` (dashboard grids).
- **Elevation policy:** thin borders, no drop shadows (`shadow-none` on cards;
  hover = border-colour shift to `primary/40`), per project convention.

## 4. Motion

| Effect | Timing | Where |
| --- | --- | --- |
| `fadeUp` stagger | 0.55s, 80ms stagger | landing hero |
| aurora drift | 26s alternate | decorative backgrounds |
| cinematic pan | 46s | photo layers (when used) |
| cross-fade | `n×14s` cycle | stacked photos |
| chart/canvas particles | ~0.16px/frame drift | VisualBackground |

**Reduced motion:** all decorative animation is frozen under
`prefers-reduced-motion: reduce` — CSS effects via the media query in
`index.css`, canvas particles via `useReducedMotion()` + `matchMedia` in
`VisualBackground`, which then renders the static fallback (grid + gradient,
no particles, no pan). Framer `whileInView` animations degrade to instant.

## 5. Interactive backgrounds

`src/components/VisualBackground.tsx` composes the layered background used on
the landing hero and the auth page brand panel:

1. **Ink gradient** base (deep institutional blue → dark teal)
2. **Engineering grid** (`bg-grid-network`, 44px)
3. **Aurora glow** blobs (CSS radial gradients, slow drift)
4. **Network-node particles** (canvas; density adapts to viewport, 14–90
   nodes, faint link lines, sky-blue accents)
5. **Optional photo layer** with cinematic pan + cross-fade (disabled by
   default; images optional props)

Accessibility: `role="img"` with descriptive label, `aria-hidden` on all
decorative layers, static fallback under reduced motion, bottom scrim to
protect text contrast.

## 6. Component inventory

**Primitives (shadcn/radix):** Button, Input, Textarea, Select, Checkbox,
Switch, Calendar, Card, Badge, Table, Tabs, Dialog, Sheet, Drawer, Popover,
Tooltip, DropdownMenu, Command, Avatar, Progress, Skeleton, ScrollArea,
Separator, Breadcrumb, Alert, AlertDescription, Pagination, Toaster (sonner),
Chart (Recharts wrapper).

**IITAMS composites (`src/components/iitams/`):**

| Component | Purpose |
| --- | --- |
| `KpiCard` | KPI tile — tone, icon, tooltip explainer, optional link |
| `badges.tsx` | `SeverityBadge`, `StatusChip`, `RiskScoreBadge`, `ClassificationBadge`, `ProgressMeter` |
| `charts.tsx` | `SeverityBarChart`, `TrendLineChart`, `FrameworkBarChart`, `EffectivenessGauge`, `RiskHeatMap` |
| `PageHeader.tsx` | `PageHeader`, `Breadcrumbs`, `ModulePlaceholder` |
| `AppSidebar.tsx` | permission-aware grouped navigation |
| `TopBar.tsx` | org context, global search, notifications, help, profile |
| `AppLayout.tsx` | authenticated shell composition |
| `VisualBackground.tsx` | interactive background system |

**Empty/loading states:** module scaffolding uses `ModulePlaceholder` (honest
Phase-2 note); loading uses skeletons on the dashboard and spinners on routes;
the dashboard flags demo data with a warning badge and inline copy.

## 7. Accessibility (WCAG 2.1 AA target)

- Visible focus: global `:focus-visible { outline: 2px solid var(--ring) }`.
- Semantic landmarks (`header/main/nav`), `aria-label`s on icon-only controls,
  `aria-current` on breadcrumbs, `role="alert"` on form errors.
- Icon + text pairing for all status/severity signalling.
- Charts: tooltips + legends with text labels; heat map exposes a table role.
- Keyboard: full tab order, `Cmd`-palette search, focus-trapped dialogs.
- Reduced-motion support as described in §4.

## 8. Usage rules

1. Never hardcode hexes in components — use tokens (`bg-primary`, `text-critical`).
2. Never add drop shadows; use border emphasis.
3. Status never relies on colour alone (always icon/label).
4. New UI must work in both light and dark themes.
5. Decorative motion must degrade gracefully under reduced motion.
