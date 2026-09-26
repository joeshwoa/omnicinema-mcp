/**
 * Graphic Designer / Vector Artist persona.
 *
 * Leads branding/vector asset kinds (logos, vector art, UI mockups). Dictates
 * flat color usage, padding, clean icon geometry, and SVG-friendly construction.
 */
import type { ConsultationInput, Persona, PersonaContribution, PersonaRole } from "./types.js";

const PALETTES: Record<string, string[]> = {
  default: ["#2563eb", "#0ea5e9", "#f8fafc"],
  warm: ["#f97316", "#ef4444", "#fff7ed"],
  earth: ["#166534", "#65a30d", "#f7fee7"],
  mono: ["#111827", "#6b7280", "#f9fafb"],
  vibrant: ["#7c3aed", "#ec4899", "#22d3ee"],
};

/** Common colour words → a brand-usable hex (Tailwind 600/700 tones). */
const COLOR_WORDS: Record<string, string> = {
  red: "#dc2626", crimson: "#be123c", maroon: "#7f1d1d", orange: "#ea580c", amber: "#d97706",
  gold: "#b8860b", golden: "#b8860b", yellow: "#ca8a04", lime: "#65a30d", green: "#16a34a",
  emerald: "#059669", olive: "#556b2f", teal: "#0f766e", turquoise: "#0d9488", cyan: "#0891b2",
  sky: "#0284c7", blue: "#2563eb", navy: "#1e3a8a", indigo: "#4f46e5", violet: "#7c3aed",
  purple: "#9333ea", magenta: "#c026d3", pink: "#db2777", rose: "#e11d48", brown: "#7c4a21",
  coffee: "#6f4e37", beige: "#d6c7a1", cream: "#f5efe0", sand: "#c2a878", black: "#111827",
  charcoal: "#1f2937", grey: "#6b7280", gray: "#6b7280", silver: "#9ca3af", white: "#f9fafb",
};

/**
 * Palette from the style text. Explicit brand colours win: hex codes
 * ("#0f766e #f59e0b") first, then colour words ("teal and gold"), then the
 * mood palettes. Always returns 3 colours (primary, secondary, light).
 */
function choosePalette(style: string): { name: string; colors: string[] } {
  const s = style.toLowerCase();
  const hexes = [...style.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => {
    const h = m[0].toLowerCase();
    return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
  });
  const words = [...s.matchAll(/[a-z]+/g)].map((m) => m[0]).filter((w) => COLOR_WORDS[w]).map((w) => COLOR_WORDS[w]!);
  const brand = [...new Set([...hexes, ...words])];
  if (brand.length) {
    const colors = brand.slice(0, 3);
    if (colors.length === 1) colors.push(colors[0]!);
    if (colors.length === 2) colors.push("#f8fafc");
    return { name: hexes.length ? "brand (hex)" : "brand (named colours)", colors };
  }
  if (s.includes("warm") || s.includes("sunset")) return { name: "warm", colors: PALETTES.warm! };
  if (s.includes("earth") || s.includes("nature") || s.includes("eco")) return { name: "earth", colors: PALETTES.earth! };
  if (s.includes("mono") || s.includes("minimal") || s.includes("noir")) return { name: "mono", colors: PALETTES.mono! };
  if (s.includes("vibrant") || s.includes("playful") || s.includes("neon")) return { name: "vibrant", colors: PALETTES.vibrant! };
  return { name: "default", colors: PALETTES.default! };
}

export const graphicDesigner: Persona = {
  id: "graphic-designer",
  title: "Graphic Designer / Vector Artist",
  leads: ["logo", "vector-art", "ui-mockup"],
  advises: [],

  contribute(input: ConsultationInput, role: PersonaRole): PersonaContribution {
    const style = input.style || "clean minimal";
    // Illustrations may name their colours in the subject ("teal waves");
    // logo/UI subjects are names, so only the style text counts there.
    const { name: paletteName, colors } = choosePalette(
      input.assetKind === "vector-art" ? `${style} ${input.subject}` : style,
    );
    const isLogo = input.assetKind === "logo";
    const isUi = input.assetKind === "ui-mockup";
    const cornerStyle = style.toLowerCase().includes("sharp") ? "sharp corners" : "softly rounded corners";

    if (role === "advisor") {
      return {
        persona: this.id,
        role,
        directives: ["Maintain a clear focal hierarchy and generous margins even in a photographic frame."],
        positive: ["balanced composition", "clear focal point"],
        negative: ["cluttered composition"],
        params: {},
      };
    }

    const directives = [
      `Use a limited ${paletteName} palette (${colors.join(", ")}); flat fills, no photographic texture.`,
      "Build from clean geometric primitives with consistent stroke weights and optical alignment on a grid.",
      "Keep generous padding and balanced negative space; the mark must read at 16px and 512px.",
    ];
    if (isLogo) directives.push("Deliver on a transparent background, centered, with a clear safe-area margin.");
    if (isUi) directives.push("Lay out with an 8pt spacing system, aligned components, and a single accent color.");

    const positive = [
      "flat vector illustration",
      "clean geometry",
      "minimal",
      `${paletteName} limited color palette`,
      "crisp edges",
      cornerStyle,
      "centered composition",
      "generous padding",
      "balanced negative space",
      isUi ? "modern UI layout, 8pt grid" : "iconographic, scalable",
    ];

    const negative = [
      "photorealistic",
      "photography",
      "3d render",
      "noise",
      "grain",
      "photographic texture",
      "gradient mesh",
      "drop shadow",
      "blurry",
      "jpeg artifacts",
      "busy background",
      isLogo ? "opaque background" : "clutter",
    ];

    return {
      persona: this.id,
      role,
      directives,
      positive,
      negative,
      params: {
        aspectRatio: input.aspectRatio || (isUi ? "16:10" : "1:1"),
        transparentBackground: isLogo,
        palette: colors,
        gridUnit: 8,
        cornerStyle,
        svgFriendly: true,
        guidanceScale: 7.5,
        steps: 28,
        styleTags: [style, "vector", paletteName],
      },
    };
  },
};
