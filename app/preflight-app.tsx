"use client";

import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { decodedContentStreams, embeddedIccProfiles, extractSourceColorOccurrences, extractSourceColors, inspectPdfStructure, resolveOriginalColorOccurrence, type LayerState, type PdfColorOccurrence, type PdfSourceColor } from "./pdf-structure";
import { collectIccUsages, expandObjectStreams, readImageColorSpaces, readOutputIntents, readPageGeometry, readPdfXStamp, readSpotInks, scanRiskFeatures, type IccUsage, type OutputIntent, type PageBoxes, type RiskFeatures, type SpotInk } from "./pdf-deep";
import { fileFacts, iccVerdict, type Fact, type IccVerdict } from "./preflight-rules";
import { buildFindings, type Finding } from "./findings";

type Status = "ready" | "caution" | "blocked";
type Matrix = [number, number, number, number, number, number];
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type Metadata = { title: string; author: string; creator: string; producer: string; created: string };
type PdfPaintRegion = {
  id: string;
  colorId: string | null;
  kind: "vector" | "text" | "raster";
  d: string;
  paint: "fill" | "stroke";
  fillRule: "nonzero" | "evenodd";
  strokeWidth: number;
  order: number;
  /** Opacidad aplicada al pintar el objeto (1 = opaco). */
  alpha: number;
  /** Modo de fusión distinto de Normal, si lo hay. */
  blend: string | null;
  /** El objeto se pinta a través de una máscara suave (sombras, degradados). */
  softMask: boolean;
  /** Caja del objeto en coordenadas de página normalizadas (0 a 1). */
  bbox: Rect;
  /** PPI efectivos, solo para imágenes ráster. */
  ppi: number | null;
};

/** Zona de la página, en fracciones de 0 a 1 desde la esquina superior izquierda. */
type Rect = { x: number; y: number; w: number; h: number };

type Analysis = {
  id: string;
  fileName: string;
  fileSize: number;
  status: Status;
  format: string;
  pdfVersion: string | null;
  pages: number | null;
  pagesAnalyzed: number;
  dimensions: string[];
  findings: Finding[];
  facts: Fact[];
  colorSpaces: string[];
  dominantColors: string[];
  sourceColors: PdfSourceColor[];
  paintRegions: PdfPaintRegion[];
  spotColors: string[];
  profileName: string;
  fontNames: string[];
  imageCount: number;
  ppiMin: number | null;
  ppiMax: number | null;
  ppiPlacements: number;
  hasText: boolean;
  textCharacters: number;
  textPreview: string;
  metadata: Metadata;
  layerCount: number;
  layerState: LayerState;
  missingFontResources: string[];
  formXObjectCount: number;
  iccProfileCount: number;
  iccVerdict: IccVerdict;
  iccProfiles: IccProfileSummary[];
  outputIntents: OutputIntent[];
  pdfxVersion: string | null;
  spotInks: SpotInk[];
  imageColorSpaces: string[];
  mirrored: { mirrored: number; upright: number };
  pageGeometry: PageBoxes[];
  riskFeatures: RiskFeatures | null;
  thumbnail: string | null;
  visualHash: string | null;
  fileHash: string;
  analyzedAt: string;
};

type IccProfileSummary = {
  role: string;
  name: string;
  space: string;
  version: string;
  deviceClass: string;
  renderingIntent: string;
  created: string | null;
  sizeBytes: number;
  known: string | null;
  note: string | null;
  issues: string[];
};

type BatchItem = { file: File; analysis: Analysis };

const PROFILES = {
  ideal: { name: "Calidad ideal", dpi: 300, note: "Recomendado para sublimación con detalle y lectura cercana." },
  standard: { name: "Producción estándar", dpi: 200, note: "Aceptable cuando el original no alcanza 300 ppp efectivos." },
  grand: { name: "Gran formato", dpi: 150, note: "Solo para piezas grandes observadas a mayor distancia." },
} as const;

type ProfileKey = keyof typeof PROFILES;

const ICC_ROLE_LABELS: Record<IccUsage["role"], string> = {
  "output-intent": "Intención de salida",
  colorspace: "Espacio de trabajo",
  image: "Imagen",
  default: "Espacio por defecto",
  desconocido: "Sin rol declarado",
};

function summarizeIccUsages(usages: IccUsage[]): IccProfileSummary[] {
  return usages.map((usage) => ({
    role: ICC_ROLE_LABELS[usage.role],
    name: usage.profile?.description || usage.profile?.known?.name || (usage.broken ? "Perfil ilegible" : "Perfil sin nombre"),
    space: usage.profile?.dataColorSpaceLabel || (usage.declaredComponents ? `${usage.declaredComponents} canales` : "—"),
    version: usage.profile ? `v${usage.profile.versionLabel}` : "—",
    deviceClass: usage.profile?.deviceClassLabel || "—",
    renderingIntent: usage.profile?.renderingIntentLabel || "—",
    created: usage.profile?.created || null,
    sizeBytes: usage.profile?.byteLength || 0,
    known: usage.profile?.known?.name || null,
    note: usage.profile?.known?.note || null,
    issues: usage.broken ? ["El flujo no contiene un perfil ICC legible."] : usage.mismatches,
  }));
}
const MAX_FILES = 12;
/** Tope para dibujar la vista previa de una página antes de seguir sin ella. */
const PREVIEW_TIMEOUT_MS = 15000;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const mm = (points: number) => (points * 25.4) / 72;
const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(0)} KB`
  : bytes < 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

const cleanPdfName = (value: string) => decodeURIComponent(value.replace(/#/g, "%")).replace(/^[A-Z]{6}\+/, "").replace(/[_-]+/g, " ").trim();

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function rawPdfText(bytes: Uint8Array) {
  const decoder = new TextDecoder("latin1");
  if (bytes.byteLength <= 80 * 1024 * 1024) return decoder.decode(bytes);
  const head = bytes.slice(0, 48 * 1024 * 1024);
  const tail = bytes.slice(Math.max(0, bytes.byteLength - 12 * 1024 * 1024));
  return `${decoder.decode(head)}\n${decoder.decode(tail)}`;
}

function validateCrossReference(bytes: Uint8Array) {
  const decoder = new TextDecoder("latin1");
  const tailStart = Math.max(0, bytes.byteLength - 128 * 1024);
  const tail = decoder.decode(bytes.slice(tailStart));
  const eofIndex = tail.lastIndexOf("%%EOF");
  const startMatches = Array.from(tail.matchAll(/startxref\s+(\d+)/g));
  const offset = startMatches.length ? Number(startMatches[startMatches.length - 1][1]) : -1;
  let xrefValid = false;
  if (offset >= 0 && offset < bytes.byteLength) {
    const target = decoder.decode(bytes.slice(offset, Math.min(bytes.byteLength, offset + 1200)));
    xrefValid = /^\s*xref\b/.test(target) || /^\s*\d+\s+\d+\s+obj\b[\s\S]*?\/Type\s*\/XRef\b/.test(target);
  }
  const trailingBytes = eofIndex >= 0 ? tail.length - (eofIndex + 5) : Number.POSITIVE_INFINITY;
  return { hasEof: eofIndex >= 0, hasStartXref: offset >= 0, xrefValid, trailingBytes };
}

function uniqueMatches(text: string, pattern: RegExp, limit = 24) {
  const values = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = cleanPdfName(match[1] || "");
    if (value) values.add(value);
    if (values.size >= limit) break;
  }
  return Array.from(values);
}

function detectProfile(text: string, embeddedProfiles: string[] = []) {
  if (embeddedProfiles.length) return embeddedProfiles.slice(0, 3).join(" · ");
  const outputId = text.match(/\/OutputConditionIdentifier\s*\(([^)]+)\)/)?.[1];
  if (outputId) return outputId.trim();
  const common = text.match(/sRGB IEC61966-2\.1|Adobe RGB \(1998\)|Display P3|U\.S\. Web Coated \(SWOP\) v2|ISO Coated v2(?: 300%)?|Coated FOGRA\d+|FOGRA\d+|GRACoL[^()<>{}\r\n]*/i)?.[0];
  if (common) return common.trim();
  if (/\/DestOutputProfile\b|\/ICCBased\b/.test(text)) return "ICC incorporado · nombre no legible";
  return "No declarado";
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function getImagePpi(operatorList: { fnArray: number[]; argsArray: unknown[][] }, OPS: PdfJs["OPS"]) {
  let ctm: Matrix = [...IDENTITY];
  const stack: Matrix[] = [];
  const values: number[] = [];
  let imageCount = 0;
  let mirrored = 0;
  let upright = 0;

  const addImage = (width: number, height: number, stencil = false) => {
    imageCount += 1;
    const placedWidth = Math.hypot(ctm[0], ctm[1]);
    const placedHeight = Math.hypot(ctm[2], ctm[3]);
    const determinant = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    // Las máscaras de recorte se dibujan con matrices invertidas por diseño;
    // solo una imagen real colocada del revés indica un arte espejado.
    if (!stencil && placedWidth > 2 && placedHeight > 2) {
      if (determinant < 0) mirrored += 1;
      else if (determinant > 0) upright += 1;
    }
    if (width > 0 && height > 0 && placedWidth > 0.05 && placedHeight > 0.05) {
      const x = width / (placedWidth / 72);
      const y = height / (placedHeight / 72);
      if (Number.isFinite(x) && Number.isFinite(y) && x < 100000 && y < 100000) values.push(Math.min(x, y));
    }
  };

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index] || [];
    if (fn === OPS.save) stack.push([...ctm]);
    else if (fn === OPS.restore) ctm = stack.pop() || [...IDENTITY];
    else if (fn === OPS.transform && args.length >= 6) ctm = multiply(ctm, (args.slice(0, 6) as number[]) as Matrix);
    else if (fn === OPS.paintFormXObjectBegin && Array.isArray(args[0]) && args[0].length >= 6) {
      stack.push([...ctm]);
      ctm = multiply(ctm, (args[0] as number[]).slice(0, 6) as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject) addImage(Number(args[1]) || 0, Number(args[2]) || 0);
    else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const image = args[0] as { width?: number; height?: number } | undefined;
      addImage(Number(image?.width) || 0, Number(image?.height) || 0, fn === OPS.paintImageMaskXObject);
    }
  });

  return { values, imageCount, mirrored, upright };
}

/** Detecta un rectángulo de fondo que cubra prácticamente toda la página. */

function paintRegions(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  OPS: PdfJs["OPS"],
  viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): [number, number] },
  colorOccurrences: PdfColorOccurrence[],
) {
  type PaintState = { ctm: Matrix; fillColorId: string | null; strokeColorId: string | null; lineWidth: number; textMatrix: Matrix; fontSize: number; fillAlpha: number; strokeAlpha: number; blend: string | null; softMask: boolean };
  let state: PaintState = { ctm: [...IDENTITY], fillColorId: null, strokeColorId: null, lineWidth: 1, textMatrix: [...IDENTITY], fontSize: 12, fillAlpha: 1, strokeAlpha: 1, blend: null, softMask: false };
  const stack: PaintState[] = [];
  const regions: PdfPaintRegion[] = [];
  const occurrenceQueues = {
    fill: colorOccurrences.filter((color) => color.target === "fill"),
    stroke: colorOccurrences.filter((color) => color.target === "stroke"),
  };
  const occurrenceCursor = { fill: 0, stroke: 0 };

  const colorIdFromArgs = (args: unknown[], target: PdfColorOccurrence["target"]) => {
    const hex = typeof args[0] === "string" && /^#[0-9a-f]{6}$/i.test(args[0]) ? args[0] : null;
    const queue = occurrenceQueues[target];
    const resolved = resolveOriginalColorOccurrence(queue, occurrenceCursor[target], hex);
    if (resolved.color) {
      occurrenceCursor[target] = resolved.nextCursor;
      return resolved.color.id;
    }
    return null;
  };
  const matrixFrom = (value: unknown): Matrix | null => {
    const matrix = value as ArrayLike<number> | null;
    if (!matrix || typeof matrix.length !== "number" || matrix.length < 6) return null;
    const numbers = Array.from({ length: 6 }, (_, index) => Number(matrix[index])) as Matrix;
    return numbers.every(Number.isFinite) ? numbers : null;
  };
  // Caja del objeto que se está construyendo, para poder señalarlo después
  // sobre la vista previa. Se lleva como cuatro números y no como lista de
  // puntos: los trazados de recorte nunca se pintan y acumularlos colgaba el
  // navegador en archivos con miles de contornos.
  let minX = 1, minY = 1, maxX = 0, maxY = 0, tracked = false;
  const resetBounds = () => { minX = 1; minY = 1; maxX = 0; maxY = 0; tracked = false; };
  const transform = (x: number, y: number, matrix: Matrix) => {
    const transformedX = matrix[0] * x + matrix[2] * y + matrix[4];
    const transformedY = matrix[1] * x + matrix[3] * y + matrix[5];
    const point = viewport.convertToViewportPoint(transformedX, transformedY);
    return [point[0] / viewport.width, point[1] / viewport.height] as const;
  };
  const project = (x: number, y: number, matrix: Matrix = state.ctm) => {
    const normalized = transform(x, y, matrix);
    if (normalized[0] < minX) minX = normalized[0];
    if (normalized[1] < minY) minY = normalized[1];
    if (normalized[0] > maxX) maxX = normalized[0];
    if (normalized[1] > maxY) maxY = normalized[1];
    tracked = true;
    return normalized;
  };
  const takeBounds = (): Rect => {
    if (!tracked) return { x: 0, y: 0, w: 0, h: 0 };
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const box = { x: clamp(minX), y: clamp(minY), w: clamp(maxX) - clamp(minX), h: clamp(maxY) - clamp(minY) };
    resetBounds();
    return box;
  };
  const format = (number: number) => Number(number.toFixed(6));
  const pathFromEncoded = (encoded: ArrayLike<number>) => {
    let index = 0;
    const commands: string[] = [];
    while (index < encoded.length) {
      const operation = Number(encoded[index++]);
      if (operation === 0 || operation === 1) {
        const point = project(Number(encoded[index++]), Number(encoded[index++]));
        commands.push(`${operation === 0 ? "M" : "L"}${format(point[0])} ${format(point[1])}`);
      } else if (operation === 2) {
        const first = project(Number(encoded[index++]), Number(encoded[index++]));
        const second = project(Number(encoded[index++]), Number(encoded[index++]));
        const end = project(Number(encoded[index++]), Number(encoded[index++]));
        commands.push(`C${format(first[0])} ${format(first[1])} ${format(second[0])} ${format(second[1])} ${format(end[0])} ${format(end[1])}`);
      } else if (operation === 3) commands.push("Z");
      else break;
    }
    return commands.join(" ");
  };
  const polygon = (points: Array<[number, number]>, matrix: Matrix = state.ctm) => points.map(([x, y], index) => {
    const point = project(x, y, matrix);
    return `${index ? "L" : "M"}${format(point[0])} ${format(point[1])}`;
  }).join(" ") + " Z";
  const normalizedLineWidth = () => {
    const origin = transform(0, 0, state.ctm);
    const horizontal = transform(state.lineWidth, 0, state.ctm);
    const vertical = transform(0, state.lineWidth, state.ctm);
    return Math.max(Math.hypot(horizontal[0] - origin[0], horizontal[1] - origin[1]), Math.hypot(vertical[0] - origin[0], vertical[1] - origin[1]), 0.0015);
  };
  const addRegion = (d: string, colorId: string | null, kind: PdfPaintRegion["kind"], paint: PdfPaintRegion["paint"], fillRule: PdfPaintRegion["fillRule"] = "nonzero", ppi: number | null = null) => {
    const bbox = takeBounds();
    if (!d || regions.length >= 10000) return;
    const strokeWidth = paint === "stroke" ? normalizedLineWidth() : 0;
    regions.push({
      id: `${kind}-${regions.length}`,
      colorId, kind, d, paint, fillRule, strokeWidth, order: regions.length,
      alpha: paint === "stroke" ? state.strokeAlpha : state.fillAlpha,
      blend: state.blend,
      softMask: state.softMask,
      bbox,
      ppi,
    });
  };

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index] || [];
    if (fn === OPS.save) stack.push({ ...state, ctm: [...state.ctm], textMatrix: [...state.textMatrix] });
    else if (fn === OPS.restore) state = stack.pop() || state;
    else if (fn === OPS.transform && args.length >= 6) state.ctm = multiply(state.ctm, args.slice(0, 6).map(Number) as Matrix);
    else if (fn === OPS.paintFormXObjectBegin && matrixFrom(args[0])) {
      stack.push({ ...state, ctm: [...state.ctm], textMatrix: [...state.textMatrix] });
      state.ctm = multiply(state.ctm, matrixFrom(args[0])!);
    } else if (fn === OPS.paintFormXObjectEnd) state = stack.pop() || state;
    else if (fn === OPS.setLineWidth) state.lineWidth = Math.max(0, Number(args[0]) || 0);
    else if (fn === OPS.setGState && Array.isArray(args[0])) {
      // El estado gráfico trae la opacidad, el modo de fusión y la máscara
      // suave: es de donde salen las transparencias y las sombras.
      for (const entry of args[0] as Array<[string, unknown]>) {
        if (!Array.isArray(entry)) continue;
        const [key, value] = entry;
        if (key === "ca") state.fillAlpha = Number.isFinite(Number(value)) ? Number(value) : state.fillAlpha;
        else if (key === "CA") state.strokeAlpha = Number.isFinite(Number(value)) ? Number(value) : state.strokeAlpha;
        else if (key === "BM") {
          // PDF.js entrega el modo ya traducido al nombre que usa el lienzo:
          // "source-over" es el modo Normal. Compararlo contra "Normal"
          // marcaba como fusión a todos los objetos del documento.
          const source = Array.isArray(value) ? value[0] : value;
          const mode = typeof source === "string"
            ? source
            : source && typeof source === "object" && "name" in source
              ? String((source as { name: unknown }).name)
              : "";
          state.blend = mode && !/^(?:normal|source-over|compatible)$/i.test(mode) ? mode : null;
        } else if (key === "SMask") {
          const source = Array.isArray(value) ? value[0] : value;
          state.softMask = !!source && String(source).toLowerCase() !== "none";
        }
        else if (key === "LW") state.lineWidth = Math.max(0, Number(value) || 0);
      }
    }
    else if (fn === OPS.setFillRGBColor || fn === OPS.setFillCMYKColor || fn === OPS.setFillGray || fn === OPS.setFillColor || fn === OPS.setFillColorN) state.fillColorId = colorIdFromArgs(args, "fill");
    else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeCMYKColor || fn === OPS.setStrokeGray || fn === OPS.setStrokeColor || fn === OPS.setStrokeColorN) state.strokeColorId = colorIdFromArgs(args, "stroke");
    else if (fn === OPS.setFillTransparent) state.fillColorId = null;
    else if (fn === OPS.setStrokeTransparent) state.strokeColorId = null;
    else if (fn === OPS.beginText) state.textMatrix = [...IDENTITY];
    else if (fn === OPS.setTextMatrix) state.textMatrix = matrixFrom(args[0]) || (args.length >= 6 ? args.slice(0, 6).map(Number) as Matrix : state.textMatrix);
    else if (fn === OPS.setFont) state.fontSize = Math.abs(Number(args[1]) || state.fontSize);
    else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
      state.textMatrix[4] += Number(args[0]) || 0;
      state.textMatrix[5] += Number(args[1]) || 0;
    }
    else if (fn === OPS.constructPath) {
      resetBounds();
      const paint = Number(args[0]);
      const data = args[1] as ArrayLike<ArrayLike<number>> | undefined;
      const d = data?.[0] ? pathFromEncoded(data[0]) : "";
      const evenOdd = [OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke].includes(paint);
      if ([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint)) addRegion(d, state.fillColorId, "vector", "fill", evenOdd ? "evenodd" : "nonzero");
      if ([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint)) addRegion(d, state.strokeColorId, "vector", "stroke");
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask) {
      const inline = args[0] as { width?: number; height?: number } | undefined;
      const pixelWidth = fn === OPS.paintImageXObject ? Number(args[1]) || 0 : Number(inline?.width) || 0;
      const pixelHeight = fn === OPS.paintImageXObject ? Number(args[2]) || 0 : Number(inline?.height) || 0;
      const placedWidth = Math.hypot(state.ctm[0], state.ctm[1]);
      const placedHeight = Math.hypot(state.ctm[2], state.ctm[3]);
      let ppi: number | null = null;
      if (pixelWidth > 0 && pixelHeight > 0 && placedWidth > 0.05 && placedHeight > 0.05) {
        const horizontal = pixelWidth / (placedWidth / 72);
        const vertical = pixelHeight / (placedHeight / 72);
        if (Number.isFinite(horizontal) && Number.isFinite(vertical) && horizontal < 100000 && vertical < 100000) {
          ppi = Math.round(Math.min(horizontal, vertical));
        }
      }
      addRegion(polygon([[0, 0], [1, 0], [1, 1], [0, 1]]), null, "raster", "fill", "nonzero", ppi);
    } else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      const glyphs = Array.isArray(args[0]) ? args[0] : [];
      let advance = 0;
      for (const glyph of glyphs) {
        if (typeof glyph === "number") advance += (-glyph / 1000) * state.fontSize;
        else if (glyph && typeof glyph === "object" && "width" in glyph) advance += (Number((glyph as { width: number }).width) / 1000) * state.fontSize;
      }
      const textTransform = multiply(state.ctm, state.textMatrix);
      const d = polygon([[0, -state.fontSize * 0.25], [advance, -state.fontSize * 0.25], [advance, state.fontSize * 0.85], [0, state.fontSize * 0.85]], textTransform);
      addRegion(d, state.fillColorId, "text", "fill");
      state.textMatrix[4] += state.textMatrix[0] * advance;
      state.textMatrix[5] += state.textMatrix[1] * advance;
    }
  });
  return regions;
}

function dominantColors(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map<string, number>();
  const stride = Math.max(4, Math.floor((canvas.width * canvas.height) / 45000)) * 4;
  for (let index = 0; index < data.length; index += stride) {
    if (data[index + 3] < 180) continue;
    const r = Math.min(255, Math.round(data[index] / 32) * 32);
    const g = Math.min(255, Math.round(data[index + 1] / 32) * 32);
    const b = Math.min(255, Math.round(data[index + 2] / 32) * 32);
    if (r > 238 && g > 238 && b > 238) continue;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    buckets.set(hex, (buckets.get(hex) || 0) + 1);
  }
  return Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex]) => hex);
}

function differenceHash(canvas: HTMLCanvasElement) {
  const sample = document.createElement("canvas");
  sample.width = 9;
  sample.height = 8;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(canvas, 0, 0, 9, 8);
  const data = context.getImageData(0, 0, 9, 8).data;
  let hash = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (data[(y * 9 + x) * 4] + data[(y * 9 + x) * 4 + 1] + data[(y * 9 + x) * 4 + 2]) / 3;
      const right = (data[(y * 9 + x + 1) * 4] + data[(y * 9 + x + 1) * 4 + 1] + data[(y * 9 + x + 1) * 4 + 2]) / 3;
      hash += left > right ? "1" : "0";
    }
  }
  return hash;
}

async function renderFirstPage(page: Awaited<ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>>) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1.25, 520 / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const empty = { thumbnail: null, visualHash: null, colors: [] as string[] };
  if (!context) return empty;

  const task = page.render({ canvas, canvasContext: context, viewport });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drawn = await Promise.race([
    task.promise.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PREVIEW_TIMEOUT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!drawn) {
    try { task.cancel(); } catch { /* la tarea ya estaba terminada */ }
    return empty;
  }
  return { thumbnail: canvas.toDataURL("image/jpeg", 0.82), visualHash: differenceHash(canvas), colors: dominantColors(canvas) };
}

function emptyAnalysis(file: File, fileHash: string, blocker: { id: string; title: string; detail: string }): Analysis {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    status: "blocked",
    format: file.name.toLowerCase().endsWith(".ai") ? "Illustrator nativo" : "No reconocido",
    pdfVersion: null,
    pages: null,
    pagesAnalyzed: 0,
    dimensions: [],
    findings: [{ ...blocker, severity: "error", badge: "No se puede usar", rects: [], count: 1 }],
    facts: [],
    colorSpaces: [],
    dominantColors: [],
    sourceColors: [],
    paintRegions: [],
    spotColors: [],
    profileName: "No detectable",
    fontNames: [],
    imageCount: 0,
    ppiMin: null,
    ppiMax: null,
    ppiPlacements: 0,
    hasText: false,
    textCharacters: 0,
    textPreview: "",
    metadata: { title: "", author: "", creator: "", producer: "", created: "" },
    layerCount: 0,
    layerState: "unknown",
    missingFontResources: [],
    formXObjectCount: 0,
    iccProfileCount: 0,
    iccVerdict: { state: "sin-icc", label: "Sin análisis", summary: "El archivo no pudo abrirse, así que no se leyó el color." },
    iccProfiles: [],
    outputIntents: [],
    pdfxVersion: null,
    spotInks: [],
    imageColorSpaces: [],
    mirrored: { mirrored: 0, upright: 0 },
    pageGeometry: [],
    riskFeatures: null,
    thumbnail: null,
    visualHash: null,
    fileHash,
    analyzedAt: new Date().toISOString(),
  };
}

async function analyzeFile(file: File, targetPpi: number): Promise<Analysis> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileHash = await sha256(bytes);
  const raw = rawPdfText(bytes);
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const isPdf = /^%PDF-/.test(raw.slice(0, 16));

  if (!isPdf) return emptyAnalysis(file, fileHash, {
    id: "no-es-pdf",
    title: extension === "ai" ? "El AI no trae versión PDF adentro" : "El archivo no es un PDF",
    detail: extension === "ai"
      ? "Volvé a guardar el AI con la opción “Crear archivo compatible con PDF” tildada. Sin eso, adentro no hay nada que el RIP pueda leer."
      : "El contenido no arranca como un PDF. Puede estar cortado, mal descargado o ser otro formato con el nombre cambiado.",
  });

  if (/\/Encrypt\b/.test(raw)) return emptyAnalysis(file, fileHash, {
    id: "protegido",
    title: "El archivo tiene contraseña",
    detail: "Está protegido y no se puede leer el contenido. Pedí el archivo sin contraseña.",
  });
  const contentText = await decodedContentStreams(bytes, raw);
  // Los PDF 1.5+ guardan casi todos los diccionarios comprimidos en /ObjStm.
  const expandedObjects = await expandObjectStreams(bytes, raw);
  const structuralRaw = expandedObjects ? `${raw}${expandedObjects}` : raw;
  const inspectionText = `${structuralRaw}\n${contentText}`;
  const crossReference = validateCrossReference(bytes);
  const pdfStructure = inspectPdfStructure(structuralRaw, contentText);
  const colorOccurrences = extractSourceColorOccurrences(structuralRaw, contentText);
  const sourceColors = extractSourceColors(structuralRaw, contentText, 64);
  const embeddedProfiles = await embeddedIccProfiles(bytes, raw);
  const iccUsages = await collectIccUsages(bytes, raw, structuralRaw);
  const outputIntents = readOutputIntents(structuralRaw);
  const pdfx = readPdfXStamp(structuralRaw);
  const pageGeometry = readPageGeometry(structuralRaw);
  const spotInks = readSpotInks(structuralRaw, contentText);
  const riskFeatures = scanRiskFeatures(structuralRaw, contentText);
  const imageColorSpaces = readImageColorSpaces(structuralRaw);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch {
    return emptyAnalysis(file, fileHash, {
      id: "ilegible",
      title: "El archivo no se puede abrir",
      detail: "Está dañado o usa algo que no se puede leer. Pedí que lo vuelvan a exportar.",
    });
  }

  const version = raw.slice(0, 32).match(/%PDF-(\d\.\d)/)?.[1] || null;
  const totalPages = pdf.numPages;
  const maxPages = Math.min(totalPages, 100);
  const dimensions = new Set<string>();
  const ppiValues: number[] = [];
  const fontNames = new Set<string>();
  let imageCount = 0;
  let textCharacters = 0;
  let collectedText = "";
  let thumbnail: string | null = null;
  let visualHash: string | null = null;
  let detectedColors: string[] = [];
  let firstPagePaintRegions: PdfPaintRegion[] = [];
  let mirroredPlacements = 0;
  let uprightPlacements = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    dimensions.add(`${mm(viewport.width).toFixed(1)} × ${mm(viewport.height).toFixed(1)} mm`);
    const text = await page.getTextContent();
    for (const item of text.items) {
      if (!("str" in item)) continue;
      const value = item.str.trim();
      textCharacters += value.length;
      if (collectedText.length < 600 && value) collectedText += `${value} `;
      if ("fontName" in item && item.fontName) {
        const style = text.styles[item.fontName];
        fontNames.add(style?.fontFamily || item.fontName);
      }
    }
    const operators = await page.getOperatorList();
    const imageResult = getImagePpi(operators, pdfjs.OPS);
    imageCount += imageResult.imageCount;
    ppiValues.push(...imageResult.values);
    mirroredPlacements += imageResult.mirrored;
    uprightPlacements += imageResult.upright;

    if (pageNumber === 1) {
      firstPagePaintRegions = paintRegions(operators, pdfjs.OPS, viewport, colorOccurrences);
      const rendered = await renderFirstPage(page);
      thumbnail = rendered.thumbnail;
      visualHash = rendered.visualHash;
      detectedColors = rendered.colors;
    }
    page.cleanup();
  }
  const pdfMetadata = await pdf.getMetadata().catch(() => null);
  const info = (pdfMetadata?.info || {}) as Record<string, unknown>;
  const metadata: Metadata = {
    title: String(info.Title || ""),
    author: String(info.Author || ""),
    creator: String(info.Creator || ""),
    producer: String(info.Producer || ""),
    created: String(info.CreationDate || ""),
  };

  // El espacio de color se deduce de los diccionarios del PDF y de los
  // operadores ya descomprimidos. Buscarlo en el archivo crudo daba falsos
  // positivos, porque los flujos comprimidos son binario y cualquier byte
  // puede parecerse a un operador de color.
  const usesSpace = (space: "CMYK" | "RGB" | "Gray") => colorOccurrences.some((color) => color.space === space);
  const colorSpaces: string[] = [];
  if (/\/DeviceCMYK\b/.test(structuralRaw) || usesSpace("CMYK")) colorSpaces.push("CMYK");
  if (/\/(?:DeviceRGB|CalRGB)\b/.test(structuralRaw) || usesSpace("RGB")) colorSpaces.push("RGB");
  if (/\/ICCBased\b/.test(structuralRaw)) colorSpaces.push("ICC");
  if (/\/(?:DeviceGray|CalGray)\b/.test(structuralRaw) || usesSpace("Gray")) colorSpaces.push("Grises");
  if (/\/Lab\b/.test(structuralRaw)) colorSpaces.push("Lab");
  if (/\/(?:Separation|DeviceN)\b/.test(structuralRaw)) colorSpaces.push("Tintas directas");
  // El RGB puede estar escondido en la paleta de una imagen indexada.
  const rgbEnPaleta = /\/Indexed\s*\/?(?:DeviceRGB|CalRGB)\b/.test(structuralRaw);
  const spotColors = uniqueMatches(inspectionText, /\/Separation\s*\/([^\s/<>{}\[\]()]+)/g, 12);
  const profileName = detectProfile(structuralRaw, embeddedProfiles);
  const ppiMin = ppiValues.length ? Math.round(Math.min(...ppiValues)) : null;
  const ppiMax = ppiValues.length ? Math.round(Math.max(...ppiValues)) : null;
  const hasText = textCharacters > 0;

  // Bloqueos: solo lo que impide de verdad que el archivo se procese.
  const blockers: Array<{ id: string; title: string; detail: string }> = [];
  if (!crossReference.hasEof || !crossReference.hasStartXref || !crossReference.xrefValid) {
    blockers.push({
      id: "danado",
      title: "El archivo está dañado por dentro",
      detail: "Le falta o no coincide la tabla interna que dice dónde está cada cosa. Un visor común lo repara solo y por eso se ve bien, pero el RIP puede rechazarlo. Abrilo y volvé a guardarlo como PDF nuevo.",
    });
  }
  const filterNames = new Set<string>();
  for (const match of inspectionText.matchAll(/\/Filter\s*\/([A-Za-z0-9]+)/g)) filterNames.add(match[1]);
  for (const match of inspectionText.matchAll(/\/Filter\s*\[([^\]]+)\]/g)) for (const name of match[1].matchAll(/\/([A-Za-z0-9]+)/g)) filterNames.add(name[1]);
  const knownFilters = new Set(["FlateDecode", "Fl", "DCTDecode", "DCT", "JPXDecode", "LZWDecode", "LZW", "ASCII85Decode", "A85", "ASCIIHexDecode", "AHx", "RunLengthDecode", "RL", "CCITTFaxDecode", "CCF", "JBIG2Decode", "Crypt"]);
  const unknownFilters = Array.from(filterNames).filter((name) => !knownFilters.has(name));
  if (unknownFilters.length) {
    blockers.push({
      id: "compresion",
      title: "El archivo usa una compresión rara",
      detail: "Adentro tiene datos comprimidos de una forma que el RIP no conoce, así que puede no abrirlo. Volvé a exportarlo con compresión normal.",
    });
  }
  if (/\/XFA\b/.test(inspectionText)) {
    blockers.push({
      id: "formulario",
      title: "Es un formulario, no un arte",
      detail: "El contenido está armado como formulario interactivo y el RIP no lo ve. Imprimilo a un PDF nuevo antes de mandarlo.",
    });
  }
  if (pdfStructure.layerState === "orphaned") {
    blockers.push({
      id: "capas",
      title: "Las capas del archivo están rotas",
      detail: `Tiene ${pdfStructure.layerCount} capas que no están registradas donde corresponde. Es una inconsistencia que hace que PhotoPRINT rechace el archivo. Aplaná las capas y volvé a exportar.`,
    });
  }
  if (/\/JPXDecode\b/.test(inspectionText)) {
    blockers.push({
      id: "jpeg2000",
      title: "Hay imágenes en JPEG 2000",
      detail: "Es un formato de imagen que muchos RIP no leen, y donde estén esas imágenes puede quedar un hueco en blanco. Guardalas como JPEG o TIFF normal.",
    });
  }

  const rawFontCount = Array.from(structuralRaw.matchAll(/\/BaseFont\s*\//g)).length;
  const embeddedFontCount = Array.from(structuralRaw.matchAll(/\/FontFile\d?\s+/g)).length;

  const findings = buildFindings({
    regions: firstPagePaintRegions,
    targetPpi,
    document: {
      blockers,
      hasRgb: colorSpaces.includes("RGB"),
      rgbInImages: imageColorSpaces.some((space) => /RGB/i.test(space)),
      rgbInPalette: rgbEnPaleta,
      fontsNotEmbedded: hasText && rawFontCount > 0 && embeddedFontCount === 0,
      missingFontResources: pdfStructure.missingFontResources,
      minPpi: ppiMin,
      imageCount,
      spotInks,
      mirroredMixed: mirroredPlacements > 0 && uprightPlacements > 0,
      totalPages,
    },
  });

  const facts = fileFacts({
    pdfVersion: version,
    pages: totalPages,
    geometry: pageGeometry,
    colorSpaces,
    imageColorSpaces,
    imageCount,
    ppiMin,
    ppiMax,
    hasText,
    textCharacters,
    fontNames: Array.from(fontNames),
    spotInks,
    iccUsages,
    outputIntents,
    pdfxVersion: pdfx.version,
    layerCount: pdfStructure.layerCount,
    mirrored: { mirrored: mirroredPlacements, upright: uprightPlacements },
  });

  const verdict = iccVerdict(iccUsages, outputIntents);
  const status: Status = findings.some((finding) => finding.severity === "error") ? "blocked"
    : findings.length ? "caution" : "ready";

  await pdf.destroy();
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    status,
    format: extension === "ai" ? "Illustrator · PDF compatible" : "PDF",
    pdfVersion: version,
    pages: totalPages,
    pagesAnalyzed: maxPages,
    dimensions: Array.from(dimensions).slice(0, 5),
    findings,
    facts,
    colorSpaces,
    dominantColors: detectedColors,
    sourceColors,
    paintRegions: firstPagePaintRegions,
    spotColors,
    profileName,
    fontNames: Array.from(fontNames).slice(0, 16),
    imageCount,
    ppiMin,
    ppiMax,
    ppiPlacements: ppiValues.length,
    hasText,
    textCharacters,
    textPreview: collectedText.trim().slice(0, 260),
    metadata,
    layerCount: pdfStructure.layerCount,
    layerState: pdfStructure.layerState,
    missingFontResources: pdfStructure.missingFontResources,
    formXObjectCount: pdfStructure.formXObjectCount,
    iccProfileCount: pdfStructure.iccProfileCount,
    iccVerdict: verdict,
    iccProfiles: summarizeIccUsages(iccUsages),
    outputIntents,
    pdfxVersion: pdfx.version,
    spotInks,
    imageColorSpaces,
    mirrored: { mirrored: mirroredPlacements, upright: uprightPlacements },
    pageGeometry,
    riskFeatures,
    thumbnail,
    visualHash,
    fileHash,
    analyzedAt: new Date().toISOString(),
  };
}

function statusLabel(status: Status) {
  return status === "ready" ? "APTO PARA RIP" : status === "caution" ? "RIESGO DE COMPATIBILIDAD" : "NO APTO PARA RIP";
}

function layerLabel(analysis: Analysis) {
  if (analysis.layerState === "none") return "Sin capas · aplanado";
  if (analysis.layerState === "registered") return `${analysis.layerCount} · registradas correctamente`;
  if (analysis.layerState === "orphaned") return `${analysis.layerCount} · OCG huérfanas`;
  return "No concluyente";
}

function resourceIntegrityLabel(analysis: Analysis) {
  return analysis.missingFontResources.length
    ? `Fuentes faltantes: ${analysis.missingFontResources.join(", ")}`
    : "Recursos coherentes";
}

function sourceColorValues(color: PdfSourceColor) {
  const value = (number: number) => `${Number((number * 100).toFixed(1))}%`;
  if (color.space === "CMYK") return ["C", "M", "Y", "K"].map((channel, index) => `${channel} ${value(color.values[index])}`).join(" · ");
  if (color.space === "RGB") return ["R", "G", "B"].map((channel, index) => `${channel} ${value(color.values[index])}`).join(" · ");
  if (color.space === "Gray") return `GRIS ${value(color.values[0])}`;
  return color.values.map((number, index) => `T${index + 1} ${value(number)}`).join(" · ");
}

function sourceColorSummary(analysis: Analysis) {
  return analysis.sourceColors.length
    ? analysis.sourceColors.slice(0, 8).map((color) => `${color.space} ${sourceColorValues(color)}`).join(" / ")
    : "No extraíble desde operadores";
}


function mirrorLabel(analysis: Analysis) {
  const { mirrored, upright } = analysis.mirrored;
  if (mirrored === 0 && upright === 0) return "No medible";
  if (mirrored > 0 && upright > 0) return "Mixto";
  return mirrored > 0 ? "Espejado" : "Al derecho";
}

function ppiLabel(analysis: Analysis) {
  if (analysis.imageCount === 0) return "Vectorial";
  if (analysis.ppiMin === null) return "No concluyente";
  return analysis.ppiMin === analysis.ppiMax ? `${analysis.ppiMin} ppp` : `${analysis.ppiMin}–${analysis.ppiMax} ppp`;
}

function visualSimilarity(a: Analysis, b: Analysis) {
  if (a.fileHash === b.fileHash) return 100;
  if (!a.visualHash || !b.visualHash || a.visualHash.length !== b.visualHash.length) return null;
  let distance = 0;
  for (let index = 0; index < a.visualHash.length; index += 1) if (a.visualHash[index] !== b.visualHash[index]) distance += 1;
  return Math.round((1 - distance / a.visualHash.length) * 100);
}

export function PreflightApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<ProfileKey>("ideal");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, name: "" });
  const [error, setError] = useState<string | null>(null);

  const selected = items.find((item) => item.analysis.id === selectedId) || items[0] || null;
  const summary = useMemo(() => ({
    ready: items.filter((item) => item.analysis.status === "ready").length,
    caution: items.filter((item) => item.analysis.status === "caution").length,
    blocked: items.filter((item) => item.analysis.status === "blocked").length,
  }), [items]);
  const batchStatus: Status = summary.blocked ? "blocked" : summary.caution ? "caution" : "ready";

  async function processFiles(fileList: FileList | File[], append = false) {
    const existing = append ? items : [];
    const existingKeys = new Set(existing.map(({ file }) => `${file.name}-${file.size}-${file.lastModified}`));
    const candidates = Array.from(fileList)
      .filter((file) => /\.(pdf|ai)$/i.test(file.name))
      .filter((file) => !existingKeys.has(`${file.name}-${file.size}-${file.lastModified}`))
      .slice(0, Math.max(0, MAX_FILES - existing.length));

    if (!candidates.length) {
      setError("Selecciona archivos PDF o AI nuevos. Puedes analizar hasta 12 por lote.");
      return;
    }

    setWorking(true);
    setError(null);
    setProgress({ done: 0, total: candidates.length, name: candidates[0].name });
    const analyzed: BatchItem[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const file = candidates[index];
      setProgress({ done: index, total: candidates.length, name: file.name });
      try {
        analyzed.push({ file, analysis: await analyzeFile(file, PROFILES[profile].dpi) });
      } catch {
        analyzed.push({ file, analysis: emptyAnalysis(file, "", { id: "sin-analisis", title: "No se pudo terminar de revisar", detail: "El archivo es demasiado pesado o tiene una estructura inesperada y se cortó el análisis." }) });
      }
      setProgress({ done: index + 1, total: candidates.length, name: file.name });
    }
    const next = [...existing, ...analyzed];
    setItems(next);
    setSelectedId(analyzed[0]?.analysis.id || next[0]?.analysis.id || null);
    setWorking(false);
  }

  function onInput(event: ChangeEvent<HTMLInputElement>, append = false) {
    if (event.target.files) void processFiles(event.target.files, append);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void processFiles(event.dataTransfer.files);
  }

  function reset() {
    setItems([]);
    setSelectedId(null);
    setError(null);
  }

  function removeFile(id: string) {
    const removedIndex = items.findIndex(({ analysis }) => analysis.id === id);
    const next = items.filter(({ analysis }) => analysis.id !== id);
    setItems(next);
    if (selected?.analysis.id === id) {
      setSelectedId(next[Math.min(Math.max(removedIndex, 0), Math.max(next.length - 1, 0))]?.analysis.id || null);
    }
    setError(null);
  }

  function exportReport() {
    if (!items.length) return;
    const lines = [
      "RIPCHECK — INFORME COMPARATIVO DE PREFLIGHT",
      "=============================================",
      `Objetivo del lote: ${PROFILES[profile].name} · ${PROFILES[profile].dpi} ppp efectivos`,
      `Archivos: ${items.length} · Aptos: ${summary.ready} · Con advertencias: ${summary.caution} · No aptos: ${summary.blocked}`,
      "",
      ...items.flatMap(({ analysis }) => [
        `${analysis.fileName} — ${statusLabel(analysis.status)}`,
        `Formato: ${analysis.format} · Páginas: ${analysis.pages ?? "—"} · Tamaño: ${analysis.dimensions.join(" / ") || "—"}`,
        `PPI reales: ${ppiLabel(analysis)}`,
        `Gestión de color: ${analysis.iccVerdict.label} — ${analysis.iccVerdict.summary}`,
        ...(analysis.iccProfiles.length
          ? analysis.iccProfiles.map((item) => `  · ICC ${item.role}: ${item.name} [${item.space}, ICC ${item.version}, ${item.deviceClass}, intención ${item.renderingIntent.toLowerCase()}]${item.issues.length ? ` — ${item.issues.join(" ")}` : ""}`)
          : ["  · Sin perfiles ICC incrustados"]),
        `Condición de salida: ${analysis.outputIntents.map((item) => item.outputConditionIdentifier || item.subtype || "sin nombre").join(" · ") || "no declarada"}${analysis.pdfxVersion ? ` · ${analysis.pdfxVersion}` : ""}`,
        `Color: ${analysis.colorSpaces.join(" + ") || "No concluyente"} · Imágenes: ${analysis.imageColorSpaces.join(" · ") || "sin imágenes"}`,
        `Colores originales: ${sourceColorSummary(analysis)}`,
        `Tintas directas: ${analysis.spotInks.map((ink) => `${ink.name}${ink.alternate ? ` → ${ink.alternate}` : ""}`).join(" · ") || "ninguna"}`,
        `Espejo: ${mirrorLabel(analysis).toLowerCase()}`,
        `Texto: ${analysis.hasText ? `Sí, ${analysis.textCharacters} caracteres` : "No detectado"}`,
        ...(analysis.findings.length ? analysis.findings.map((finding) => `[${finding.severity === "error" ? "CORREGIR" : "REVISAR"}] ${finding.title}. ${finding.detail}`) : ["Sin nada para revisar."]),
        ...analysis.facts.map((fact) => `${fact.label}: ${fact.value}${fact.note ? ` (${fact.note})` : ""}`),
        "",
      ]),
      "Este informe no reemplaza el preflight interno del RIP ni una prueba física.",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ripcheck-lote-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="RIPcheck, inicio"><span className="brand-mark">R</span><span>RIP<span>check</span></span></a>
        <div className="topbar-note"><span className="pulse" /> Análisis local · los archivos no se suben</div>
      </header>

      {!items.length && !working ? (
        <section className="landing" id="inicio">
          <div className="hero-copy">
            <p className="kicker">PREFLIGHT POR LOTE PARA SUBLIMACIÓN</p>
            <h1>Compara antes<br />de <em>ripear.</em></h1>
            <p className="hero-lead">Carga uno o varios PDF/AI. RIPcheck lee los perfiles ICC incrustados uno por uno y dice si están puestos como corresponde o si los adjuntó sola la aplicación de diseño. Controla que todo el color sea CMYK, mide la tinta, el espejo, el sangrado y las tintas directas, y marca lo que el RIP no va a interpretar igual que la pantalla.</p>
            <div className="trust-row"><span><b>01</b> ICC real, no solo el nombre</span><span><b>02</b> Todo en CMYK</span><span><b>03</b> Comparación de archivos</span></div>
          </div>
          <div className="upload-panel">
            <div className="field-label"><span>Objetivo de resolución</span><span>{PROFILES[profile].dpi} ppp</span></div>
            <div className="profile-grid" role="radiogroup" aria-label="Objetivo de resolución">
              {(Object.keys(PROFILES) as ProfileKey[]).map((key) => <button key={key} className={profile === key ? "profile active" : "profile"} onClick={() => setProfile(key)} role="radio" aria-checked={profile === key}><span>{PROFILES[key].name}</span><b>{PROFILES[key].dpi} ppp{key === "ideal" ? " · ideal" : ""}</b></button>)}
            </div>
            <p className="profile-note">{PROFILES[profile].note}</p>
            <div className={dragging ? "dropzone dragging" : "dropzone"} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}>
              <input ref={inputRef} type="file" multiple accept=".pdf,.ai,application/pdf,application/postscript" onChange={(event) => onInput(event)} hidden />
              <span className="upload-icon">↥</span><h2>Suelta tus archivos aquí</h2><p>o haz clic para seleccionar varios</p><small>PDF o AI · hasta {MAX_FILES} archivos</small>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <p className="privacy"><span>✓</span> El análisis ocurre en este dispositivo. Ningún archivo sale de tu equipo.</p>
          </div>
        </section>
      ) : working && !items.length ? (
        <section className="working" aria-live="polite"><div className="scanner"><span /></div><p className="kicker">ANÁLISIS PROFUNDO {progress.done}/{progress.total}</p><h1>Revisando el lote…</h1><p>{progress.name}</p><div className="progress-track"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div></section>
      ) : items.length ? (
        <section className="batch-shell">
          <div className="report-actions">
            <button className="back-button" onClick={reset}>← Nuevo lote</button>
            <div className="action-cluster"><input ref={addInputRef} type="file" multiple accept=".pdf,.ai" onChange={(event) => onInput(event, true)} hidden /><button className="add-button" onClick={() => addInputRef.current?.click()} disabled={working || items.length >= MAX_FILES}>+ Agregar archivos</button><button className="export-button" onClick={exportReport}>Exportar informe</button></div>
          </div>

          <div className={`batch-banner ${batchStatus}`}>
            <div><p className="result-label">RESULTADO</p><h1>{batchStatus === "blocked" ? `${summary.blocked} archivo${summary.blocked === 1 ? "" : "s"} con algo para corregir` : batchStatus === "caution" ? "Se pueden imprimir, hay puntos para mirar" : "Todo en orden"}</h1><p>{items.length} archivo{items.length === 1 ? "" : "s"} revisado{items.length === 1 ? "" : "s"}.</p></div>
            <div className="batch-counts"><span className="count-ready"><b>{summary.ready}</b>Sin nada</span><span className="count-caution"><b>{summary.caution}</b>Para mirar</span><span className="count-blocked"><b>{summary.blocked}</b>Para corregir</span></div>
          </div>

          {working && <div className="inline-progress"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /><p>Analizando {progress.name} · {progress.done}/{progress.total}</p></div>}

          <nav className="file-tabs" aria-label="Archivos analizados">
            {items.map(({ analysis }) => <div className="file-tab-shell" key={analysis.id}><button className={selected?.analysis.id === analysis.id ? "file-tab active" : "file-tab"} onClick={() => setSelectedId(analysis.id)}><i className={analysis.status} /> <span>{analysis.fileName}</span><b>{ppiLabel(analysis)}</b></button><button className="file-remove" type="button" onClick={() => removeFile(analysis.id)} aria-label={`Eliminar ${analysis.fileName}`} title="Eliminar archivo">×</button></div>)}
          </nav>

          {selected && <FileDetail file={selected.file} analysis={selected.analysis} />}
          {items.length > 1 && <Comparison items={items} />}

          <section className="rip-checklist"><div><p className="kicker">CÓMO LEER ESTO</p><h2>Solo se avisa lo que hay que mirar</h2><p>Si no aparece ninguna alerta, el archivo no tiene nada raro. Lo demás son datos, no problemas: el tamaño, el perfil y la cantidad de tinta están ahí para consultarlos, no para preocuparse.</p></div><ol><li><span>1</span><div><b>Para corregir</b><small>El archivo no va a salir bien así</small></div></li><li><span>2</span><div><b>Para mirar</b><small>Se imprime, pero conviene verlo en la prueba</small></div></li><li><span>3</span><div><b>Ver dónde</b><small>Marca en la vista la zona exacta</small></div></li><li><span>4</span><div><b>Datos del archivo</b><small>Información, sin alarma</small></div></li></ol></section>
          <p className="disclaimer">RIPcheck lee el PDF de verdad, en esta computadora. Las zonas marcadas corresponden a la primera página.</p>
        </section>
      ) : null}
    </main>
  );
}

function FileDetail({ file, analysis }: { file: File; analysis: Analysis }) {
  const [selectedColorId, setSelectedColorId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [eyedropper, setEyedropper] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageRatio, setPageRatio] = useState(1 / 1.414);
  const [sampledPoint, setSampledPoint] = useState<{ analysisId: string; x: number; y: number; kind: PdfPaintRegion["kind"] | "empty"; objectId: string | null } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const sampleImageRef = useRef<HTMLImageElement>(null);
  const activeColor = analysis.sourceColors.find((color) => color.id === selectedColorId) || null;
  const currentSample = sampledPoint?.analysisId === analysis.id ? sampledPoint : null;
  const setExactZoom = (value: number) => {
    const next = Math.min(40, Math.max(0.5, Number(value.toFixed(3))));
    zoomRef.current = next;
    setZoom(next);
  };
  const changeZoom = (direction: -1 | 1) => setExactZoom(zoomRef.current * (direction > 0 ? 1.25 : 0.8));

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
    setPdfUrl(url);
    setExactZoom(1);
    setEyedropper(false);
    setSelectedColorId(null);
    setSampledPoint(null);
    setHighlight(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const current = zoomRef.current;
      const next = Math.min(40, Math.max(0.5, current * Math.exp(-event.deltaY * 0.002)));
      if (Math.abs(next - current) < 0.001) return;
      const bounds = stage.getBoundingClientRect();
      const localX = event.clientX - bounds.left;
      const localY = event.clientY - bounds.top;
      const contentX = stage.scrollLeft + localX;
      const contentY = stage.scrollTop + localY;
      const ratio = next / current;
      setExactZoom(next);
      requestAnimationFrame(() => {
        stage.scrollLeft = contentX * ratio - localX;
        stage.scrollTop = contentY * ratio - localY;
      });
    };
    stage.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => stage.removeEventListener("wheel", handleWheel, true);
  }, []);

  const sampledCoordinates = (event: ReactMouseEvent<SVGElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const selectVectorObject = (event: ReactMouseEvent<SVGPathElement>, object: PdfPaintRegion) => {
    if (!eyedropper) return;
    event.stopPropagation();
    const { x, y } = sampledCoordinates(event);
    setSelectedColorId(object.colorId);
    setSampledPoint({ analysisId: analysis.id, x, y, kind: object.kind, objectId: object.id });
  };
  const highlighted = analysis.findings.find((finding) => finding.id === highlight)?.rects ?? [];
  const selectEmptyPoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!eyedropper) return;
    const { x, y } = sampledCoordinates(event);
    setSelectedColorId(null);
    setSampledPoint({ analysisId: analysis.id, x, y, kind: "empty", objectId: null });
  };
  return <section className="file-detail">
    <div className="visual-column">
      <div className="detail-heading"><span>Vista vectorial · PDF original</span><small>{analysis.dimensions[0] || "Sin tamaño"}</small></div>
      <div className="preview-toolbar" aria-label="Controles de la vista real"><span>Rueda exclusiva para zoom · 50% a 4000%</span><button type="button" onClick={() => changeZoom(-1)} disabled={zoom <= 0.5} aria-label="Alejar">−</button><button className="zoom-value" type="button" onClick={() => setExactZoom(1)} title="Volver al 100%">{Math.round(zoom * 100)}%</button><button type="button" onClick={() => changeZoom(1)} disabled={zoom >= 40} aria-label="Acercar">+</button></div>
      <div ref={stageRef} className={eyedropper ? "thumb-stage eyedropper-active" : "thumb-stage"}>{pdfUrl && analysis.thumbnail ? <div className="vector-surface" style={{ width: `${zoom * 100}%`, aspectRatio: `${pageRatio}` }}><object className="vector-object" data={`${pdfUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`} type="application/pdf" aria-label={`Vista vectorial original de ${analysis.fileName}`}><img src={analysis.thumbnail} alt={`Primera página de ${analysis.fileName}`} /></object><svg className={eyedropper ? "vector-object-map active" : "vector-object-map"} viewBox="0 0 1 1" preserveAspectRatio="none" onClick={selectEmptyPoint} aria-label={eyedropper ? `${analysis.paintRegions.length} objetos seleccionables en la primera página` : "Mapa de objetos vectoriales"}>{analysis.paintRegions.map((object) => <path key={object.id} className={`vector-hit ${object.paint} ${currentSample?.objectId === object.id ? "selected" : ""}`} d={object.d} fill={object.paint === "fill" ? "rgba(0,0,0,.001)" : "none"} fillRule={object.fillRule} stroke={object.paint === "stroke" ? "rgba(0,0,0,.001)" : "none"} strokeWidth={Math.max(object.strokeWidth, 0.004)} onClick={(event) => selectVectorObject(event, object)}><title>{object.kind === "raster" ? "Imagen ráster" : object.kind === "text" ? "Objeto de texto" : "Trazado vectorial"}</title></path>)}</svg>{currentSample && <span className="sample-marker" style={{ left: `${currentSample.x * 100}%`, top: `${currentSample.y * 100}%` }} aria-hidden="true" />}{highlighted.map((rect, index) => <span key={index} className="finding-marker" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} aria-hidden="true" />)}</div> : <div className="preview-fallback invalid"><span>AI</span><p>Sin representación vectorial PDF compatible.</p></div>}</div>
      {analysis.thumbnail && <img ref={sampleImageRef} className="sampling-source" src={analysis.thumbnail} alt="" aria-hidden="true" onLoad={(event) => setPageRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} />}
      <div className="color-readout">
        <span>CUENTAGOTAS DE OBJETOS REALES</span>
        <div className="color-tools"><button className={eyedropper ? "eyedropper-button active" : "eyedropper-button"} type="button" onClick={() => setEyedropper((active) => !active)} disabled={!analysis.thumbnail} aria-pressed={eyedropper}><span>⌖</span>{eyedropper ? "Cuentagotas activo" : "Cuentagotas"}</button><small>{eyedropper ? `Haz clic directamente sobre uno de los ${analysis.paintRegions.length.toLocaleString("es-UY")} objetos detectados.` : "Actívalo para seleccionar trazados, texto e imágenes del PDF."}</small></div>
        {currentSample && !activeColor && <div className="sample-result empty"><div><span>{currentSample.kind === "raster" ? "IMAGEN RÁSTER SELECCIONADA" : currentSample.kind === "text" ? "OBJETO DE TEXTO SELECCIONADO" : currentSample.kind === "vector" ? "TRAZADO VECTORIAL SELECCIONADO" : "NO HAY UN OBJETO EN ESTE PUNTO"}</span><b>{currentSample.kind === "raster" ? "La imagen es un objeto real, pero no contiene un único CMYK vectorial para toda su superficie." : currentSample.kind === "empty" ? "Haz clic sobre el contorno o el interior de un objeto visible." : "El objeto fue localizado, pero su color usa una máscara, patrón o recurso que no expone una composición directa."}</b></div><small>No se convierte el píxel de pantalla a RGB ni se inventa un CMYK.</small></div>}
        {activeColor && <><div className="sample-result found"><div><span>{currentSample?.kind === "text" ? "OBJETO DE TEXTO SELECCIONADO" : "TRAZADO VECTORIAL SELECCIONADO"}</span><b>{activeColor.space} original · {activeColor.source}</b></div><small>El clic ocurrió sobre la geometría SVG exacta de este objeto.</small></div><div className="color-composition source"><div><span>ESPACIO ORIGINAL</span><b>{activeColor.space}</b></div><div><span>COMPOSICIÓN REAL</span><b>{sourceColorValues(activeColor)}</b></div><div><span>PERFIL ICC</span><b>{analysis.profileName}</b></div><div><span>ORIGEN DEL COLOR</span><b>{activeColor.source}</b></div></div></>}
        <small>La selección se realiza sobre cada trazado SVG reconstruido desde el PDF, no sobre una muestra RGB ni sobre un rectángulo aproximado.</small>
      </div>
    </div>
    <div className="technical-column">
      <div className={`verdict ${analysis.status}`}>
        <b>{analysis.status === "blocked" ? "Hay algo que corregir" : analysis.status === "caution" ? "Se puede imprimir, mirá estos puntos" : "Listo para imprimir"}</b>
        <span>{analysis.findings.length === 0 ? "No se encontró nada para revisar." : `${analysis.findings.length} ${analysis.findings.length === 1 ? "cosa" : "cosas"} para revisar.`}</span>
      </div>

      {analysis.findings.length > 0 && <div className="findings">
        {analysis.findings.map((finding) => {
          const open = highlight === finding.id;
          return <article key={finding.id} className={`finding ${finding.severity} ${open ? "open" : ""}`}>
            <div className="finding-head">
              <h3>{finding.title}</h3>
              <small>{finding.badge}</small>
            </div>
            <p>{finding.detail}</p>
            {finding.rects.length > 0 && <button type="button" className={open ? "locate active" : "locate"} onClick={() => setHighlight(open ? null : finding.id)}>
              {open ? "Ocultar en la vista" : `Ver dónde (${finding.rects.length} ${finding.rects.length === 1 ? "zona" : "zonas"})`}
            </button>}
          </article>;
        })}
      </div>}

      <div className="facts">
        <span className="facts-title">Datos del archivo</span>
        <dl>
          {analysis.facts.map((fact) => <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}{fact.note && <small>{fact.note}</small>}</dd>
          </div>)}
        </dl>
      </div>
    </div>
  </section>;
}


function Comparison({ items }: { items: BatchItem[] }) {
  const base = items[0].analysis;
  const rows = [
    { label: "Compatibilidad RIP", get: (a: Analysis) => statusLabel(a.status) },

    { label: "PPI reales", get: ppiLabel },
    { label: "Estado del ICC", get: (a: Analysis) => a.iccVerdict.label },
    { label: "Perfiles ICC", get: (a: Analysis) => a.iccProfiles.length ? a.iccProfiles.map((item) => `${item.name} (${item.role.toLowerCase()})`).join(" / ") : "Ninguno" },
    { label: "Condición de salida", get: (a: Analysis) => a.outputIntents.map((item) => item.outputConditionIdentifier || item.subtype || "sin nombre").join(" · ") || "No declarada" },
    { label: "Norma PDF/X", get: (a: Analysis) => a.pdfxVersion || "No declarada" },
    { label: "Espacios de color", get: (a: Analysis) => a.colorSpaces.join(" + ") || "No concluyente" },
    { label: "Espacios de las imágenes", get: (a: Analysis) => a.imageColorSpaces.join(" · ") || "Sin imágenes" },
    { label: "Espejo", get: mirrorLabel },
    { label: "Tintas directas", get: (a: Analysis) => a.spotInks.map((ink) => ink.name).join(" · ") || "Ninguna" },
    { label: "Colores originales", get: sourceColorSummary },
    { label: "Texto", get: (a: Analysis) => a.hasText ? `Sí · ${a.textCharacters} caracteres` : "No detectado" },
    { label: "Integridad de recursos", get: resourceIntegrityLabel },
    { label: "Capas PDF", get: layerLabel },
    { label: "Formularios gráficos", get: (a: Analysis) => String(a.formXObjectCount) },
    { label: "Referencias ICC", get: (a: Analysis) => String(a.iccProfileCount) },
    { label: "Páginas", get: (a: Analysis) => String(a.pages ?? "—") },
    { label: "Tamaño de página", get: (a: Analysis) => a.dimensions.join(" / ") || "—" },
    { label: "Creador / productor", get: (a: Analysis) => [a.metadata.creator, a.metadata.producer].filter(Boolean).join(" / ") || "No declarado" },
  ];
  return <section className="comparison-section" id="comparacion">
    <div className="section-heading"><div><p className="kicker">COMPARACIÓN TÉCNICA</p><h2>Diferencias entre archivos</h2></div><p>Las filas resaltadas cambian entre archivos.</p></div>
    <div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>Dato</th>{items.map(({ analysis }) => <th key={analysis.id}>{analysis.fileName}</th>)}</tr></thead><tbody>{rows.map((row) => { const values = items.map(({ analysis }) => row.get(analysis)); const different = new Set(values).size > 1; return <tr key={row.label} className={different ? "different" : "same"}><th>{row.label}<small>{different ? "Diferente" : "Igual"}</small></th>{values.map((value, index) => <td key={`${row.label}-${items[index].analysis.id}`}>{value}</td>)}</tr>; })}</tbody></table></div>
    <div className="section-heading visual-heading"><div><p className="kicker">COMPARACIÓN VISUAL</p><h2>Similitud de la primera página</h2></div><p>Referencia: {base.fileName}</p></div>
    <div className="visual-compare-grid">{items.map(({ analysis }) => { const similarity = visualSimilarity(base, analysis); return <article key={analysis.id} className="compare-card">{analysis.thumbnail ? <img src={analysis.thumbnail} alt={`Miniatura de ${analysis.fileName}`} /> : <div className="no-thumb">Sin vista</div>}<div><b>{analysis.fileName}</b><span>{analysis.fileHash === base.fileHash ? (analysis.id === base.id ? "Archivo de referencia" : "Duplicado exacto") : similarity === null ? "No comparable" : similarity >= 90 ? `${similarity}% · Casi idéntico` : similarity >= 70 ? `${similarity}% · Similar` : `${similarity}% · Visualmente diferente`}</span></div></article>; })}</div>
  </section>;
}
