/**
 * Datos del archivo y lectura del ICC.
 *
 * Acá no se decide nada ni se recomienda ninguna configuración del RIP: se
 * describe lo que el PDF trae. Las alertas, que son pocas y en criollo, viven
 * en `findings.ts`.
 */

import type { IccProfile } from "./icc.ts";
import type { IccUsage, OutputIntent, PageBoxes } from "./pdf-deep.ts";

/** Umbrales únicos del taller. */
export const LIMITS = {
  /** Límite físico del formato PDF en puntos (200 pulgadas). */
  maxPagePoints: 14400,
} as const;

export const WHITE_INK_PATTERN = /^(?:rdg[_\s-]?white|white(?:[_\s-]?ink)?|blanco|wit|weiss|spot\s?1|spot1|w_?ink|underbase|base[_\s-]?blanca)$/i;
export const CUT_PATTERN = /^(?:cut\s?contour|cutcontour\d*|thru[-_\s]?cut|kiss[-_\s]?cut|perf(?:orate)?|crease|corte|contorno|troquel|die[-_\s]?cut|cut(?:line|path)?)$/i;

const mm = (points: number) => (points * 25.4) / 72;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export type IccVerdict = {
  state: "incrustado" | "solo-nombre" | "del-exportador" | "sin-icc" | "incoherente";
  label: string;
  summary: string;
};

/** Qué perfil trae el archivo y si son datos reales o apenas una etiqueta. */
export function iccVerdict(iccUsages: IccUsage[], outputIntents: OutputIntent[]): IccVerdict {
  const readable = iccUsages.filter((usage) => usage.profile);
  const output = readable.filter((usage) => usage.role === "output-intent");
  const working = readable.filter((usage) => usage.role !== "output-intent");

  if (iccUsages.some((usage) => usage.broken) || iccUsages.some((usage) => usage.mismatches.length)) {
    return {
      state: "incoherente",
      label: "Perfil incoherente",
      summary: "El archivo trae un perfil que no coincide con lo que declara, o que no se puede leer entero.",
    };
  }

  if (output.length) {
    const profile = output[0].profile as IccProfile;
    return {
      state: "incrustado",
      label: "Incrustado con sus datos",
      summary: `${profileName(profile)}, versión ${profile.versionLabel}, ${profile.channels} canales. El perfil viaja entero dentro del PDF.`,
    };
  }

  if (outputIntents.length) {
    const identifier = outputIntents[0].outputConditionIdentifier || outputIntents[0].outputCondition || "sin nombre";
    return {
      state: "solo-nombre",
      label: "Solo el nombre",
      summary: `El archivo menciona “${identifier}” pero no incluye el perfil. Es una etiqueta de texto, los datos de color no vienen adentro.`,
    };
  }

  if (working.length) {
    const names = Array.from(new Set(working.map((usage) => profileName(usage.profile as IccProfile))));
    return {
      state: "del-exportador",
      label: "Lo puso el programa de diseño",
      summary: `${names.join(", ")}. Es el espacio de trabajo que la aplicación adjunta sola al exportar, no un perfil elegido para este trabajo.`,
    };
  }

  return { state: "sin-icc", label: "Sin perfil", summary: "El archivo no trae ningún perfil ICC." };
}

function profileName(profile: IccProfile) {
  return profile.description || profile.known?.name || `Perfil ${profile.dataColorSpaceLabel}`;
}

export type Fact = { label: string; value: string; note?: string };

export type FactsInput = {
  pdfVersion: string | null;
  pages: number;
  geometry: PageBoxes[];
  colorSpaces: string[];
  imageColorSpaces: string[];
  imageCount: number;
  ppiMin: number | null;
  ppiMax: number | null;
  hasText: boolean;
  textCharacters: number;
  fontNames: string[];
  spotInks: Array<{ name: string; alternate: string | null }>;
  iccUsages: IccUsage[];
  outputIntents: OutputIntent[];
  pdfxVersion: string | null;
  layerCount: number;
  mirrored: { mirrored: number; upright: number };
};

/** La medida real de la pieza, ya con el factor de escala del documento aplicado. */
export function pieceSize(geometry: PageBoxes[]) {
  const page = geometry[0];
  if (!page) return null;
  const box = page.trim || page.crop || page.media;
  if (!box) return null;
  const scale = page.userUnit > 0 ? page.userUnit : 1;
  return {
    widthMm: mm(box[2] - box[0]) * scale,
    heightMm: mm(box[3] - box[1]) * scale,
    scale,
  };
}

/** Todo lo que describe al archivo, sin juzgarlo. */
export function fileFacts(input: FactsInput): Fact[] {
  const facts: Fact[] = [];
  const size = pieceSize(input.geometry);

  if (size) {
    facts.push({
      label: "Medida",
      value: `${round(size.widthMm / 10)} × ${round(size.heightMm / 10)} cm`,
      note: size.scale !== 1 ? `El documento viene a escala ×${size.scale}; esta es la medida final.` : undefined,
    });
  }

  facts.push({ label: "Páginas", value: String(input.pages) });
  facts.push({ label: "Color", value: input.colorSpaces.join(" + ") || "No concluyente" });

  const verdict = iccVerdict(input.iccUsages, input.outputIntents);
  const profile = input.iccUsages.find((usage) => usage.profile)?.profile;
  facts.push({
    label: "Perfil ICC",
    value: profile ? profileName(profile) : verdict.label,
    note: verdict.summary,
  });

  if (profile) {
    const tables = profile.tags.filter((tag) => /^(?:A2B|B2A|D2B|B2D)/.test(tag));
    facts.push({
      label: "Contenido del perfil",
      value: tables.length ? "Tablas de color reales" : "Solo etiquetas",
      note: tables.length
        ? `Versión ${profile.versionLabel}, ${profile.channels} canales, ${Math.round(profile.byteLength / 1024)} KB, con las tablas ${tables.join(", ")}.`
        : `Versión ${profile.versionLabel}, ${Math.round(profile.byteLength / 1024)} KB, sin tablas de conversión: no sirve para convertir color.`,
    });
  }

  if (input.pdfxVersion) facts.push({ label: "Norma", value: input.pdfxVersion });

  facts.push({
    label: "Imágenes",
    value: input.imageCount === 0 ? "Ninguna, todo vectorial" : `${input.imageCount}`,
    note: input.imageCount && input.ppiMin !== null
      ? `Entre ${input.ppiMin} y ${input.ppiMax} puntos por pulgada al tamaño colocado.`
      : undefined,
  });

  if (input.imageColorSpaces.length) facts.push({ label: "Color de las imágenes", value: input.imageColorSpaces.join(" · ") });

  facts.push({
    label: "Texto",
    value: input.hasText ? `${input.textCharacters.toLocaleString("es-UY")} caracteres` : "Sin texto, todo trazado",
    note: input.hasText && input.fontNames.length ? input.fontNames.slice(0, 6).join(", ") : undefined,
  });

  if (input.spotInks.length) {
    facts.push({
      label: "Tintas directas",
      value: input.spotInks.map((ink) => ink.name).join(" · "),
    });
  }

  if (input.layerCount) facts.push({ label: "Capas", value: String(input.layerCount) });

  if (input.mirrored.mirrored + input.mirrored.upright > 0) {
    facts.push({
      label: "Orientación",
      value: input.mirrored.mirrored === 0 ? "Al derecho" : input.mirrored.upright === 0 ? "Espejado" : "Mixto",
      note: input.mirrored.mirrored === 0 ? "El espejo lo aplica el RIP al enviar a la máquina." : undefined,
    });
  }

  if (input.pdfVersion) facts.push({ label: "Versión PDF", value: input.pdfVersion });

  return facts;
}
