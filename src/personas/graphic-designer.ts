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

function choosePalette(style: string): { name: string; colors: string[] } {
  const s = style.toLowerCase();
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
    const { name: paletteName, colors } = choosePalette(style);
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
