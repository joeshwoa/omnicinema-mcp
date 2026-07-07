/**
 * Director of Photography persona.
 *
 * Leads photoreal asset kinds (cinematic photos, textures). Dictates lens choice,
 * volumetric lighting, shadow behavior, camera angle, and depth of field.
 */
import type { ConsultationInput, Persona, PersonaContribution, PersonaRole } from "./types.js";

const PERSON_HINTS = ["person", "portrait", "face", "man", "woman", "character", "keeper", "actor"];
const WIDE_HINTS = ["landscape", "city", "skyline", "vista", "mountain", "sea", "harbor", "field", "desert"];

function chooseLens(subject: string, kind: string): { lens: string; camera: string; dof: string } {
  const s = subject.toLowerCase();
  if (kind === "texture") {
    return { lens: "100mm macro lens", camera: "full-frame sensor", dof: "flat, edge-to-edge focus" };
  }
  if (PERSON_HINTS.some((h) => s.includes(h))) {
    return { lens: "85mm prime lens", camera: "ARRI Alexa", dof: "shallow depth of field, creamy bokeh" };
  }
  if (WIDE_HINTS.some((h) => s.includes(h))) {
    return { lens: "24mm wide-angle lens", camera: "RED Komodo", dof: "deep focus" };
  }
  return { lens: "35mm lens", camera: "Sony Venice", dof: "moderate depth of field" };
}

function chooseLighting(style: string): { mood: string; setup: string } {
  const st = style.toLowerCase();
  if (st.includes("noir") || st.includes("dark") || st.includes("dramatic")) {
    return { mood: "low-key chiaroscuro", setup: "hard key, deep falloff shadows, single rim light" };
  }
  if (st.includes("golden") || st.includes("warm") || st.includes("sunset")) {
    return { mood: "warm golden-hour", setup: "low sun backlight, long soft shadows, gentle haze" };
  }
  if (st.includes("clean") || st.includes("studio") || st.includes("bright")) {
    return { mood: "high-key studio", setup: "large softbox key, fill card, even soft shadows" };
  }
  return { mood: "naturalistic cinematic", setup: "soft key with rim separation, motivated practicals" };
}

export const directorOfPhotography: Persona = {
  id: "director-of-photography",
  title: "Director of Photography",
  leads: ["cinematic-photo", "texture"],
  advises: ["ui-mockup"],

  contribute(input: ConsultationInput, role: PersonaRole): PersonaContribution {
    const style = input.style || "naturalistic cinematic";
    const { lens, camera, dof } = chooseLens(input.subject, input.assetKind);
    const { mood, setup } = chooseLighting(style);

    if (role === "advisor") {
      return {
        persona: this.id,
        role,
        directives: [
          "Keep any implied light physically plausible: consistent direction and soft contact shadows.",
          "Add subtle ambient occlusion so elements feel grounded, but do not introduce photographic depth of field.",
        ],
        positive: ["soft realistic shadows", "subtle ambient occlusion", "consistent light direction"],
        negative: ["blown-out highlights", "conflicting shadow directions"],
        params: {},
      };
    }

    return {
      persona: this.id,
      role,
      directives: [
        `Shoot on a ${camera} with a ${lens}; ${dof}.`,
        `Light it ${mood}: ${setup}.`,
        "Compose with intentional camera angle and clear subject separation from the background.",
        "Render volumetric light, physically based materials, and realistic micro-contrast.",
      ],
      positive: [
        "photorealistic",
        "cinematic",
        `shot on ${camera}`,
        lens,
        dof,
        `${mood} lighting`,
        "volumetric lighting",
        "global illumination",
        "physically based rendering",
        "high dynamic range",
        "sharp focus",
        "8k detail",
      ],
      negative: [
        "cartoon",
        "illustration",
        "flat lighting",
        "overexposed",
        "underexposed",
        "low resolution",
        "deformed",
        "extra limbs",
        "watermark",
        "signature",
        "text",
      ],
      params: {
        aspectRatio: input.aspectRatio || (input.assetKind === "texture" ? "1:1" : "16:9"),
        guidanceScale: 6.5,
        steps: 30,
        styleTags: [style, mood],
        seamless: input.assetKind === "texture",
      },
    };
  },
};
