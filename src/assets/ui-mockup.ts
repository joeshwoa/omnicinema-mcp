/**
 * Offline UI mockups: a device frame (browser window or phones) around a
 * realistic screen layout chosen from the subject — dashboard, landing page,
 * sign-in, storefront, chat, or a mobile app. Built on an 8pt grid with one
 * accent color, per the Graphic Designer persona's UI directives.
 */
import {
  FONT_SANS, designPalette, esc, fitFontSize, hasAny, lighten, makeRng, mix, n,
  readableOn, seedFrom, sizeFor, svgDoc, textWidth, titleCase, wrapText, type DesignPalette, type Rng,
} from "./svg-kit.js";
import type { VectorOptions } from "./vector.js";

export type Screen = "dashboard" | "landing" | "auth" | "store" | "chat" | "mobile";

const SCREEN_KEYWORDS: [Screen, string[]][] = [
  ["auth", ["login", "log in", "signin", "sign", "signup", "register", "auth", "onboarding", "password"]],
  ["chat", ["chat", "messaging", "messenger", "inbox", "support", "conversation", "messages"]],
  ["store", ["shop", "store", "ecommerce", "e-commerce", "product", "cart", "fashion", "marketplace", "checkout", "catalog"]],
  ["landing", ["landing", "homepage", "home page", "website", "marketing", "saas", "startup", "hero", "portfolio", "agency"]],
  ["mobile", ["app", "mobile", "ios", "android", "phone", "iphone", "fitness", "music", "player", "podcast", "wallet"]],
  ["dashboard", ["dashboard", "analytics", "admin", "control", "center", "monitor", "metrics", "crm", "report", "console", "panel"]],
];

export function chooseScreen(subject: string): Screen {
  const s = ` ${subject.toLowerCase()} `;
  // Explicit screen words win over domain words ("fitness dashboard" → dashboard).
  if (hasAny(s, ["dashboard", "analytics", "admin", "console", "control"])) return "dashboard";
  for (const [screen, words] of SCREEN_KEYWORDS) {
    if (words.some((w) => w.includes(" ") ? s.includes(w) : hasAny(s, [w]))) return screen;
  }
  return "dashboard";
}

interface Ctx {
  pal: DesignPalette;
  r: number; // corner radius unit
  rng: Rng;
  uid: string;
  name: string;
  subject: string;
}

const CARD_STROKE = "#e5e7eb";
const SURFACE = "#ffffff";
const TEXT_MUTED = "#64748b";
const TEXT = "#0f172a";

function t(x: number, y: number, s: string, size: number, opts: { w?: number; fill?: string; anchor?: string; ls?: number; op?: number } = {}): string {
  return `<text x="${n(x)}" y="${n(y)}" font-family="${esc(FONT_SANS)}" font-size="${n(size)}" font-weight="${opts.w ?? 400}" fill="${opts.fill ?? TEXT}"${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}${opts.ls ? ` letter-spacing="${n(opts.ls)}"` : ""}${opts.op !== undefined ? ` fill-opacity="${opts.op}"` : ""}>${esc(s)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, rx: number, fill: string, extra = ""): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="${n(rx)}" fill="${fill}"${extra}/>`;
}

function card(x: number, y: number, w: number, h: number, c: Ctx): string {
  return rect(x, y, w, h, c.r * 1.5, SURFACE, ` stroke="${CARD_STROKE}" stroke-width="1"`);
}

function icon(kind: string, x: number, y: number, s: number, color: string): string {
  const sw = n(Math.max(1.4, s * 0.1));
  const g = (inner: string) => `<g fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${n(x)} ${n(y)}) scale(${n(s / 24)})">${inner}</g>`;
  switch (kind) {
    case "home": return g(`<path d="M3 11 L12 4 L21 11 V20 H14 V14 H10 V20 H3 Z"/>`);
    case "chart": return g(`<path d="M4 20 V10 M10 20 V4 M16 20 V13 M22 20 H2"/>`);
    case "users": return g(`<circle cx="9" cy="8" r="4"/><path d="M2 21 C2 16 16 16 16 21"/><path d="M17 4 A4 4 0 0 1 17 12 M19 15 C21 16 22 18 22 21"/>`);
    case "gear": return g(`<circle cx="12" cy="12" r="3.5"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9"/>`);
    case "bell": return g(`<path d="M6 16 V11 A6 6 0 0 1 18 11 V16 L20 18 H4 Z M10 21 H14"/>`);
    case "search": return g(`<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>`);
    case "folder": return g(`<path d="M3 6 H9 L11 8 H21 V19 H3 Z"/>`);
    case "message": return g(`<path d="M4 5 H20 V16 H9 L4 20 Z"/>`);
    case "cart": return g(`<path d="M3 4 H6 L8 16 H19 L21 7 H7"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>`);
    case "heart": return g(`<path d="M12 20 C4 14 2 10 5 6.5 C7.5 4 10.5 5 12 7.5 C13.5 5 16.5 4 19 6.5 C22 10 20 14 12 20 Z"/>`);
    case "bolt": return g(`<path d="M13 2 L5 13 H11 L10 22 L19 10 H13 Z"/>`);
    case "shield": return g(`<path d="M12 2 L20 5 V11 C20 16 16 20 12 22 C8 20 4 16 4 11 V5 Z"/>`);
    case "play": return g(`<path d="M8 5 L19 12 L8 19 Z"/>`);
    case "star": return g(`<path d="M12 3 L14.6 8.6 L20.6 9.3 L16.1 13.4 L17.4 19.4 L12 16.3 L6.6 19.4 L7.9 13.4 L3.4 9.3 L9.4 8.6 Z"/>`);
    default: return g(`<rect x="4" y="4" width="16" height="16" rx="4"/>`);
  }
}

function logoMark(x: number, y: number, s: number, c: Ctx): string {
  return rect(x, y, s, s, s * 0.28, c.pal.primary) + `<circle cx="${n(x + s * 0.5)}" cy="${n(y + s * 0.5)}" r="${n(s * 0.2)}" fill="none" stroke="#ffffff" stroke-width="${n(s * 0.1)}"/>` + `<circle cx="${n(x + s * 0.72)}" cy="${n(y + s * 0.28)}" r="${n(s * 0.1)}" fill="${c.pal.accent === c.pal.primary ? "#ffffff" : lighten(c.pal.accent, 0.2)}"/>`;
}

function pill(x: number, y: number, label: string, size: number, bg: string, fg: string): string {
  const w = textWidth(label, size, { bold: true }) + size * 1.4;
  return rect(x, y, w, size * 1.8, size * 0.9, bg) + t(x + w / 2, y + size * 1.25, label, size, { w: 600, fill: fg, anchor: "middle" });
}

function button(x: number, y: number, w: number, h: number, label: string, c: Ctx, variant: "primary" | "ghost" = "primary"): string {
  const fill = variant === "primary" ? c.pal.primary : SURFACE;
  const fg = variant === "primary" ? readableOn(c.pal.primary, ["#ffffff", TEXT]) : TEXT;
  return rect(x, y, w, h, c.r, fill, variant === "ghost" ? ` stroke="#cbd5e1" stroke-width="1.2"` : "") + t(x + w / 2, y + h / 2 + h * 0.16, label, h * 0.36, { w: 600, fill: fg, anchor: "middle" });
}

/** Smooth area/line chart path through seeded values. */
function series(rng: Rng, count: number, lo: number, hi: number, trend = 0.3): number[] {
  const out: number[] = [];
  let v = range01(rng) * 0.4 + 0.2;
  for (let i = 0; i < count; i++) {
    v += (rng() - 0.5) * 0.28 + trend / count;
    v = Math.max(0.08, Math.min(0.95, v));
    out.push(lo + (hi - lo) * v);
  }
  return out;
}
function range01(rng: Rng): number { return rng(); }

function smoothPath(points: [number, number][]): string {
  let d = `M${n(points[0]![0])} ${n(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const mx = (x0 + x1) / 2;
    d += ` C${n(mx)} ${n(y0)} ${n(mx)} ${n(y1)} ${n(x1)} ${n(y1)}`;
  }
  return d;
}

function lineChart(x: number, y: number, w: number, h: number, c: Ctx, title: string, labels: string[]): string {
  const out = [card(x, y, w, h, c)];
  const p = 24;
  out.push(t(x + p, y + p + 14, title, 16, { w: 700 }));
  out.push(t(x + p, y + p + 36, "Compared with the previous period", 12, { fill: TEXT_MUTED }));
  const lx = x + w - p;
  out.push(`<circle cx="${n(lx - 150)}" cy="${n(y + p + 10)}" r="5" fill="${c.pal.primary}"/>` + t(lx - 140, y + p + 14, "This week", 12, { fill: TEXT_MUTED }));
  out.push(`<circle cx="${n(lx - 60)}" cy="${n(y + p + 10)}" r="5" fill="${c.pal.secondary}"/>` + t(lx - 50, y + p + 14, "Last week", 12, { fill: TEXT_MUTED }));
  const cx0 = x + p + 36;
  const cx1 = x + w - p;
  const cy0 = y + p + 64;
  const cy1 = y + h - p - 22;
  const grid: string[] = [];
  const ticks = ["100", "75", "50", "25", "0"];
  ticks.forEach((tk, i) => {
    const gy = cy0 + ((cy1 - cy0) * i) / (ticks.length - 1);
    grid.push(`<path d="M${n(cx0)} ${n(gy)} H${n(cx1)}" stroke="#eef2f7" stroke-width="1"/>`);
    grid.push(t(cx0 - 10, gy + 4, tk, 11, { fill: "#94a3b8", anchor: "end" }));
  });
  out.push(grid.join(""));
  const count = labels.length;
  const toPts = (vals: number[]) => vals.map((v, i) => [cx0 + ((cx1 - cx0) * i) / (count - 1), cy1 - (cy1 - cy0) * v] as [number, number]);
  const a = toPts(series(c.rng, count, 0, 1, 0.5));
  const b = toPts(series(c.rng, count, 0, 0.8, 0.1));
  out.push(`<linearGradient id="area-${c.uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.pal.primary}" stop-opacity="0.28"/><stop offset="1" stop-color="${c.pal.primary}" stop-opacity="0"/></linearGradient>`);
  out.push(`<path d="${smoothPath(a)} L${n(cx1)} ${n(cy1)} L${n(cx0)} ${n(cy1)} Z" fill="url(#area-${c.uid})"/>`);
  out.push(`<path d="${smoothPath(b)}" fill="none" stroke="${c.pal.secondary}" stroke-width="2.5" stroke-dasharray="6 6" stroke-linecap="round"/>`);
  out.push(`<path d="${smoothPath(a)}" fill="none" stroke="${c.pal.primary}" stroke-width="3" stroke-linecap="round"/>`);
  const hi = a[Math.floor(count * 0.65)]!;
  out.push(`<path d="M${n(hi[0])} ${n(cy0)} V${n(cy1)}" stroke="${c.pal.primary}" stroke-opacity="0.3" stroke-dasharray="3 4"/><circle cx="${n(hi[0])}" cy="${n(hi[1])}" r="6" fill="#ffffff" stroke="${c.pal.primary}" stroke-width="3"/>`);
  out.push(rect(hi[0] - 34, hi[1] - 42, 68, 28, 8, TEXT) + t(hi[0], hi[1] - 23, `${Math.round(40 + c.rng() * 50)}.${Math.floor(c.rng() * 9)}k`, 12, { w: 700, fill: "#ffffff", anchor: "middle" }));
  labels.forEach((l, i) => out.push(t(cx0 + ((cx1 - cx0) * i) / (count - 1), cy1 + 20, l, 11, { fill: "#94a3b8", anchor: "middle" })));
  return out.join("\n");
}

function donut(x: number, y: number, w: number, h: number, c: Ctx, title: string, items: [string, number][]): string {
  const out = [card(x, y, w, h, c)];
  const p = 24;
  out.push(t(x + p, y + p + 14, title, 16, { w: 700 }));
  const R = Math.min(w * 0.26, (h - 110) / 2.4);
  const cx = x + p + R + 8;
  const cy = y + p + 50 + R;
  const circ = 2 * Math.PI * R;
  const total = items.reduce((s, [, v]) => s + v, 0);
  const cols = [c.pal.primary, c.pal.secondary, c.pal.accent, "#cbd5e1"];
  let acc = 0;
  out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="#f1f5f9" stroke-width="${n(R * 0.36)}"/>`);
  items.forEach(([, v], i) => {
    const len = (v / total) * circ;
    out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="${cols[i % cols.length]}" stroke-width="${n(R * 0.36)}" stroke-dasharray="${n(Math.max(0, len - 3))} ${n(circ)}" stroke-dashoffset="${n(-acc)}" transform="rotate(-90 ${n(cx)} ${n(cy)})"/>`);
    acc += len;
  });
  out.push(t(cx, cy + 2, `${items[0]![1]}%`, R * 0.42, { w: 700, anchor: "middle" }) + t(cx, cy + R * 0.3, items[0]![0], 11, { fill: TEXT_MUTED, anchor: "middle" }));
  const lx = cx + R + 32;
  items.forEach(([label, v], i) => {
    const ly = cy - R * 0.6 + i * 30;
    out.push(rect(lx, ly - 9, 10, 10, 3, cols[i % cols.length]!) + t(lx + 18, ly, label, 13, { fill: TEXT }) + t(x + w - p, ly, `${v}%`, 13, { w: 600, anchor: "end" }));
  });
  return out.join("\n");
}

interface Domain {
  kpis: [string, string, string, boolean][]; // label, value, delta, positive
  chart: string;
  donut: [string, [string, number][]];
  table: { title: string; cols: string[]; rows: [string, string, string, string][] };
  nav: string[];
}

function domainFor(subject: string): Domain {
  const s = subject.toLowerCase();
  if (hasAny(s, ["control", "monitor", "ops", "system", "systems", "server", "infrastructure", "network", "security", "center", "centre", "devops"])) {
    return {
      kpis: [["Systems online", "128/130", "+2", true], ["Active alerts", "3", "−4", true], ["Avg latency", "42 ms", "−8%", true], ["Throughput", "1.2 GB/s", "+14%", true]],
      chart: "Throughput · last 24h",
      donut: ["Alert severity", [["Low", 62], ["Medium", 26], ["High", 12]]],
      table: { title: "Services", cols: ["Service", "Status", "Latency", "Uptime"], rows: [["API Gateway", "Healthy", "38 ms", "99.99%"], ["Auth Service", "Healthy", "24 ms", "99.98%"], ["Billing Worker", "Degraded", "212 ms", "99.2%"], ["Search Index", "Healthy", "57 ms", "99.95%"]] },
      nav: ["Overview", "Services", "Incidents", "Deployments", "Settings"],
    };
  }
  if (hasAny(s, ["finance", "bank", "banking", "invest", "trading", "crypto", "wallet", "budget", "money", "fintech"])) {
    return {
      kpis: [["Total balance", "$24,580", "+6.2%", true], ["Monthly income", "$8,240", "+3.1%", true], ["Expenses", "$3,915", "+1.4%", false], ["Savings rate", "38%", "+2 pts", true]],
      chart: "Portfolio value",
      donut: ["Allocation", [["Stocks", 54], ["Bonds", 28], ["Cash", 18]]],
      table: { title: "Recent transactions", cols: ["Merchant", "Status", "Amount", "Date"], rows: [["Blue Bottle", "Settled", "−$6.50", "Today"], ["Payroll", "Settled", "+$4,120", "Mar 28"], ["Figma", "Pending", "−$15.00", "Mar 27"], ["Transfer", "Settled", "−$500", "Mar 25"]] },
      nav: ["Overview", "Accounts", "Cards", "Investments", "Settings"],
    };
  }
  if (hasAny(s, ["health", "fitness", "workout", "wellness", "sleep", "medical", "clinic", "patient"])) {
    return {
      kpis: [["Steps", "8,432", "+12%", true], ["Calories", "1,920 kcal", "+4%", true], ["Resting HR", "58 bpm", "−2", true], ["Sleep", "7h 20m", "+35m", true]],
      chart: "Activity this week",
      donut: ["Workout mix", [["Cardio", 48], ["Strength", 34], ["Mobility", 18]]],
      table: { title: "Recent sessions", cols: ["Session", "Status", "Duration", "Effort"], rows: [["Morning run", "Done", "32 min", "Hard"], ["Upper body", "Done", "45 min", "Moderate"], ["Yoga flow", "Planned", "20 min", "Easy"], ["Intervals", "Done", "28 min", "Hard"]] },
      nav: ["Today", "Activity", "Workouts", "Nutrition", "Settings"],
    };
  }
  return {
    kpis: [["Revenue", "$48.2k", "+12.4%", true], ["Active users", "3,921", "+5.1%", true], ["Conversion", "4.6%", "+0.8 pts", true], ["Churn", "1.8%", "+0.2 pts", false]],
    chart: "Performance",
    donut: ["Traffic sources", [["Organic", 46], ["Paid", 31], ["Referral", 23]]],
    table: { title: "Top accounts", cols: ["Customer", "Status", "Plan", "MRR"], rows: [["Northwind", "Active", "Scale", "$2,400"], ["Globex", "Active", "Growth", "$1,150"], ["Initech", "Trial", "Starter", "$0"], ["Umbrella", "Active", "Scale", "$2,050"]] },
    nav: ["Overview", "Analytics", "Customers", "Reports", "Settings"],
  };
}

const NAV_ICONS = ["home", "chart", "users", "folder", "gear"];

function statusColors(status: string): [string, string] {
  if (/degraded|pending|trial|planned/i.test(status)) return ["#fef3c7", "#92400e"];
  if (/down|failed|error/i.test(status)) return ["#fee2e2", "#991b1b"];
  return ["#dcfce7", "#166534"];
}

function dashboard(x: number, y: number, w: number, h: number, c: Ctx): string {
  const d = domainFor(c.subject);
  const out: string[] = [];
  const sw = 232;
  out.push(rect(x, y, sw, h, 0, mix(c.pal.light, "#ffffff", 0.35)) + `<path d="M${n(x + sw)} ${n(y)} V${n(y + h)}" stroke="${CARD_STROKE}"/>`);
  out.push(logoMark(x + 24, y + 24, 32, c) + t(x + 66, y + 46, c.name.length > 16 ? `${c.name.slice(0, 15)}…` : c.name, 16, { w: 700 }));
  d.nav.forEach((label, i) => {
    const ny = y + 96 + i * 44;
    const active = i === 0;
    if (active) out.push(rect(x + 14, ny - 4, sw - 28, 38, c.r, mix(c.pal.primary, "#ffffff", 0.88)));
    out.push(icon(NAV_ICONS[i] ?? "folder", x + 28, ny + 5, 20, active ? c.pal.primary : TEXT_MUTED));
    out.push(t(x + 60, ny + 20, label, 14, { w: active ? 600 : 500, fill: active ? c.pal.primary : "#334155" }));
  });
  // Upgrade card at the bottom of the sidebar.
  out.push(rect(x + 16, y + h - 132, sw - 32, 112, c.r * 1.5, c.pal.primary));
  out.push(t(x + 32, y + h - 100, "Upgrade to Pro", 14, { w: 700, fill: readableOn(c.pal.primary, ["#ffffff", TEXT]) }));
  out.push(t(x + 32, y + h - 80, "Unlock advanced reports", 12, { fill: readableOn(c.pal.primary, ["#ffffff", TEXT]), op: 0.85 }));
  out.push(rect(x + 32, y + h - 64, 96, 30, c.r * 0.8, "#ffffff") + t(x + 80, y + h - 44, "Upgrade", 12, { w: 700, fill: c.pal.primary, anchor: "middle" }));

  const mx = x + sw + 32;
  const mw = w - sw - 64;
  let cy = y + 28;
  const title = c.name;
  out.push(t(mx, cy + 26, title, fitFontSize(title, mw * 0.45, 26, { bold: true }), { w: 700 }));
  out.push(t(mx, cy + 48, "Last updated 2 minutes ago", 13, { fill: TEXT_MUTED }));
  out.push(rect(mx + mw - 330, cy + 8, 220, 40, c.r, "#f8fafc", ` stroke="${CARD_STROKE}"`) + icon("search", mx + mw - 318, cy + 18, 20, "#94a3b8") + t(mx + mw - 290, cy + 33, "Search…", 13, { fill: "#94a3b8" }));
  out.push(icon("bell", mx + mw - 92, cy + 16, 24, "#475569") + `<circle cx="${n(mx + mw - 72)}" cy="${n(cy + 18)}" r="5" fill="#ef4444"/>`);
  out.push(`<circle cx="${n(mx + mw - 22)}" cy="${n(cy + 28)}" r="20" fill="${c.pal.secondary}"/>` + t(mx + mw - 22, cy + 34, "AK", 13, { w: 700, fill: readableOn(c.pal.secondary, ["#ffffff", TEXT]), anchor: "middle" }));
  cy += 80;
  const kw = (mw - 3 * 20) / 4;
  d.kpis.forEach(([label, value, delta, pos], i) => {
    const kx = mx + i * (kw + 20);
    out.push(card(kx, cy, kw, 108, c));
    out.push(t(kx + 20, cy + 32, label, 13, { fill: TEXT_MUTED, w: 500 }));
    out.push(t(kx + 20, cy + 70, value, fitFontSize(value, kw - 40, 28, { bold: true }), { w: 700 }));
    const [bg, fg] = pos ? ["#dcfce7", "#15803d"] : ["#fee2e2", "#b91c1c"];
    out.push(pill(kx + 20, cy + 80, `${delta}`, 11, bg, fg));
    out.push(`<path d="${smoothPath(series(c.rng, 7, 0, 1).map((v, j) => [kx + kw - 96 + j * 13, cy + 90 - v * 28] as [number, number]))}" fill="none" stroke="${pos ? c.pal.primary : "#ef4444"}" stroke-width="2" stroke-linecap="round"/>`);
  });
  cy += 128;
  const chartH = Math.max(220, Math.min(300, h - (cy - y) - 250));
  const lw = (mw - 20) * 0.64;
  out.push(lineChart(mx, cy, lw, chartH, c, d.chart, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]));
  out.push(donut(mx + lw + 20, cy, mw - lw - 20, chartH, c, d.donut[0], d.donut[1]));
  cy += chartH + 20;
  const th = y + h - 24 - cy;
  out.push(card(mx, cy, mw, th, c));
  out.push(t(mx + 24, cy + 36, d.table.title, 16, { w: 700 }) + t(mx + mw - 24, cy + 36, "View all →", 13, { w: 600, fill: c.pal.primary, anchor: "end" }));
  const colX = [mx + 24, mx + mw * 0.42, mx + mw * 0.64, mx + mw - 24];
  const hy = cy + 66;
  d.table.cols.forEach((col, i) => out.push(t(colX[i]!, hy, col.toUpperCase(), 11, { w: 600, fill: "#94a3b8", ls: 0.8, anchor: i === 3 ? "end" : undefined })));
  const rowH = 44;
  const maxRows = Math.max(1, Math.floor((th - 84) / rowH));
  d.table.rows.slice(0, maxRows).forEach((row, i) => {
    const ry = hy + 14 + i * rowH;
    out.push(`<path d="M${n(mx + 24)} ${n(ry)} H${n(mx + mw - 24)}" stroke="#f1f5f9"/>`);
    const initials = row[0].split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    out.push(`<circle cx="${n(colX[0]! + 14)}" cy="${n(ry + rowH / 2)}" r="14" fill="${mix([c.pal.primary, c.pal.secondary, c.pal.accent][i % 3]!, "#ffffff", 0.75)}"/>` + t(colX[0]! + 14, ry + rowH / 2 + 4, initials, 10, { w: 700, anchor: "middle", fill: "#334155" }));
    out.push(t(colX[0]! + 38, ry + rowH / 2 + 5, row[0], 14, { w: 600 }));
    const [bg, fg] = statusColors(row[1]);
    out.push(pill(colX[1]!, ry + rowH / 2 - 10, row[1], 11, bg, fg));
    out.push(t(colX[2]!, ry + rowH / 2 + 5, row[2], 14, { fill: "#334155" }));
    out.push(t(colX[3]!, ry + rowH / 2 + 5, row[3], 14, { w: 600, anchor: "end" }));
  });
  return out.join("\n");
}

function landing(x: number, y: number, w: number, h: number, c: Ctx): string {
  const out: string[] = [];
  const p = 56;
  out.push(rect(x, y, w, h, 0, "#ffffff"));
  out.push(`<circle cx="${n(x + w * 0.82)}" cy="${n(y + h * 0.1)}" r="${n(w * 0.28)}" fill="${mix(c.pal.secondary, "#ffffff", 0.88)}"/>`);
  out.push(logoMark(x + p, y + 28, 32, c) + t(x + p + 44, y + 51, c.name, 18, { w: 700 }));
  ["Product", "Features", "Pricing", "Docs"].forEach((l, i) => out.push(t(x + w * 0.42 + i * 92, y + 50, l, 14, { w: 500, fill: "#334155" })));
  out.push(t(x + w - p - 136, y + 50, "Sign in", 14, { w: 600, fill: "#334155", anchor: "end" }));
  out.push(button(x + w - p - 110, y + 26, 110, 38, "Get started", c));
  const hx = x + p;
  const hy = y + 150;
  const colW = w * 0.46;
  out.push(pill(hx, hy, `NEW · ${c.name.toUpperCase().slice(0, 22)} 2.0`, 11, mix(c.pal.primary, "#ffffff", 0.88), c.pal.primary));
  const headline = headlineFor(c.subject, c.name);
  const hs = 52;
  const lines = wrapText(headline, hs, colW, 3, true);
  lines.forEach((l, i) => out.push(t(hx, hy + 92 + i * hs * 1.12, l, hs, { w: 800, fill: i === lines.length - 1 ? c.pal.primary : TEXT, ls: -1 })));
  let yy = hy + 92 + (lines.length - 1) * hs * 1.12 + 44;
  wrapText(`Plan, build and ship from one calm workspace. ${c.name} brings your team, data and decisions together — so you can focus on the work that matters.`, 18, colW, 3).forEach((l, i) => out.push(t(hx, yy + i * 28, l, 18, { fill: "#475569" })));
  yy += 3 * 28 + 24;
  out.push(button(hx, yy, 170, 52, "Start free trial", c) + button(hx + 186, yy, 150, 52, "Book a demo", c, "ghost"));
  out.push(t(hx, yy + 88, "★★★★★  Rated 4.9/5 by 2,000+ teams", 13, { fill: TEXT_MUTED, w: 500 }));
  // Hero visual: product card stack.
  const vx = x + w * 0.56;
  const vy = y + 140;
  const vw = w - (vx - x) - p;
  const vh = Math.min(h * 0.44, 340);
  out.push(rect(vx + 24, vy + 24, vw, vh, c.r * 2, mix(c.pal.primary, "#ffffff", 0.8)));
  out.push(lineChart(vx, vy, vw, vh, c, "Weekly momentum", ["M", "T", "W", "T", "F", "S", "S"]));
  const fx = vx - 36;
  const fy = vy + vh - 120;
  out.push(card(fx, fy, 200, 96, c) + `<circle cx="${n(fx + 34)}" cy="${n(fy + 48)}" r="18" fill="${mix(c.pal.accent, "#ffffff", 0.75)}"/>` + icon("bolt", fx + 24, fy + 38, 20, c.pal.primary) + t(fx + 62, fy + 42, "Tasks shipped", 12, { fill: TEXT_MUTED }) + t(fx + 62, fy + 66, "+128%", 22, { w: 800 }));
  // Logos strip + features.
  const ly = Math.max(vy + vh + 56, y + h - 250);
  out.push(t(x + w / 2, ly, "TRUSTED BY FAST-MOVING TEAMS", 11, { w: 600, fill: "#94a3b8", anchor: "middle", ls: 2 }));
  ["Northwind", "Globex", "Initech", "Umbrella", "Hooli"].forEach((l, i, arr) => out.push(t(x + (w * (i + 1)) / (arr.length + 1), ly + 38, l, 20, { w: 800, fill: "#cbd5e1", anchor: "middle" })));
  const fw = (w - 2 * p - 2 * 24) / 3;
  const feats: [string, string, string][] = [["bolt", "Fast by default", "Instant search and zero-lag editing."], ["shield", "Secure", "SSO, audit logs and SOC 2 controls."], ["chart", "Insightful", "Live dashboards for every team."]];
  feats.forEach(([ic, title, body], i) => {
    const fx2 = x + p + i * (fw + 24);
    const fy2 = ly + 70;
    out.push(card(fx2, fy2, fw, 130, c));
    out.push(rect(fx2 + 22, fy2 + 22, 40, 40, c.r, mix(c.pal.primary, "#ffffff", 0.86)) + icon(ic, fx2 + 32, fy2 + 32, 20, c.pal.primary));
    out.push(t(fx2 + 22, fy2 + 88, title, 16, { w: 700 }) + t(fx2 + 22, fy2 + 110, body, 13, { fill: TEXT_MUTED }));
  });
  return out.join("\n");
}

function headlineFor(subject: string, name: string): string {
  const s = subject.toLowerCase();
  if (hasAny(s, ["portfolio", "agency", "studio"])) return `We design brands people remember`;
  if (hasAny(s, ["finance", "bank", "fintech", "money"])) return `Money that works as hard as you do`;
  if (hasAny(s, ["health", "fitness", "wellness"])) return `Feel better, every single day`;
  return `The workspace for teams that move fast`;
}

function auth(x: number, y: number, w: number, h: number, c: Ctx): string {
  const out: string[] = [];
  const lw = w * 0.46;
  out.push(`<linearGradient id="brand-${c.uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.pal.primary}"/><stop offset="1" stop-color="${mix(c.pal.secondary, c.pal.primary, 0.25)}"/></linearGradient>`);
  out.push(rect(x, y, lw, h, 0, `url(#brand-${c.uid})`));
  const fg = readableOn(c.pal.primary, ["#ffffff", TEXT]);
  out.push(`<circle cx="${n(x + lw * 0.85)}" cy="${n(y + h * 0.18)}" r="${n(lw * 0.3)}" fill="#ffffff" fill-opacity="0.08"/><circle cx="${n(x + lw * 0.1)}" cy="${n(y + h * 0.9)}" r="${n(lw * 0.4)}" fill="#ffffff" fill-opacity="0.06"/>`);
  out.push(rect(x + 48, y + 44, 36, 36, 10, "#ffffff", ` fill-opacity="0.2"`) + t(x + 96, y + 69, c.name, 20, { w: 700, fill: fg }));
  wrapText(`Everything your team needs, in one place.`, 40, lw - 96, 3, true).forEach((l, i) => out.push(t(x + 48, y + h * 0.42 + i * 48, l, 40, { w: 800, fill: fg })));
  out.push(rect(x + 48, y + h - 190, lw - 96, 130, 16, "#ffffff", ` fill-opacity="0.12"`));
  out.push(t(x + 72, y + h - 150, "“We shipped our launch two weeks early.”", 16, { w: 600, fill: fg }));
  out.push(`<circle cx="${n(x + 92)}" cy="${n(y + h - 100)}" r="18" fill="#ffffff" fill-opacity="0.35"/>` + t(x + 120, y + h - 104, "Maya Chen", 14, { w: 700, fill: fg }) + t(x + 120, y + h - 86, "Head of Product, Northwind", 12, { fill: fg, op: 0.8 }));
  const fx = x + lw + (w - lw - 380) / 2;
  let fy = y + h * 0.18;
  out.push(t(fx, fy, "Welcome back", 32, { w: 800 }));
  out.push(t(fx, fy + 32, `Sign in to your ${c.name} account`, 15, { fill: TEXT_MUTED }));
  fy += 72;
  for (const [label, value] of [["Email", "alex@northwind.co"], ["Password", "••••••••••"]] as const) {
    out.push(t(fx, fy, label, 13, { w: 600, fill: "#334155" }));
    out.push(rect(fx, fy + 10, 380, 48, c.r, "#ffffff", ` stroke="#cbd5e1" stroke-width="1.2"`) + t(fx + 16, fy + 40, value, 15, { fill: "#334155" }));
    fy += 88;
  }
  out.push(rect(fx, fy - 12, 18, 18, 5, c.pal.primary) + `<path d="M${n(fx + 4)} ${n(fy - 3)} l4 4 l7 -8" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round"/>` + t(fx + 28, fy + 2, "Remember me", 13, { fill: "#334155" }) + t(fx + 380, fy + 2, "Forgot password?", 13, { w: 600, fill: c.pal.primary, anchor: "end" }));
  fy += 28;
  out.push(button(fx, fy, 380, 52, "Sign in", c));
  fy += 88;
  out.push(`<path d="M${n(fx)} ${n(fy)} H${n(fx + 130)} M${n(fx + 250)} ${n(fy)} H${n(fx + 380)}" stroke="${CARD_STROKE}"/>` + t(fx + 190, fy + 4, "or continue with", 12, { fill: "#94a3b8", anchor: "middle" }));
  fy += 28;
  out.push(button(fx, fy, 184, 46, "Google", c, "ghost") + button(fx + 196, fy, 184, 46, "GitHub", c, "ghost"));
  out.push(t(fx + 190, fy + 90, "New here? Create an account", 13, { fill: TEXT_MUTED, anchor: "middle" }));
  return out.join("\n");
}

function store(x: number, y: number, w: number, h: number, c: Ctx): string {
  const out: string[] = [];
  const p = 40;
  out.push(rect(x, y, w, h, 0, "#ffffff"));
  out.push(logoMark(x + p, y + 24, 32, c) + t(x + p + 44, y + 47, c.name, 18, { w: 700 }));
  out.push(rect(x + w * 0.32, y + 20, w * 0.36, 42, c.r, "#f1f5f9") + icon("search", x + w * 0.32 + 14, y + 31, 20, "#94a3b8") + t(x + w * 0.32 + 44, y + 46, "Search products", 14, { fill: "#94a3b8" }));
  out.push(icon("heart", x + w - p - 90, y + 30, 24, "#334155") + icon("cart", x + w - p - 44, y + 30, 24, "#334155") + `<circle cx="${n(x + w - p - 18)}" cy="${n(y + 30)}" r="9" fill="${c.pal.primary}"/>` + t(x + w - p - 18, y + 34, "2", 11, { w: 700, fill: "#ffffff", anchor: "middle" }));
  out.push(`<path d="M${n(x)} ${n(y + 84)} H${n(x + w)}" stroke="${CARD_STROKE}"/>`);
  const fw = 200;
  let fy = y + 120;
  out.push(t(x + p, fy, "Filters", 16, { w: 700 }));
  for (const [group, opts] of [["Category", ["New arrivals", "Bestsellers", "Essentials", "Sale"]], ["Price", ["Under $50", "$50 – $100", "$100+"]]] as const) {
    fy += 34;
    out.push(t(x + p, fy, group.toUpperCase(), 11, { w: 600, fill: "#94a3b8", ls: 1 }));
    opts.forEach((o, i) => {
      fy += 30;
      const on = i === 0;
      out.push(rect(x + p, fy - 13, 16, 16, 4, on ? c.pal.primary : "#ffffff", on ? "" : ` stroke="#cbd5e1"`) + t(x + p + 26, fy, o, 14, { fill: "#334155" }));
    });
  }
  const gx = x + p + fw + 24;
  const gw = w - (gx - x) - p;
  out.push(t(gx, y + 124, titleCase(c.subject).slice(0, 40), 24, { w: 800 }) + t(gx + gw, y + 124, "Sort: Featured ▾", 13, { fill: TEXT_MUTED, anchor: "end" }));
  const cols = 4;
  const gap = 20;
  const cw = (gw - gap * (cols - 1)) / cols;
  const rowsAvail = h - 170;
  const ch = Math.min(cw * 1.45, (rowsAvail - gap) / 2);
  const names = ["Everyday Tote", "Canvas Sneaker", "Merino Tee", "Linen Cap", "Travel Tote", "Trail Runner", "Oxford Shirt", "Wool Beanie"];
  for (let i = 0; i < 8; i++) {
    const cx = gx + (i % cols) * (cw + gap);
    const cy = y + 150 + Math.floor(i / cols) * (ch + gap);
    const tone = [c.pal.primary, c.pal.secondary, c.pal.accent][i % 3]!;
    const ih = ch - 76;
    out.push(rect(cx, cy, cw, ih, c.r * 1.5, mix(tone, "#ffffff", 0.82)));
    out.push(productGlyph(i, cx + cw / 2, cy + ih * 0.55, Math.min(cw, ih) * 0.62, mix(tone, "#ffffff", 0.2), mix(tone, "#000000", 0.25)));
    if (i % 3 === 0) out.push(pill(cx + 12, cy + 12, i === 0 ? "NEW" : "−20%", 10, "#ffffff", i === 0 ? c.pal.primary : "#b91c1c"));
    out.push(`<circle cx="${n(cx + cw - 24)}" cy="${n(cy + 24)}" r="15" fill="#ffffff"/>` + icon("heart", cx + cw - 33, cy + 15, 18, "#334155"));
    out.push(t(cx, cy + ih + 26, names[i]!, 14, { w: 600 }));
    out.push(t(cx, cy + ih + 48, `$${(29 + ((i * 37) % 140)).toFixed(0)}.00`, 14, { w: 700, fill: c.pal.primary }) + t(cx + cw, cy + ih + 48, `★ 4.${(i * 3) % 10}`, 12, { fill: TEXT_MUTED, anchor: "end" }));
  }
  return out.join("\n");
}

/** Simple flat product silhouettes (bag, sneaker, shirt, cap) in a size×size box. */
function productGlyph(i: number, cx: number, cy: number, size: number, fill: string, dark: string): string {
  const k = size / 100;
  const tr = `transform="translate(${n(cx - 50 * k)} ${n(cy - 50 * k)}) scale(${n(k)})"`;
  switch (i % 4) {
    case 0: // tote bag
      return `<g ${tr}><path d="M34 30 C34 10 66 10 66 30" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/><path d="M18 30 H82 L76 92 H24 Z" fill="${fill}"/><rect x="18" y="30" width="64" height="8" fill="${dark}" fill-opacity="0.25"/></g>`;
    case 1: // sneaker
      return `<g ${tr}><path d="M8 70 C8 52 20 40 30 38 L46 52 C58 58 74 60 88 64 C94 66 94 76 90 78 H10 Z" fill="${fill}"/><rect x="8" y="76" width="84" height="8" rx="4" fill="${dark}"/><path d="M34 46 L40 52 M40 42 L46 48" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></g>`;
    case 2: // shirt
      return `<g ${tr}><path d="M36 14 L50 22 L64 14 L90 28 L80 46 L70 40 V90 H30 V40 L20 46 L10 28 Z" fill="${fill}" stroke-linejoin="round"/><path d="M42 16 Q50 28 58 16" fill="none" stroke="${dark}" stroke-width="3"/></g>`;
    default: // cap
      return `<g ${tr}><path d="M18 64 C18 30 82 30 82 64 Z" fill="${fill}"/><path d="M14 64 H96 C96 72 80 74 60 72 H14 Z" fill="${dark}"/><circle cx="50" cy="34" r="4" fill="${dark}"/></g>`;
  }
}

function chat(x: number, y: number, w: number, h: number, c: Ctx): string {
  const out: string[] = [];
  const lw = 320;
  out.push(rect(x, y, w, h, 0, "#ffffff"));
  out.push(rect(x, y, lw, h, 0, "#f8fafc") + `<path d="M${n(x + lw)} ${n(y)} V${n(y + h)}" stroke="${CARD_STROKE}"/>`);
  out.push(t(x + 24, y + 48, "Messages", 22, { w: 800 }) + pill(x + lw - 70, y + 28, "12", 11, c.pal.primary, "#ffffff"));
  out.push(rect(x + 20, y + 72, lw - 40, 40, c.r, "#ffffff", ` stroke="${CARD_STROKE}"`) + icon("search", x + 32, y + 82, 20, "#94a3b8") + t(x + 60, y + 97, "Search conversations", 13, { fill: "#94a3b8" }));
  const people: [string, string, string][] = [["Maya Chen", "Sounds great — ship it! 🚀", "2m"], ["Design Team", "New mockups are up for review", "14m"], ["Leo Park", "Can we move the sync to 3pm?", "1h"], ["Support Bot", "Ticket #4821 was resolved", "3h"], ["Priya Nair", "Thanks for the quick fix", "Tue"], ["Ops Alerts", "All systems operational", "Mon"]];
  people.forEach(([name, msg, time], i) => {
    const py = y + 132 + i * 76;
    if (py + 70 > y + h) return;
    if (i === 0) out.push(rect(x + 12, py, lw - 24, 68, c.r, mix(c.pal.primary, "#ffffff", 0.9)));
    out.push(`<circle cx="${n(x + 46)}" cy="${n(py + 34)}" r="22" fill="${mix([c.pal.primary, c.pal.secondary, c.pal.accent][i % 3]!, "#ffffff", 0.55)}"/>` + t(x + 46, py + 39, name.split(" ").map((s) => s[0]).join("").slice(0, 2), 13, { w: 700, anchor: "middle", fill: "#1e293b" }));
    out.push(t(x + 80, py + 30, name, 14, { w: 700 }) + t(x + lw - 24, py + 30, time, 11, { fill: "#94a3b8", anchor: "end" }));
    out.push(t(x + 80, py + 52, msg.length > 30 ? `${msg.slice(0, 29)}…` : msg, 13, { fill: TEXT_MUTED }));
  });
  const mx = x + lw;
  const mw = w - lw;
  out.push(`<path d="M${n(mx)} ${n(y + 76)} H${n(x + w)}" stroke="${CARD_STROKE}"/>` + `<circle cx="${n(mx + 44)}" cy="${n(y + 38)}" r="20" fill="${mix(c.pal.primary, "#ffffff", 0.55)}"/>` + t(mx + 76, y + 34, "Maya Chen", 16, { w: 700 }) + `<circle cx="${n(mx + 80)}" cy="${n(y + 51)}" r="4" fill="#22c55e"/>` + t(mx + 90, y + 55, "Online", 12, { fill: TEXT_MUTED }));
  const msgs: [boolean, string][] = [[false, "Morning! Did the new build pass QA?"], [true, "Yes — all 214 checks green. Rolling out to 10% now."], [false, "Amazing. Any metrics yet?"], [true, "Error rate is flat and p95 latency dropped 18%."], [false, "Sounds great — ship it! 🚀"]];
  let my = y + 116;
  for (const [mine, text] of msgs) {
    const size = 14;
    const lines = wrapText(text, size, mw * 0.5, 3);
    const bw = Math.max(...lines.map((l) => textWidth(l, size, { safety: 1.05 }))) + 32;
    const bh = lines.length * 22 + 20;
    if (my + bh > y + h - 90) break;
    const bx = mine ? x + w - 32 - bw : mx + 32;
    out.push(rect(bx, my, bw, bh, 16, mine ? c.pal.primary : "#f1f5f9"));
    lines.forEach((l, i) => out.push(t(bx + 16, my + 28 + i * 22, l, size, { fill: mine ? readableOn(c.pal.primary, ["#ffffff", TEXT]) : TEXT })));
    my += bh + 14;
  }
  out.push(rect(mx + 24, y + h - 72, mw - 48, 50, 25, "#f8fafc", ` stroke="${CARD_STROKE}"`) + t(mx + 48, y + h - 41, "Write a message…", 14, { fill: "#94a3b8" }) + `<circle cx="${n(x + w - 50)}" cy="${n(y + h - 47)}" r="19" fill="${c.pal.primary}"/>` + `<path d="M${n(x + w - 57)} ${n(y + h - 47)} h12 m-5 -6 l6 6 l-6 6" stroke="#ffffff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  return out.join("\n");
}

function phoneScreen(x: number, y: number, w: number, h: number, c: Ctx, variant: "home" | "detail"): string {
  const out: string[] = [];
  const s = c.subject.toLowerCase();
  const kind = hasAny(s, ["music", "player", "podcast", "audio", "song"]) ? "music" : hasAny(s, ["fitness", "workout", "health", "run", "running"]) ? "fitness" : hasAny(s, ["wallet", "bank", "finance", "money", "budget"]) ? "finance" : "generic";
  out.push(rect(x, y, w, h, 0, "#f8fafc"));
  out.push(t(x + 24, y + 30, "9:41", 13, { w: 700 }) + rect(x + w - 58, y + 20, 28, 12, 3, "none", ` stroke="${TEXT}" stroke-width="1.4"`) + rect(x + w - 56, y + 22, 20, 8, 2, TEXT));
  const p = 22;
  if (variant === "home") {
    out.push(t(x + p, y + 78, "Good morning,", 15, { fill: TEXT_MUTED }) + t(x + p, y + 106, "Alex 👋", 26, { w: 800 }));
    out.push(`<circle cx="${n(x + w - p - 20)}" cy="${n(y + 90)}" r="20" fill="${mix(c.pal.secondary, "#ffffff", 0.4)}"/>`);
    out.push(`<linearGradient id="hero-${c.uid}-${variant}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.pal.primary}"/><stop offset="1" stop-color="${mix(c.pal.secondary, c.pal.primary, 0.3)}"/></linearGradient>`);
    const cy = y + 132;
    out.push(rect(x + p, cy, w - 2 * p, 150, 22, `url(#hero-${c.uid}-${variant})`));
    const fg = readableOn(c.pal.primary, ["#ffffff", TEXT]);
    const [label, big, sub] = kind === "fitness" ? ["Today's activity", "8,432", "steps · 72% of goal"] : kind === "finance" ? ["Total balance", "$24,580", "+6.2% this month"] : kind === "music" ? ["Daily mix", "42 songs", "Updated for you"] : ["This week", "12 tasks", "3 due today"];
    out.push(t(x + p + 20, cy + 36, label, 13, { fill: fg, op: 0.85 }) + t(x + p + 20, cy + 82, big, 34, { w: 800, fill: fg }) + t(x + p + 20, cy + 110, sub, 13, { fill: fg, op: 0.85 }));
    out.push(`<circle cx="${n(x + w - p - 46)}" cy="${n(cy + 75)}" r="30" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="8"/><circle cx="${n(x + w - p - 46)}" cy="${n(cy + 75)}" r="30" fill="none" stroke="#ffffff" stroke-width="8" stroke-dasharray="${n(2 * Math.PI * 30 * 0.72)} 999" stroke-linecap="round" transform="rotate(-90 ${n(x + w - p - 46)} ${n(cy + 75)})"/>`);
    let ly = cy + 184;
    out.push(t(x + p, ly, kind === "music" ? "Recently played" : "Upcoming", 17, { w: 700 }) + t(x + w - p, ly, "See all", 13, { w: 600, fill: c.pal.primary, anchor: "end" }));
    const items = kind === "music" ? [["Midnight Drive", "Lo-fi Beats"], ["Golden Hour", "Indie Mix"], ["Deep Focus", "Ambient"]] : kind === "fitness" ? [["Morning run", "6:30 · 5 km"], ["Upper body", "12:00 · 45 min"], ["Evening yoga", "19:00 · 20 min"]] : kind === "finance" ? [["Rent", "Due Apr 1 · $1,850"], ["Groceries", "Yesterday · $86.20"], ["Salary", "Mar 28 · +$4,120"]] : [["Design review", "10:00 · Studio"], ["Team sync", "13:30 · Zoom"], ["Launch prep", "16:00 · Room 4"]];
    ly += 18;
    items.forEach(([a, b], i) => {
      const iy = ly + i * 76;
      if (iy + 64 > y + h - 90) return;
      out.push(rect(x + p, iy, w - 2 * p, 64, 16, "#ffffff", ` stroke="${CARD_STROKE}"`));
      out.push(rect(x + p + 12, iy + 12, 40, 40, 12, mix([c.pal.primary, c.pal.secondary, c.pal.accent][i % 3]!, "#ffffff", 0.75)) + icon(kind === "music" ? "play" : kind === "fitness" ? "heart" : kind === "finance" ? "chart" : "folder", x + p + 22, iy + 22, 20, c.pal.primary));
      out.push(t(x + p + 64, iy + 28, a!, 14, { w: 700 }) + t(x + p + 64, iy + 48, b!, 12, { fill: TEXT_MUTED }));
    });
  } else {
    if (kind === "music") {
      out.push(t(x + w / 2, y + 74, "NOW PLAYING", 11, { w: 700, fill: TEXT_MUTED, anchor: "middle", ls: 2 }));
      const a = w - 2 * p - 20;
      out.push(`<linearGradient id="art-${c.uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.pal.secondary}"/><stop offset="1" stop-color="${c.pal.primary}"/></linearGradient>`);
      out.push(rect(x + p + 10, y + 96, a, a, 24, `url(#art-${c.uid})`) + `<circle cx="${n(x + w / 2)}" cy="${n(y + 96 + a / 2)}" r="${n(a * 0.28)}" fill="#ffffff" fill-opacity="0.15"/><circle cx="${n(x + w / 2)}" cy="${n(y + 96 + a / 2)}" r="${n(a * 0.08)}" fill="#ffffff" fill-opacity="0.6"/>`);
      const ty = y + 96 + a + 44;
      out.push(t(x + p + 10, ty, "Midnight Drive", 22, { w: 800 }) + t(x + p + 10, ty + 24, "Lo-fi Beats · Night Tapes", 14, { fill: TEXT_MUTED }));
      out.push(rect(x + p + 10, ty + 50, a, 5, 3, "#e2e8f0") + rect(x + p + 10, ty + 50, a * 0.38, 5, 3, c.pal.primary) + `<circle cx="${n(x + p + 10 + a * 0.38)}" cy="${n(ty + 52.5)}" r="8" fill="${c.pal.primary}"/>`);
      out.push(t(x + p + 10, ty + 76, "1:24", 11, { fill: TEXT_MUTED }) + t(x + p + 10 + a, ty + 76, "3:41", 11, { fill: TEXT_MUTED, anchor: "end" }));
      const by = ty + 124;
      out.push(`<circle cx="${n(x + w / 2)}" cy="${n(by)}" r="34" fill="${c.pal.primary}"/>` + rect(x + w / 2 - 10, by - 12, 7, 24, 2, "#ffffff") + rect(x + w / 2 + 3, by - 12, 7, 24, 2, "#ffffff"));
      out.push(`<path d="M${n(x + w / 2 - 88)} ${n(by - 10)} v20 M${n(x + w / 2 - 70)} ${n(by - 10)} l-14 10 l14 10 Z M${n(x + w / 2 + 88)} ${n(by - 10)} v20 M${n(x + w / 2 + 70)} ${n(by - 10)} l14 10 l-14 10 Z" stroke="${TEXT}" stroke-width="3" fill="${TEXT}" stroke-linejoin="round"/>`);
    } else {
      out.push(t(x + p, y + 84, kind === "fitness" ? "Weekly progress" : kind === "finance" ? "Spending" : "Insights", 24, { w: 800 }));
      out.push(t(x + p, y + 108, "Mar 24 – Mar 30", 13, { fill: TEXT_MUTED }));
      const cx0 = x + p;
      const cw = w - 2 * p;
      const bars = [0.45, 0.7, 0.55, 0.9, 0.62, 0.38, 0.8];
      const base = y + 330;
      bars.forEach((b, i) => {
        const bw = cw / bars.length - 14;
        const bx = cx0 + i * (cw / bars.length) + 7;
        out.push(rect(bx, base - 180, bw, 180, 10, "#eef2f7") + rect(bx, base - 180 * b, bw, 180 * b, 10, i === 3 ? c.pal.primary : mix(c.pal.primary, "#ffffff", 0.55)));
        out.push(t(bx + bw / 2, base + 22, ["M", "T", "W", "T", "F", "S", "S"][i]!, 12, { fill: TEXT_MUTED, anchor: "middle" }));
      });
      const stats: [string, string][] = kind === "fitness" ? [["Avg steps", "7,904"], ["Active min", "312"]] : kind === "finance" ? [["Spent", "$1,284"], ["Saved", "$640"]] : [["Completed", "38"], ["On time", "94%"]];
      stats.forEach(([l, v], i) => {
        const sx = x + p + i * ((w - 2 * p) / 2 + 6);
        const sw2 = (w - 2 * p) / 2 - 6;
        out.push(rect(sx, base + 50, sw2, 96, 18, "#ffffff", ` stroke="${CARD_STROKE}"`) + t(sx + 16, base + 82, l, 12, { fill: TEXT_MUTED }) + t(sx + 16, base + 120, v, 26, { w: 800 }));
      });
      out.push(button(x + p, base + 170, w - 2 * p, 52, kind === "fitness" ? "Start workout" : kind === "finance" ? "Add transaction" : "Create task", c));
    }
  }
  // Tab bar.
  out.push(rect(x, y + h - 76, w, 76, 0, "#ffffff") + `<path d="M${n(x)} ${n(y + h - 76)} H${n(x + w)}" stroke="${CARD_STROKE}"/>`);
  ["home", "chart", "message", "users"].forEach((ic, i) => out.push(icon(ic, x + (w * (i + 0.5)) / 4 - 12, y + h - 58, 24, i === (variant === "home" ? 0 : 1) ? c.pal.primary : "#94a3b8")));
  out.push(rect(x + w / 2 - 60, y + h - 14, 120, 5, 3, TEXT));
  return out.join("\n");
}

function phone(x: number, y: number, w: number, h: number, c: Ctx, variant: "home" | "detail", clipId: string): string {
  const bez = 14;
  return [
    rect(x - bez, y - bez, w + 2 * bez, h + 2 * bez, 58, "#0f172a"),
    rect(x - bez + 3, y - bez + 3, w + 2 * bez - 6, h + 2 * bez - 6, 55, "none", ` stroke="#334155" stroke-width="2"`),
    `<clipPath id="${clipId}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="44"/></clipPath>`,
    `<g clip-path="url(#${clipId})">${phoneScreen(x, y, w, h, c, variant)}</g>`,
    rect(x + w / 2 - 58, y + 10, 116, 32, 16, "#0f172a"),
  ].join("\n");
}

/** "SaaS landing page for Orbit" → "Orbit"; "fitness mobile app" → "Fitness". */
export function appName(subject: string): string {
  const named = /\b(?:for|called|named)\s+["“']?([A-Za-z0-9][\w&'.-]*(?:\s+[A-Za-z0-9][\w&'.-]*){0,2})/i.exec(subject);
  if (named) return titleCase(named[1]!.replace(/["”']/g, ""));
  const generic = /\b(ui|ux|mockup|mock-up|screen|screens|design|page|app|application|web|website|mobile|ios|android|dashboard|landing|login|signin|signup|store|shop|chat|the|a|an|for|of|with|and)\b/gi;
  const words = subject.replace(generic, " ").trim().split(/\s+/).filter(Boolean);
  return titleCase(words.slice(0, 2).join(" ")) || titleCase(subject.split(/\s+/)[0] ?? "") || "Acme";
}

export interface UiMockup { svg: string; width: number; height: number; screen: Screen; device: "browser" | "phone" }

export function uiMockupSvg(subject: string, palette: string[] | undefined, opts: VectorOptions = {}): UiMockup {
  const pal = designPalette(palette);
  const screen = chooseScreen(subject);
  const { width: W, height: H } = sizeFor(opts.aspectRatio, 1600, [16, 10]);
  const uid = (seedFrom(`ui:${subject}`) % 1e6).toString(36);
  const sharp = /sharp/i.test(opts.cornerStyle ?? "") || /\bsharp|brutal/i.test(opts.style ?? "");
  const name = appName(subject);
  const c: Ctx = { pal, r: sharp ? 4 : 10, rng: makeRng(seedFrom(`ui:${subject}`)), uid, name, subject };
  const bgA = mix(pal.light, lighten(pal.secondary, 0.7), 0.5);
  const bgB = mix(pal.light, lighten(pal.primary, 0.72), 0.6);
  const defs = [
    `<linearGradient id="bg-${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>`,
    `<filter id="sh-${uid}" x="-10%" y="-10%" width="120%" height="130%"><feGaussianBlur in="SourceAlpha" stdDeviation="18"/><feOffset dy="18" result="b"/><feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
  ].join("");
  const body: string[] = [`<rect width="${W}" height="${H}" fill="url(#bg-${uid})"/>`];
  body.push(`<circle cx="${n(W * 0.08)}" cy="${n(H * 0.92)}" r="${n(W * 0.16)}" fill="${pal.primary}" fill-opacity="0.06"/><circle cx="${n(W * 0.94)}" cy="${n(H * 0.06)}" r="${n(W * 0.12)}" fill="${pal.secondary}" fill-opacity="0.08"/>`);

  if (screen === "mobile") {
    const ph = Math.min(H * 0.84, 844);
    const pw = ph * (390 / 844);
    const gap = W * 0.06;
    const x0 = W / 2 - pw - gap / 2;
    body.push(`<g filter="url(#sh-${uid})">${phone(x0, (H - ph) / 2, pw, ph, c, "home", `clipA-${uid}`)}</g>`);
    body.push(`<g filter="url(#sh-${uid})">${phone(W / 2 + gap / 2, (H - ph) / 2 + H * 0.03, pw, ph, c, "detail", `clipB-${uid}`)}</g>`);
    return { svg: svgDoc(W, H, body.join("\n"), { title: `${name} — mobile app mockup`, desc: `UI mockup (mobile) for ${subject}`, defs }), width: W, height: H, screen, device: "phone" };
  }

  const m = Math.round(W * 0.075);
  const bx = m;
  const by = Math.round(H * 0.08);
  const bw = W - 2 * m;
  const bh = H - by - Math.round(H * 0.06);
  const bar = 44;
  const clip = `win-${uid}`;
  body.push(`<clipPath id="${clip}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${sharp ? 6 : 18}"/></clipPath>`);
  body.push(`<g filter="url(#sh-${uid})"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${sharp ? 6 : 18}" fill="#ffffff"/></g>`);
  const inner: string[] = [];
  inner.push(rect(bx, by, bw, bar, 0, "#f1f5f9") + `<path d="M${bx} ${by + bar} H${bx + bw}" stroke="${CARD_STROKE}"/>`);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((col, i) => inner.push(`<circle cx="${bx + 24 + i * 20}" cy="${by + bar / 2}" r="6" fill="${col}"/>`));
  const host = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.app/${screen === "auth" ? "login" : screen === "store" ? "shop" : screen === "chat" ? "inbox" : screen === "landing" ? "" : "dashboard"}`;
  inner.push(rect(bx + bw / 2 - 180, by + 9, 360, 26, 8, "#ffffff", ` stroke="${CARD_STROKE}"`) + icon("shield", bx + bw / 2 - 168, by + 14, 16, "#94a3b8") + t(bx + bw / 2, by + 27, host, 12, { fill: TEXT_MUTED, anchor: "middle" }));
  const cx = bx;
  const cy = by + bar;
  const cw = bw;
  const ch = bh - bar;
  const draw = screen === "landing" ? landing : screen === "auth" ? auth : screen === "store" ? store : screen === "chat" ? chat : dashboard;
  inner.push(draw(cx, cy, cw, ch, c));
  body.push(`<g clip-path="url(#${clip})">${inner.join("\n")}</g>`);
  body.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${sharp ? 6 : 18}" fill="none" stroke="#cbd5e1" stroke-width="1"/>`);
  return {
    svg: svgDoc(W, H, body.join("\n"), { title: `${name} — ${screen} UI mockup`, desc: `UI mockup (${screen}) for ${subject}`, defs }),
    width: W, height: H, screen, device: "browser",
  };
}

