/**
 * Inspección profunda del PDF orientada a RIP de producción
 * (PhotoPRINT / Flexi 2022+, VersaWorks, Onyx, Caldera).
 *
 * Aquí vive todo lo que no se puede leer con PDF.js: intenciones de salida,
 * perfiles ICC con su rol real dentro del documento, cajas de página,
 * tintas directas con su espacio alternativo y funciones PDF que rompen RIP.
 */

import { decodePdfStream, indirectObjects, rawPdfStreams } from "./pdf-structure.ts";
import { parseIccProfile, type IccProfile } from "./icc.ts";

export type IccRole = "output-intent" | "colorspace" | "image" | "default" | "desconocido";

export type IccUsage = {
  objectNumber: number | null;
  role: IccRole;
  /** Número de canales declarado en el PDF con /N. */
  declaredComponents: number | null;
  /** Espacio alternativo declarado con /Alternate. */
  alternate: string | null;
  profile: IccProfile | null;
  /** El flujo existe pero no se pudo descomprimir o no es un ICC válido. */
  broken: boolean;
  /** Incoherencias entre lo que dice el PDF y lo que dice el perfil. */
  mismatches: string[];
};

export type OutputIntent = {
  subtype: string | null;
  outputCondition: string | null;
  outputConditionIdentifier: string | null;
  registryName: string | null;
  info: string | null;
  destProfileRef: number | null;
  hasDestProfile: boolean;
};

export type PageBoxes = {
  page: number;
  media: number[] | null;
  crop: number[] | null;
  trim: number[] | null;
  bleed: number[] | null;
  art: number[] | null;
  rotate: number;
  userUnit: number;
};

export type SpotInk = {
  name: string;
  /** Espacio al que el PDF convierte la tinta si el RIP no la conoce. */
  alternate: string | null;
  kind: "Separation" | "DeviceN";
  /** La tinta se usa como relleno de objetos. */
  usedAsFill: boolean;
  /** La tinta se usa como trazo (lo que exige un contorno de corte). */
  usedAsStroke: boolean;
  /** La tinta aparece como espacio de color de una imagen ráster. */
  usedInImage: boolean;
};

export type RiskFeatures = {
  shadingTypes: number[];
  type3Fonts: number;
  printableAnnotations: number;
  annotationSubtypes: string[];
  transferFunctions: boolean;
  halftones: boolean;
  blackGeneration: boolean;
  opi: boolean;
  jbig2: boolean;
  ccitt: boolean;
  jpx: boolean;
  interpolatedImages: boolean;
  tilingPatterns: number;
  shadingPatterns: number;
  softMasks: number;
  knockoutGroups: number;
  isolatedGroups: number;
  embeddedFiles: number;
  registrationColor: boolean;
  indexedImages: number;
  hasXmp: boolean;
  optionalContentInXObjects: number;
};

const NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)";

/**
 * Desde PDF 1.5 la mayoría de los diccionarios viajan comprimidos dentro de
 * flujos /ObjStm. Sin expandirlos, un análisis basado en texto no ve el
 * catálogo, las páginas ni los espacios de color de casi ningún PDF moderno.
 */
export async function expandObjectStreams(bytes: Uint8Array, raw: string) {
  const parts: string[] = [];
  let budget = 24 * 1024 * 1024;

  for (const { dictionary, source } of rawPdfStreams(bytes, raw)) {
    if (!/\/Type\s*\/ObjStm\b/.test(dictionary)) continue;
    const count = Number(dictionary.match(/\/N\s+(\d+)/)?.[1] || 0);
    const first = Number(dictionary.match(/\/First\s+(\d+)/)?.[1] || 0);
    if (!count || !first || count > 20000) continue;

    let decoded: Uint8Array | null = null;
    try {
      decoded = await decodePdfStream(source, dictionary);
    } catch {
      continue;
    }
    if (!decoded || decoded.length < first) continue;

    const text = new TextDecoder("latin1").decode(decoded);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let index = 0; index < count; index += 1) {
      const objectNumber = header[index * 2];
      const offset = header[index * 2 + 1];
      if (!Number.isFinite(objectNumber) || !Number.isFinite(offset)) continue;
      const nextOffset = index + 1 < count ? header[(index + 1) * 2 + 1] : NaN;
      const end = Number.isFinite(nextOffset) ? first + nextOffset : text.length;
      const body = text.slice(first + offset, Math.max(first + offset, end));
      if (!body) continue;
      budget -= body.length;
      if (budget <= 0) return parts.join("");
      parts.push(`\n${objectNumber} 0 obj\n${body}\nendobj\n`);
    }
  }
  return parts.join("");
}

function parseBox(dictionary: string, name: string, objects: Map<number, string>): number[] | null {
  const direct = dictionary.match(new RegExp(`/${name}\\s*\\[\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*\\]`));
  if (direct) return [Number(direct[1]), Number(direct[2]), Number(direct[3]), Number(direct[4])];
  const indirect = dictionary.match(new RegExp(`/${name}\\s+(\\d+)\\s+\\d+\\s+R\\b`));
  if (indirect) {
    const body = objects.get(Number(indirect[1]));
    if (body) {
      const resolved = body.match(new RegExp(`\\[\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*\\]`));
      if (resolved) return [Number(resolved[1]), Number(resolved[2]), Number(resolved[3]), Number(resolved[4])];
    }
  }
  return null;
}

function decodePdfString(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, char) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[char as string] || char))
    .replace(/\\(\d{1,3})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 8)))
    .trim();
}

function readString(dictionary: string, key: string) {
  const literal = dictionary.match(new RegExp(`/${key}\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)`));
  if (literal) return decodePdfString(literal[1]) || null;
  const hex = dictionary.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]+)>`));
  if (hex) {
    const digits = hex[1].replace(/\s+/g, "");
    let value = "";
    for (let index = 0; index + 1 < digits.length; index += 2) value += String.fromCharCode(Number.parseInt(digits.slice(index, index + 2), 16));
    return value.replace(/\0/g, "").trim() || null;
  }
  return null;
}

/** Cajas de página, rotación y factor de escala de cada página del documento. */
export function readPageGeometry(raw: string): PageBoxes[] {
  const objects = indirectObjects(raw);
  const inherited = { media: null as number[] | null, crop: null as number[] | null };
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Pages\b/.test(body)) continue;
    inherited.media = inherited.media || parseBox(body, "MediaBox", objects);
    inherited.crop = inherited.crop || parseBox(body, "CropBox", objects);
  }

  const pages: PageBoxes[] = [];
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page\b(?!s)/.test(body)) continue;
    const dictionary = body.split(/\bstream\r?\n/, 1)[0];
    pages.push({
      page: pages.length + 1,
      media: parseBox(dictionary, "MediaBox", objects) || inherited.media,
      crop: parseBox(dictionary, "CropBox", objects) || inherited.crop,
      trim: parseBox(dictionary, "TrimBox", objects),
      bleed: parseBox(dictionary, "BleedBox", objects),
      art: parseBox(dictionary, "ArtBox", objects),
      rotate: Number(dictionary.match(/\/Rotate\s+(-?\d+)/)?.[1] || 0),
      userUnit: Number(dictionary.match(new RegExp(`/UserUnit\\s+(${NUMBER})`))?.[1] || 1),
    });
    if (pages.length >= 400) break;
  }
  return pages;
}

/** Intenciones de salida declaradas en el catálogo (PDF/X, PDF/A, PDF/E). */
export function readOutputIntents(raw: string): OutputIntent[] {
  const objects = indirectObjects(raw);
  const intents: OutputIntent[] = [];
  const seen = new Set<string>();

  const push = (dictionary: string) => {
    if (!/\/OutputIntent\b|\/OutputConditionIdentifier\b|\/DestOutputProfile\b|\/S\s*\/GTS_/.test(dictionary)) return;
    const destProfileRef = Number(dictionary.match(/\/DestOutputProfile\s+(\d+)\s+\d+\s+R\b/)?.[1] || 0) || null;
    const intent: OutputIntent = {
      subtype: dictionary.match(/\/S\s*\/([A-Za-z0-9_]+)/)?.[1] || null,
      outputCondition: readString(dictionary, "OutputCondition"),
      outputConditionIdentifier: readString(dictionary, "OutputConditionIdentifier"),
      registryName: readString(dictionary, "RegistryName"),
      info: readString(dictionary, "Info"),
      destProfileRef,
      hasDestProfile: destProfileRef !== null || /\/DestOutputProfile\b/.test(dictionary),
    };
    const key = `${intent.subtype}|${intent.outputConditionIdentifier}|${intent.destProfileRef}`;
    if (seen.has(key)) return;
    seen.add(key);
    intents.push(intent);
  };

  for (const match of raw.matchAll(/\/OutputIntents\s*\[([\s\S]{0,4000}?)\]/g)) {
    const list = match[1];
    for (const reference of list.matchAll(/(\d+)\s+\d+\s+R\b/g)) {
      const body = objects.get(Number(reference[1]));
      if (body) push(body.split(/\bstream\r?\n/, 1)[0]);
    }
    for (const inline of list.matchAll(/<<([\s\S]{0,2000}?)>>/g)) push(inline[1]);
  }

  if (!intents.length) {
    for (const body of objects.values()) {
      if (/\/Type\s*\/OutputIntent\b/.test(body)) push(body.split(/\bstream\r?\n/, 1)[0]);
    }
  }
  return intents;
}

/** Versión y conformidad PDF/X declaradas por el exportador. */
export function readPdfXStamp(raw: string) {
  const version = raw.match(/\/GTS_PDFXVersion\s*\(([^)]*)\)/)?.[1]
    || raw.match(/pdfxid:GTS_PDFXVersion>\s*([^<]+)</)?.[1]
    || raw.match(/GTS_PDFXVersion="([^"]+)"/)?.[1]
    || null;
  const conformance = raw.match(/\/GTS_PDFXConformance\s*\(([^)]*)\)/)?.[1] || null;
  const pdfaPart = raw.match(/pdfaid:part>\s*(\d)</)?.[1] || raw.match(/pdfaid:part="(\d)"/)?.[1] || null;
  return {
    version: version ? version.trim() : null,
    conformance: conformance ? conformance.trim() : null,
    pdfaPart: pdfaPart ? Number(pdfaPart) : null,
  };
}

/** Tintas directas con el espacio alternativo al que caen si el RIP no las resuelve. */
export function readSpotInks(raw: string, contentText: string): SpotInk[] {
  const haystack = `${raw}\n${contentText}`;
  const objects = indirectObjects(raw);
  const inks = new Map<string, SpotInk>();

  const clean = (value: string) => decodeURIComponent(value.replace(/#([0-9A-Fa-f]{2})/g, "%$1")).trim();
  const SPACE_NAMES = /\/(Device(?:CMYK|RGB|Gray)|Lab|ICCBased|Separation|DeviceN|Indexed|CalRGB|CalGray)\b/;
  const alternateOf = (tail: string): string | null => {
    const direct = tail.match(SPACE_NAMES)?.[1];
    if (direct) return direct;
    // El espacio alternativo suele llegar como referencia indirecta (/Separation /Nombre 39 0 R ...).
    const reference = tail.match(/^\s*(\d+)\s+\d+\s+R\b/)?.[1];
    if (!reference) return null;
    const body = objects.get(Number(reference));
    if (!body) return null;
    const resolved = body.match(SPACE_NAMES)?.[1] || null;
    if (resolved !== "ICCBased") return resolved;
    const components = Number(body.match(/\/N\s+([134])\b/)?.[1] || 0);
    return components === 4 ? "DeviceCMYK" : components === 3 ? "DeviceRGB" : components === 1 ? "DeviceGray" : "ICCBased";
  };

  for (const match of haystack.matchAll(/\/Separation\s*\/([^\s/<>{}\[\]()]+)(?=([\s\S]{0,90}))/g)) {
    const name = clean(match[1]);
    if (!name || inks.has(name)) continue;
    inks.set(name, { name, alternate: alternateOf(match[2]), kind: "Separation", usedAsFill: false, usedAsStroke: false, usedInImage: false });
    if (inks.size >= 40) break;
  }

  for (const match of haystack.matchAll(/\/DeviceN\s*\[([^\]]{0,600})\](?=([\s\S]{0,90}))/g)) {
    const alternate = alternateOf(match[2]);
    for (const nameMatch of match[1].matchAll(/\/([^\s/<>{}\[\]()]+)/g)) {
      const name = clean(nameMatch[1]);
      if (!name || inks.has(name)) continue;
      inks.set(name, { name, alternate, kind: "DeviceN", usedAsFill: false, usedAsStroke: false, usedInImage: false });
    }
    if (inks.size >= 40) break;
  }

  // Qué alias de recurso corresponde a cada tinta directa.
  const aliasToInk = new Map<string, string>();
  for (const body of objects.values()) {
    for (const entry of body.matchAll(/\/([A-Za-z0-9_.#-]+)\s+(\[[\s\S]{0,600}?\]|\d+\s+\d+\s+R)/g)) {
      let definition = entry[2];
      const indirect = definition.match(/^(\d+)\s+\d+\s+R$/);
      if (indirect) definition = objects.get(Number(indirect[1])) || "";
      const spot = definition.match(/\/(?:Separation|DeviceN)\s*(?:\/([^\s/<>{}\[\]()]+)|\[\s*\/([^\s/<>{}\[\]()]+))/);
      if (!spot) continue;
      const name = clean(spot[1] || spot[2] || "");
      if (name && inks.has(name)) aliasToInk.set(clean(entry[1]), name);
    }
  }

  // Las imágenes ráster en una tinta directa no se remapean en PhotoPRINT.
  for (const body of objects.values()) {
    const dictionary = body.split(/\bstream\r?\n/, 1)[0];
    if (!/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const direct = dictionary.match(/\/ColorSpace\s*\[\s*\/(?:Separation|DeviceN)\s*(?:\/([^\s/<>{}\[\]()]+)|\[\s*\/([^\s/<>{}\[\]()]+))/);
    const alias = dictionary.match(/\/ColorSpace\s*\/([A-Za-z0-9_.#-]+)/)?.[1];
    const reference = dictionary.match(/\/ColorSpace\s+(\d+)\s+\d+\s+R\b/)?.[1];
    const resolved = reference ? objects.get(Number(reference)) : null;
    const viaRef = resolved?.match(/\/(?:Separation|DeviceN)\s*(?:\/([^\s/<>{}\[\]()]+)|\[\s*\/([^\s/<>{}\[\]()]+))/);
    const name = clean(direct?.[1] || direct?.[2] || viaRef?.[1] || viaRef?.[2] || "")
      || (alias ? aliasToInk.get(clean(alias)) || "" : "");
    const ink = inks.get(name);
    if (ink) ink.usedInImage = true;
  }

  // Relleno frente a trazo: los operadores en minúscula pintan relleno.
  let fillAlias: string | null = null;
  let strokeAlias: string | null = null;
  const tokens = contentText.match(/\/[A-Za-z0-9_.#-]+|[A-Za-z][A-Za-z0-9*]*/g) || [];
  let lastName: string | null = null;
  for (const token of tokens) {
    if (token.startsWith("/")) {
      lastName = clean(token.slice(1));
      continue;
    }
    if (token === "cs") fillAlias = lastName;
    else if (token === "CS") strokeAlias = lastName;
    else if (/^(?:f|F|f\*|b|b\*|B|B\*)$/.test(token)) {
      const ink = inks.get(aliasToInk.get(fillAlias || "") || "");
      if (ink) ink.usedAsFill = true;
      if (/^[bB]/.test(token)) {
        const stroked = inks.get(aliasToInk.get(strokeAlias || "") || "");
        if (stroked) stroked.usedAsStroke = true;
      }
    } else if (/^(?:S|s)$/.test(token)) {
      const ink = inks.get(aliasToInk.get(strokeAlias || "") || "");
      if (ink) ink.usedAsStroke = true;
    }
  }

  return Array.from(inks.values());
}

/** Funciones y recursos PDF que suelen romper o alterar el resultado en un RIP. */
export function scanRiskFeatures(raw: string, contentText: string): RiskFeatures {
  const haystack = `${raw}\n${contentText}`;
  const shadingTypes = Array.from(new Set(Array.from(haystack.matchAll(/\/ShadingType\s+([1-7])\b/g), (match) => Number(match[1])))).sort();
  const annotationSubtypes = Array.from(new Set(Array.from(raw.matchAll(/\/Type\s*\/Annot\b[\s\S]{0,400}?\/Subtype\s*\/([A-Za-z0-9]+)/g), (match) => match[1])));
  const printableAnnotations = Array.from(raw.matchAll(/\/Type\s*\/Annot\b[\s\S]{0,600}?\/F\s+(\d+)/g))
    .filter((match) => (Number(match[1]) & 4) === 4).length;

  return {
    shadingTypes,
    type3Fonts: Array.from(raw.matchAll(/\/Subtype\s*\/Type3\b/g)).length,
    printableAnnotations,
    annotationSubtypes,
    transferFunctions: /\/TR2?\s*(?:\/(?!Identity)[A-Za-z]|\d+\s+\d+\s+R|\[)/.test(haystack),
    halftones: /\/Type\s*\/Halftone\b|\/HT\s+\d+\s+\d+\s+R/.test(haystack),
    blackGeneration: /\/BG2?\s*(?:\d+\s+\d+\s+R|\/(?!Default)[A-Za-z])|\/UCR2?\s*(?:\d+\s+\d+\s+R|\/(?!Default)[A-Za-z])/.test(haystack),
    opi: /\/OPI\b/.test(raw),
    jbig2: /\/JBIG2Decode\b/.test(haystack),
    ccitt: /\/CCITTFaxDecode\b/.test(haystack),
    jpx: /\/JPXDecode\b/.test(haystack),
    interpolatedImages: /\/Interpolate\s+true\b/.test(haystack),
    tilingPatterns: Array.from(haystack.matchAll(/\/PatternType\s+1\b/g)).length,
    shadingPatterns: Array.from(haystack.matchAll(/\/PatternType\s+2\b/g)).length,
    softMasks: Array.from(haystack.matchAll(/\/SMask\s*(?:\d+\s+\d+\s+R|<<)/g)).length,
    knockoutGroups: Array.from(haystack.matchAll(/\/K\s+true\b/g)).length,
    isolatedGroups: Array.from(haystack.matchAll(/\/I\s+true\b/g)).length,
    embeddedFiles: Array.from(raw.matchAll(/\/Type\s*\/Filespec\b|\/EmbeddedFile\b/g)).length,
    registrationColor: /\/Separation\s*\/All\b/.test(haystack),
    indexedImages: Array.from(haystack.matchAll(/\/Indexed\b/g)).length,
    hasXmp: /\/Type\s*\/Metadata\b|<x:xmpmeta/.test(raw),
    optionalContentInXObjects: Array.from(raw.matchAll(/\/OC\s+\d+\s+\d+\s+R/g)).length,
  };
}

/** Espacios de color declarados por las imágenes ráster colocadas. */
export function readImageColorSpaces(raw: string): string[] {
  const objects = indirectObjects(raw);
  const spaces = new Map<string, number>();
  const label = (value: string) => ({
    DeviceRGB: "RGB",
    DeviceCMYK: "CMYK",
    DeviceGray: "Grises",
    CalRGB: "RGB calibrado",
    CalGray: "Grises calibrados",
    Indexed: "Indexado",
    Lab: "Lab",
    ICCBased: "ICC",
    Separation: "Tinta directa",
    DeviceN: "Multicanal",
  }[value] || value);

  for (const body of objects.values()) {
    const dictionary = body.split(/\bstream\r?\n/, 1)[0];
    if (!/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    if (/\/ImageMask\s+true\b/.test(dictionary)) continue;
    let definition = dictionary.match(/\/ColorSpace\s*(\/[A-Za-z]+|\[[^\]]{0,200}\])/)?.[1] || null;
    if (!definition) {
      const reference = dictionary.match(/\/ColorSpace\s+(\d+)\s+\d+\s+R\b/)?.[1];
      definition = reference ? objects.get(Number(reference)) || null : null;
    }
    if (!definition) continue;

    let space = definition.match(/\/([A-Za-z]+)/)?.[1] || null;
    // Una imagen indexada guarda su paleta en otro espacio: lo que importa
    // para el color es ese espacio base, no el hecho de estar indexada.
    if (space === "Indexed") {
      const base = definition.match(/\/Indexed\s*\/?([A-Za-z]+)/)?.[1];
      const baseReference = definition.match(/\/Indexed\s+(\d+)\s+\d+\s+R\b/)?.[1];
      const resolvedBase = baseReference ? objects.get(Number(baseReference)) : null;
      const baseSpace = base && base !== "Indexed" ? base : resolvedBase?.match(/\/([A-Za-z]+)/)?.[1] || null;
      if (baseSpace) space = baseSpace;
    }
    if (space === "ICCBased") {
      const reference = definition.match(/\/ICCBased\s+(\d+)\s+\d+\s+R\b/)?.[1];
      const resolved = reference ? objects.get(Number(reference)) : null;
      const components = Number(resolved?.match(/\/N\s+([134])\b/)?.[1] || 0);
      space = components === 4 ? "DeviceCMYK" : components === 3 ? "DeviceRGB" : components === 1 ? "DeviceGray" : "ICCBased";
    }
    if (!space) continue;
    spaces.set(label(space), (spaces.get(label(space)) || 0) + 1);
  }
  return Array.from(spaces.keys());
}

/**
 * Localiza cada perfil ICC incrustado, lo decodifica por completo y determina
 * el rol que cumple dentro del PDF. Es la base de todo el control de color.
 */
export async function collectIccUsages(bytes: Uint8Array, raw: string, structuralRaw: string = raw): Promise<IccUsage[]> {
  const destProfileRefs = new Set(Array.from(structuralRaw.matchAll(/\/DestOutputProfile\s+(\d+)\s+\d+\s+R\b/g), (match) => Number(match[1])));
  const colorSpaceRefs = new Set(Array.from(structuralRaw.matchAll(/\/ICCBased\s+(\d+)\s+\d+\s+R\b/g), (match) => Number(match[1])));
  const defaultRefs = new Set<number>();
  for (const match of structuralRaw.matchAll(/\/Default(?:RGB|CMYK|Gray)\s*(?:\[\s*\/ICCBased\s+(\d+)|(\d+))\s+\d+\s+R\b/g)) {
    defaultRefs.add(Number(match[1] || match[2]));
  }

  const usages: IccUsage[] = [];
  for (const { dictionary, source, objectNumber } of rawPdfStreams(bytes, raw)) {
    // /N también significa "cantidad de objetos" en un /ObjStm y "número de
    // páginas" en otros diccionarios, así que nunca alcanza por sí solo.
    if (/\/Type\s*\/(?:ObjStm|XRef|Metadata|Font|Page)\b|\/Subtype\s*\/(?:Image|Form|Type1C|CIDFontType0C|OpenType|XML)\b|\/FontFile\d?\b/.test(dictionary)) continue;
    const referenced = objectNumber !== null && (destProfileRefs.has(objectNumber) || colorSpaceRefs.has(objectNumber) || defaultRefs.has(objectNumber));
    const hinted = /\/Alternate\s*\/Device(?:Gray|RGB|CMYK)\b/.test(dictionary);
    if (!referenced && !hinted && !/\/N\s+[134]\b/.test(dictionary)) continue;

    const declaredComponents = Number(dictionary.match(/\/N\s+([134])\b/)?.[1] || 0) || null;
    const alternate = dictionary.match(/\/Alternate\s*\/([A-Za-z]+)/)?.[1] || null;
    const role: IccRole = objectNumber !== null && destProfileRefs.has(objectNumber)
      ? "output-intent"
      : objectNumber !== null && defaultRefs.has(objectNumber)
        ? "default"
        : objectNumber !== null && colorSpaceRefs.has(objectNumber)
          ? "colorspace"
          : /\/Subtype\s*\/Image\b/.test(dictionary)
            ? "image"
            : "desconocido";

    let profile: IccProfile | null = null;
    let broken = false;
    try {
      const decoded = await decodePdfStream(source, dictionary);
      profile = decoded ? parseIccProfile(decoded) : null;
      broken = !profile;
    } catch {
      broken = true;
    }
    // Sin perfil legible y sin nada que lo señale como ICC, es otro recurso.
    if (broken && !referenced && !hinted) continue;

    const mismatches: string[] = [];
    if (profile) {
      if (declaredComponents && profile.channels && declaredComponents !== profile.channels) {
        mismatches.push(`El PDF declara ${declaredComponents} canales y el perfil es ${profile.dataColorSpaceLabel} de ${profile.channels}.`);
      }
      const expectedAlternate = profile.channels === 4 ? "DeviceCMYK" : profile.channels === 3 ? "DeviceRGB" : profile.channels === 1 ? "DeviceGray" : null;
      if (alternate && expectedAlternate && alternate !== expectedAlternate) {
        mismatches.push(`El espacio alternativo declarado es /${alternate} pero el perfil es ${profile.dataColorSpaceLabel}.`);
      }
      if (role === "output-intent" && profile.deviceClass !== "prtr") {
        mismatches.push(`La intención de salida usa un perfil de clase “${profile.deviceClassLabel}” en lugar de un perfil de impresora.`);
      }
      for (const defect of profile.defects) mismatches.push(defect);
    }

    usages.push({ objectNumber, role, declaredComponents, alternate, profile, broken, mismatches });
    if (usages.length >= 60) break;
  }
  return usages;
}
