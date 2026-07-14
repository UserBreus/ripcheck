"use client";

import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { decodedContentStreams, embeddedIccProfiles, extractSourceColors, inspectPdfStructure, type LayerState, type PdfSourceColor } from "./pdf-structure";

type Severity = "pass" | "warning" | "error" | "info";
type Status = "ready" | "caution" | "blocked";
type Matrix = [number, number, number, number, number, number];
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type Check = { id: string; title: string; detail: string; severity: Severity; value?: string; scope?: "rip" | "quality" | "info" };
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
};

type Analysis = {
  id: string;
  fileName: string;
  fileSize: number;
  status: Status;
  qualityStatus: Status;
  format: string;
  pdfVersion: string | null;
  pages: number | null;
  pagesAnalyzed: number;
  dimensions: string[];
  checks: Check[];
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
  thumbnail: string | null;
  visualHash: string | null;
  fileHash: string;
  analyzedAt: string;
};

type BatchItem = { file: File; analysis: Analysis };

const PROFILES = {
  ideal: { name: "Calidad ideal", dpi: 300, note: "Recomendado para sublimación con detalle y lectura cercana." },
  standard: { name: "Producción estándar", dpi: 200, note: "Aceptable cuando el original no alcanza 300 ppp efectivos." },
  grand: { name: "Gran formato", dpi: 150, note: "Solo para piezas grandes observadas a mayor distancia." },
} as const;

type ProfileKey = keyof typeof PROFILES;
const MAX_FILES = 12;
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

  const addImage = (width: number, height: number) => {
    imageCount += 1;
    const placedWidth = Math.hypot(ctm[0], ctm[1]);
    const placedHeight = Math.hypot(ctm[2], ctm[3]);
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
      addImage(Number(image?.width) || 0, Number(image?.height) || 0);
    }
  });

  return { values, imageCount };
}

function paintRegions(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  OPS: PdfJs["OPS"],
  viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): [number, number] },
  sourceColors: PdfSourceColor[],
) {
  type PaintState = { ctm: Matrix; fillColorId: string | null; strokeColorId: string | null; lineWidth: number; textMatrix: Matrix; fontSize: number };
  let state: PaintState = { ctm: [...IDENTITY], fillColorId: null, strokeColorId: null, lineWidth: 1, textMatrix: [...IDENTITY], fontSize: 12 };
  const stack: PaintState[] = [];
  const regions: PdfPaintRegion[] = [];

  const colorIdFromArgs = (args: unknown[]) => {
    const hex = typeof args[0] === "string" && /^#[0-9a-f]{6}$/i.test(args[0]) ? args[0] : null;
    return hex ? nearestSourceColor(sourceColors, hex)?.color.id || null : null;
  };
  const matrixFrom = (value: unknown): Matrix | null => {
    const matrix = value as ArrayLike<number> | null;
    if (!matrix || typeof matrix.length !== "number" || matrix.length < 6) return null;
    const numbers = Array.from({ length: 6 }, (_, index) => Number(matrix[index])) as Matrix;
    return numbers.every(Number.isFinite) ? numbers : null;
  };
  const project = (x: number, y: number, matrix: Matrix = state.ctm) => {
    const transformedX = matrix[0] * x + matrix[2] * y + matrix[4];
    const transformedY = matrix[1] * x + matrix[3] * y + matrix[5];
    const point = viewport.convertToViewportPoint(transformedX, transformedY);
    return [point[0] / viewport.width, point[1] / viewport.height] as const;
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
    const origin = project(0, 0);
    const horizontal = project(state.lineWidth, 0);
    const vertical = project(0, state.lineWidth);
    return Math.max(Math.hypot(horizontal[0] - origin[0], horizontal[1] - origin[1]), Math.hypot(vertical[0] - origin[0], vertical[1] - origin[1]), 0.0015);
  };
  const addRegion = (d: string, colorId: string | null, kind: PdfPaintRegion["kind"], paint: PdfPaintRegion["paint"], fillRule: PdfPaintRegion["fillRule"] = "nonzero") => {
    if (!d || regions.length >= 10000) return;
    regions.push({ id: `${kind}-${regions.length}`, colorId, kind, d, paint, fillRule, strokeWidth: paint === "stroke" ? normalizedLineWidth() : 0, order: regions.length });
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
    else if (fn === OPS.setFillRGBColor || fn === OPS.setFillCMYKColor || fn === OPS.setFillGray || fn === OPS.setFillColor || fn === OPS.setFillColorN) state.fillColorId = colorIdFromArgs(args);
    else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeCMYKColor || fn === OPS.setStrokeGray || fn === OPS.setStrokeColor || fn === OPS.setStrokeColorN) state.strokeColorId = colorIdFromArgs(args);
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
      const paint = Number(args[0]);
      const data = args[1] as ArrayLike<ArrayLike<number>> | undefined;
      const d = data?.[0] ? pathFromEncoded(data[0]) : "";
      const evenOdd = [OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke].includes(paint);
      if ([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint)) addRegion(d, state.fillColorId, "vector", "fill", evenOdd ? "evenodd" : "nonzero");
      if ([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint)) addRegion(d, state.strokeColorId, "vector", "stroke");
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask) {
      addRegion(polygon([[0, 0], [1, 0], [1, 1], [0, 1]]), null, "raster", "fill");
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
  if (!context) return { thumbnail: null, visualHash: null, colors: [] as string[] };
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return { thumbnail: canvas.toDataURL("image/jpeg", 0.82), visualHash: differenceHash(canvas), colors: dominantColors(canvas) };
}

function emptyAnalysis(file: File, fileHash: string, check: Check): Analysis {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    status: "blocked",
    qualityStatus: "blocked",
    format: file.name.toLowerCase().endsWith(".ai") ? "Illustrator nativo" : "No reconocido",
    pdfVersion: null,
    pages: null,
    pagesAnalyzed: 0,
    dimensions: [],
    checks: [{ ...check, scope: check.scope || "rip" }],
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
    id: "structure",
    title: extension === "ai" ? "AI sin compatibilidad PDF" : "Archivo no reconocido como PDF",
    detail: extension === "ai" ? "Guarda nuevamente el AI activando “Crear archivo compatible con PDF”. Sin esa representación no es seguro enviarlo al RIP." : "La firma del archivo no corresponde a un PDF válido.",
    severity: "error",
    scope: "rip",
    value: "NO APTO",
  });

  if (/\/Encrypt\b/.test(raw)) return emptyAnalysis(file, fileHash, {
    id: "security",
    title: "Documento protegido o cifrado",
    detail: "Quita la contraseña y las restricciones antes de enviarlo a producción.",
    severity: "error",
    scope: "rip",
    value: "NO APTO",
  });

  const contentText = await decodedContentStreams(bytes, raw);
  const inspectionText = `${raw}\n${contentText}`;
  const crossReference = validateCrossReference(bytes);
  const pdfStructure = inspectPdfStructure(raw, contentText);
  const sourceColors = extractSourceColors(raw, contentText, 64);
  const embeddedProfiles = await embeddedIccProfiles(bytes, raw);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch {
    return emptyAnalysis(file, fileHash, {
      id: "parse",
      title: "El documento no puede interpretarse",
      detail: "La estructura está dañada o utiliza características que impiden abrirla de forma confiable.",
      severity: "error",
      scope: "rip",
      value: "NO APTO",
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

    if (pageNumber === 1) {
      firstPagePaintRegions = paintRegions(operators, pdfjs.OPS, viewport, sourceColors);
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

  const colorSpaces: string[] = [];
  if (/\/DeviceCMYK\b|(?:^|\s)(?:-?\d*\.?\d+\s+){4}[kK](?=\s|$)/m.test(inspectionText)) colorSpaces.push("CMYK");
  if (/\/DeviceRGB\b|(?:^|\s)(?:-?\d*\.?\d+\s+){3}(?:rg|RG)(?=\s|$)/m.test(inspectionText)) colorSpaces.push("RGB");
  if (/\/ICCBased\b/.test(inspectionText)) colorSpaces.push("ICC");
  if (/\/DeviceGray\b|(?:^|\s)-?\d*\.?\d+\s+[gG](?=\s|$)/m.test(inspectionText)) colorSpaces.push("Grises");
  if (/\/Lab\b/.test(inspectionText)) colorSpaces.push("Lab");
  if (/\/(?:Separation|DeviceN)\b/.test(inspectionText)) colorSpaces.push("Tintas directas");
  const spotColors = uniqueMatches(inspectionText, /\/Separation\s*\/([^\s/<>{}\[\]()]+)/g, 12);
  const profileName = detectProfile(raw, embeddedProfiles);
  const ppiMin = ppiValues.length ? Math.round(Math.min(...ppiValues)) : null;
  const ppiMax = ppiValues.length ? Math.round(Math.max(...ppiValues)) : null;
  const hasText = textCharacters > 0;
  const checks: Check[] = [];

  checks.push({ id: "structure", title: extension === "ai" ? "AI compatible con PDF" : "PDF interpretable", detail: `${totalPages} página${totalPages === 1 ? "" : "s"}; PDF ${version || "sin versión legible"}. El motor PDF estándar pudo interpretar ${maxPages === totalPages ? "todas las páginas" : `las primeras ${maxPages} páginas`}.`, severity: "pass", value: "INTERPRETABLE", scope: "rip" });

  if (!crossReference.hasEof || !crossReference.hasStartXref || !crossReference.xrefValid) {
    checks.push({ id: "xref", title: "Estructura de referencias PDF reparada o inválida", detail: "El visor tolerante pudo abrir el documento, pero falta o no coincide EOF/startxref/xref. Muchos RIP rechazan archivos que un visor común repara automáticamente. Reexporta o imprime a un PDF nuevo.", severity: "error", value: "REEXPORTAR", scope: "rip" });
  } else if (crossReference.trailingBytes > 1024) {
    checks.push({ id: "trailing", title: "Datos adicionales después del cierre PDF", detail: "Hay contenido significativo después de %%EOF. Puede ser una actualización válida, pero algunos intérpretes estrictos lo rechazan; conviene reexportar.", severity: "warning", value: "REVISAR", scope: "rip" });
  } else {
    checks.push({ id: "xref", title: "Tabla de referencias consistente", detail: "EOF, startxref y el destino de la tabla de referencias son coherentes.", severity: "pass", value: "CORRECTO", scope: "rip" });
  }

  const filterNames = new Set<string>();
  for (const match of inspectionText.matchAll(/\/Filter\s*\/([A-Za-z0-9]+)/g)) filterNames.add(match[1]);
  for (const match of inspectionText.matchAll(/\/Filter\s*\[([^\]]+)\]/g)) for (const name of match[1].matchAll(/\/([A-Za-z0-9]+)/g)) filterNames.add(name[1]);
  const knownFilters = new Set(["FlateDecode", "Fl", "DCTDecode", "DCT", "JPXDecode", "LZWDecode", "LZW", "ASCII85Decode", "A85", "ASCIIHexDecode", "AHx", "RunLengthDecode", "RL", "CCITTFaxDecode", "CCF", "JBIG2Decode", "Crypt"]);
  const unknownFilters = Array.from(filterNames).filter((name) => !knownFilters.has(name));
  if (unknownFilters.length) checks.push({ id: "filters", title: `Filtros PDF no estándar: ${unknownFilters.join(", ")}`, detail: "El archivo usa filtros de flujo fuera del conjunto PDF habitual. Reexporta con compresión ZIP/JPEG convencional antes de enviarlo al RIP.", severity: "error", value: "NO COMPATIBLE", scope: "rip" });

  if (imageCount === 0) {
    checks.push({ id: "ppi", title: "Arte vectorial: PPI no aplica", detail: "No se detectaron imágenes ráster colocadas. Los vectores y textos conservan resolución independiente.", severity: "pass", value: "Vectorial", scope: "quality" });
  } else if (ppiMin === null) {
    checks.push({ id: "ppi", title: "PPI efectivos no concluyentes", detail: `Se detectaron ${imageCount} imágenes, pero su transformación no permitió calcular el PPI real. Confírmalo en el preflight del RIP.`, severity: "warning", value: "REVISAR", scope: "quality" });
  } else if (ppiMin < 100) {
    checks.push({ id: "ppi", title: `Calidad insuficiente: mínimo ${ppiMin} ppp`, detail: `El archivo puede abrir en un RIP, pero al menos una imagen está por debajo de 100 ppp efectivos y puede pixelarse visiblemente. Objetivo: ${targetPpi} ppp.`, severity: "error", value: "CALIDAD NO APTA", scope: "quality" });
  } else if (ppiMin < targetPpi) {
    checks.push({ id: "ppi", title: `Resolución por debajo del objetivo: ${ppiMin}–${ppiMax} ppp`, detail: `Son PPI efectivos calculados con los píxeles y el tamaño real de colocación. Objetivo del trabajo: ${targetPpi} ppp.`, severity: "warning", value: `${ppiMin} ppp mín.`, scope: "quality" });
  } else {
    checks.push({ id: "ppi", title: `Resolución efectiva aprobada: ${ppiMin}–${ppiMax} ppp`, detail: `Todas las colocaciones calculables alcanzan el objetivo de ${targetPpi} ppp.`, severity: "pass", value: `${ppiMin} ppp mín.`, scope: "quality" });
  }

  checks.push({
    id: "profile",
    title: profileName === "No declarado" ? "Sin perfil ICC de salida declarado" : `Perfil detectado: ${profileName}`,
    detail: profileName === "No declarado" ? "El RIP deberá asignar explícitamente el perfil de impresora, tinta, papel y sustrato." : "El archivo trae una referencia de color. Confirma que coincida con el perfil de producción usado por el RIP.",
    severity: profileName === "No declarado" ? "warning" : "pass",
    value: profileName,
    scope: "quality",
  });

  checks.push({
    id: "color",
    title: colorSpaces.length ? `Espacios detectados: ${colorSpaces.join(" + ")}` : "Espacio de color no concluyente",
    detail: colorSpaces.includes("CMYK") ? (colorSpaces.includes("RGB") ? "El documento mezcla CMYK y RGB. El RIP realizará conversiones; revisa el resultado con el ICC correcto." : "Se detectó contenido CMYK.") : colorSpaces.includes("RGB") ? "Se detectó contenido RGB. Puede ripearse si la gestión de color convierte mediante el ICC de sublimación." : "La compresión interna impide confirmar todo el contenido de color.",
    severity: colorSpaces.length ? (colorSpaces.includes("CMYK") && colorSpaces.includes("RGB") ? "warning" : "pass") : "warning",
    value: colorSpaces.join(" · ") || "REVISAR",
    scope: "quality",
  });

  const rawFontCount = Array.from(raw.matchAll(/\/BaseFont\s*\//g)).length;
  const embeddedFontCount = Array.from(raw.matchAll(/\/FontFile\d?\s+/g)).length;
  if (pdfStructure.missingFontResources.length) {
    checks.push({
      id: "font-resources",
      title: `Referencias tipográficas rotas: ${pdfStructure.missingFontResources.join(", ")}`,
      detail: "El contenido intenta usar estas fuentes, pero no están declaradas en los recursos PDF. Los visores tolerantes pueden omitir el error; PhotoPRINT puede rechazar el archivo.",
      severity: "error",
      value: "NO APTO",
      scope: "rip",
    });
  } else if (contentText.match(/\/[^\s/<>{}\[\]()]+\s+[-+]?(?:\d*\.)?\d+\s+Tf\b/)) {
    checks.push({ id: "font-resources", title: "Recursos tipográficos coherentes", detail: "Las fuentes utilizadas por las instrucciones de texto están declaradas en los recursos del PDF.", severity: "pass", value: "CORRECTO", scope: "rip" });
  }
  checks.push({
    id: "fonts",
    title: hasText ? `${fontNames.size || rawFontCount} fuente${(fontNames.size || rawFontCount) === 1 ? "" : "s"} en texto` : "No contiene texto editable detectable",
    detail: hasText ? (rawFontCount > 0 && embeddedFontCount === 0 ? "Hay texto, pero no se localizaron datos de fuente incorporada. Incrusta las fuentes o convierte a curvas." : `Texto real detectado (${textCharacters.toLocaleString("es-UY")} caracteres).`) : "El contenido puede estar trazado o rasterizado; no habrá sustitución tipográfica, pero tampoco texto editable.",
    severity: hasText && rawFontCount > 0 && embeddedFontCount === 0 ? "warning" : "pass",
    value: hasText ? "SÍ TIENE TEXTO" : "SIN TEXTO",
    scope: hasText && rawFontCount > 0 && embeddedFontCount === 0 ? "rip" : "quality",
  });

  const transparency = /\/SMask\b|\/Group\s*<<[\s\S]{0,180}?\/S\s*\/Transparency\b|\/(?:ca|CA)\s+0?\.[0-9]+/i.test(inspectionText);
  checks.push({ id: "transparency", title: transparency ? "Transparencias detectadas" : "Sin transparencias detectables", detail: transparency ? "Máscaras, sombras y fusiones pueden fallar en RIP antiguos o con intérpretes PDF limitados. Aplana una copia o haz una prueba obligatoria." : "No se detectaron máscaras o grupos de transparencia en la estructura analizada.", severity: transparency ? "warning" : "pass", value: transparency ? "RIESGO RIP" : "CORRECTO", scope: "rip" });

  if (spotColors.length) checks.push({ id: "spots", title: `Tintas directas: ${spotColors.join(", ")}`, detail: "Un RIP puede rechazar o interpretar distinto DeviceN/Separation. Mapea estas tintas o conviértelas antes de producir.", severity: "warning", value: `${spotColors.length} detectada${spotColors.length === 1 ? "" : "s"}`, scope: "rip" });

  const hasXfa = /\/XFA\b/.test(inspectionText);
  const hasInteractive = /\/(?:RichMedia|3D|JavaScript|Launch|EmbeddedFile)\b/.test(inspectionText);
  const hasJpeg2000 = /\/JPXDecode\b/.test(inspectionText);
  const hasComplexBlend = /\/BM\s*\/(?!Normal\b)[A-Za-z]+/.test(inspectionText);
  const hasOverprint = /\/(?:OP|op)\s+true\b|\/OPM\s+[12]\b/.test(inspectionText);
  const isPdf2 = version !== null && Number(version) >= 2;

  if (hasXfa) checks.push({ id: "xfa", title: "Formulario XFA detectado", detail: "XFA no es contenido de página PDF convencional y puede no existir para el intérprete del RIP. Imprime o aplana el archivo a un PDF nuevo antes de producción.", severity: "error", value: "APLANAR", scope: "rip" });
  if (hasInteractive) checks.push({ id: "interactive", title: "Contenido interactivo o adjunto", detail: "Se detectaron elementos no orientados a impresión. El RIP puede ignorarlos o rechazar el documento; aplana una copia de producción.", severity: "warning", value: "RIESGO RIP", scope: "rip" });
  if (pdfStructure.layerState === "orphaned") checks.push({ id: "layers", title: `${pdfStructure.layerCount} capas OCG huérfanas`, detail: "El PDF contiene capas opcionales, pero el catálogo principal no tiene OCProperties para registrarlas. Esta inconsistencia fue confirmada en archivos rechazados por PhotoPRINT.", severity: "error", value: "NO APTO", scope: "rip" });
  else if (pdfStructure.layerState === "registered") checks.push({ id: "layers", title: `${pdfStructure.layerCount} capa${pdfStructure.layerCount === 1 ? "" : "s"} PDF correctamente registrada${pdfStructure.layerCount === 1 ? "" : "s"}`, detail: "Las capas OCG están declaradas en el catálogo del documento. Su sola presencia no impide el ripeo.", severity: "pass", value: "CORRECTO", scope: "rip" });
  else if (pdfStructure.layerState === "none") checks.push({ id: "layers", title: "Sin capas PDF opcionales", detail: "No se detectaron grupos de contenido opcional OCG; el contenido está aplanado respecto de capas PDF.", severity: "pass", value: "APLANADO", scope: "rip" });
  else checks.push({ id: "layers", title: "Registro de capas no concluyente", detail: "La estructura comprimida no permite confirmar el registro de todas las capas sin reescribir el documento.", severity: "info", value: "NO CONCLUYENTE", scope: "info" });
  if (pdfStructure.formXObjectCount > 10) checks.push({ id: "forms", title: `${pdfStructure.formXObjectCount} formularios gráficos internos`, detail: "No es un bloqueo por sí solo, pero explica una estructura más compleja que la versión aplanada y se incluye para comparar archivos similares.", severity: "info", value: `${pdfStructure.formXObjectCount} Form XObjects`, scope: "info" });
  if (pdfStructure.iccProfileCount > 1) checks.push({ id: "icc-duplicates", title: `${pdfStructure.iccProfileCount} referencias ICC internas`, detail: "El archivo repite perfiles de color en distintos recursos. No se rechaza solo por esto, pero aumenta el tamaño y la complejidad interna.", severity: "info", value: `${pdfStructure.iccProfileCount} ICC`, scope: "info" });
  if (hasJpeg2000) checks.push({ id: "jpx", title: "Imágenes JPEG 2000", detail: "El filtro JPXDecode no está soportado por todos los intérpretes RIP. Convierte esas imágenes a TIFF/ZIP o JPEG convencional si PhotoPRINT no abre el archivo.", severity: "warning", value: "COMPATIBILIDAD", scope: "rip" });
  if (hasComplexBlend) checks.push({ id: "blend", title: "Modos de fusión avanzados", detail: "Se detectaron modos distintos de Normal. La apariencia puede cambiar o fallar al rasterizar; prueba o aplana transparencias.", severity: "warning", value: "RIESGO RIP", scope: "rip" });
  if (hasOverprint) checks.push({ id: "overprint", title: "Sobreimpresión activa", detail: "La sobreimpresión puede producir un resultado diferente si el RIP no respeta la configuración. Verifica separaciones y simulación de sobreimpresión.", severity: "warning", value: "REVISAR", scope: "quality" });
  if (isPdf2) checks.push({ id: "pdf2", title: "Documento PDF 2.0", detail: "Algunos RIP instalados solo admiten PDF 1.7 o anterior. Exporta una copia PDF 1.6/1.7 si el archivo no ingresa.", severity: "warning", value: "COMPATIBILIDAD", scope: "rip" });

  if (totalPages > maxPages) checks.push({ id: "coverage", title: `Análisis detallado limitado a ${maxPages} páginas`, detail: `El archivo tiene ${totalPages} páginas. La interpretación estructural es válida, pero PPI y texto corresponden a las primeras ${maxPages}.`, severity: "info", value: `${maxPages}/${totalPages}`, scope: "info" });

  const ripErrors = checks.filter((check) => check.scope === "rip" && check.severity === "error").length;
  const ripWarnings = checks.filter((check) => check.scope === "rip" && check.severity === "warning").length;
  const qualityErrors = checks.filter((check) => check.scope === "quality" && check.severity === "error").length;
  const qualityWarnings = checks.filter((check) => check.scope === "quality" && check.severity === "warning").length;
  const status: Status = ripErrors ? "blocked" : ripWarnings ? "caution" : "ready";
  const qualityStatus: Status = qualityErrors ? "blocked" : qualityWarnings ? "caution" : "ready";

  await pdf.destroy();
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    status,
    qualityStatus,
    format: extension === "ai" ? "Illustrator · PDF compatible" : "PDF",
    pdfVersion: version,
    pages: totalPages,
    pagesAnalyzed: maxPages,
    dimensions: Array.from(dimensions).slice(0, 5),
    checks,
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

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function nearestSourceColor(colors: PdfSourceColor[], sampledHex: string) {
  const sampled = hexToRgb(sampledHex);
  if (!sampled) return null;
  let nearest: { color: PdfSourceColor; distance: number } | null = null;
  for (const color of colors) {
    const preview = hexToRgb(color.preview);
    if (!preview) continue;
    const distance = Math.sqrt(
      (sampled.r - preview.r) ** 2 +
      (sampled.g - preview.g) ** 2 +
      (sampled.b - preview.b) ** 2,
    );
    if (!nearest || distance < nearest.distance) nearest = { color, distance };
  }
  return nearest;
}

function sourceColorSummary(analysis: Analysis) {
  return analysis.sourceColors.length
    ? analysis.sourceColors.slice(0, 8).map((color) => `${color.space} ${sourceColorValues(color)}`).join(" / ")
    : "No extraíble desde operadores";
}

function qualityLabel(status: Status) {
  return status === "ready" ? "CALIDAD APROBADA" : status === "caution" ? "CALIDAD A REVISAR" : "CALIDAD INSUFICIENTE";
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
        analyzed.push({ file, analysis: emptyAnalysis(file, "", { id: "unexpected", title: "No se pudo completar el análisis", detail: "El archivo agotó la memoria disponible o contiene una estructura inesperada.", severity: "error", value: "NO APTO" }) });
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
        `${analysis.fileName} — Compatibilidad: ${statusLabel(analysis.status)} · ${qualityLabel(analysis.qualityStatus)}`,
        `Formato: ${analysis.format} · Páginas: ${analysis.pages ?? "—"} · Tamaño: ${analysis.dimensions.join(" / ") || "—"}`,
        `PPI reales: ${ppiLabel(analysis)} · Perfil: ${analysis.profileName}`,
        `Color: ${analysis.colorSpaces.join(" + ") || "No concluyente"} · Colores originales: ${sourceColorSummary(analysis)}`,
        `Texto: ${analysis.hasText ? `Sí, ${analysis.textCharacters} caracteres` : "No detectado"}`,
        ...analysis.checks.map((check) => `[${check.severity.toUpperCase()}] ${check.title}: ${check.detail}`),
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
            <p className="hero-lead">Carga uno o varios PDF/AI. RIPcheck calcula PPI efectivos, identifica perfiles, colores y texto, y compara las diferencias técnicas y visuales entre archivos.</p>
            <div className="trust-row"><span><b>01</b> PPI reales</span><span><b>02</b> Perfil y color</span><span><b>03</b> Comparación de archivos</span></div>
          </div>
          <div className="upload-panel">
            <div className="field-label"><span>Objetivo de resolución</span><span>300 ppp ideal</span></div>
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
            <div><p className="result-label">COMPATIBILIDAD DEL LOTE</p><h1>{batchStatus === "blocked" ? `${summary.blocked} archivo${summary.blocked === 1 ? " no es interpretable" : "s no son interpretables"}` : batchStatus === "caution" ? "Hay archivos que exigen prueba en RIP" : "Sin bloqueos RIP detectados"}</h1><p>{items.length} archivo{items.length === 1 ? "" : "s"} comparado{items.length === 1 ? "" : "s"}. La calidad se informa por separado para no confundir resolución/color con compatibilidad.</p></div>
            <div className="batch-counts"><span className="count-ready"><b>{summary.ready}</b>Aptos</span><span className="count-caution"><b>{summary.caution}</b>Con riesgo</span><span className="count-blocked"><b>{summary.blocked}</b>No aptos</span></div>
          </div>

          {working && <div className="inline-progress"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /><p>Analizando {progress.name} · {progress.done}/{progress.total}</p></div>}

          <nav className="file-tabs" aria-label="Archivos analizados">
            {items.map(({ analysis }) => <div className="file-tab-shell" key={analysis.id}><button className={selected?.analysis.id === analysis.id ? "file-tab active" : "file-tab"} onClick={() => setSelectedId(analysis.id)}><i className={analysis.status} /> <span>{analysis.fileName}</span><b>{ppiLabel(analysis)}</b></button><button className="file-remove" type="button" onClick={() => removeFile(analysis.id)} aria-label={`Eliminar ${analysis.fileName}`} title="Eliminar archivo">×</button></div>)}
          </nav>

          {selected && <FileDetail file={selected.file} analysis={selected.analysis} targetPpi={PROFILES[profile].dpi} />}
          {items.length > 1 && <Comparison items={items} />}

          <section className="rip-checklist"><div><p className="kicker">DECISIÓN DE PRODUCCIÓN</p><h2>Compatibilidad y calidad no son lo mismo</h2><p>Un archivo puede abrir en el RIP y tener mala resolución; también puede verse perfecto y contener capas, XFA o filtros que el RIP instalado no interpreta. Por eso ahora se informan por separado y sin puntuación artificial.</p></div><ol><li><span>1</span><div><b>Compatibilidad RIP</b><small>Estructura y funciones PDF de riesgo</small></div></li><li><span>2</span><div><b>Calidad de impresión</b><small>PPI, perfil, color y sobreimpresión</small></div></li><li><span>3</span><div><b>Espejo una sola vez</b><small>En el archivo o en el RIP</small></div></li><li><span>4</span><div><b>Prueba física</b><small>Confirma color y transferencia</small></div></li></ol></section>
          <p className="disclaimer">RIPcheck inspecciona los datos PDF reales en el navegador. La similitud visual compara la primera página; el PPI, texto y tamaños se analizan hasta 100 páginas por archivo.</p>
        </section>
      ) : null}
    </main>
  );
}

function FileDetail({ file, analysis, targetPpi }: { file: File; analysis: Analysis; targetPpi: number }) {
  const [selectedColorId, setSelectedColorId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [eyedropper, setEyedropper] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageRatio, setPageRatio] = useState(1 / 1.414);
  const [sampledPoint, setSampledPoint] = useState<{ analysisId: string; x: number; y: number; kind: PdfPaintRegion["kind"] | "empty"; objectId: string | null } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sampleImageRef = useRef<HTMLImageElement>(null);
  const activeColor = analysis.sourceColors.find((color) => color.id === selectedColorId) || null;
  const currentSample = sampledPoint?.analysisId === analysis.id ? sampledPoint : null;
  const changeZoom = (amount: number) => setZoom((current) => Math.min(4, Math.max(0.5, Number((current + amount).toFixed(2)))));

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
    setPdfUrl(url);
    setZoom(1);
    setEyedropper(false);
    setSelectedColorId(null);
    setSampledPoint(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const zoomWithWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const stage = stageRef.current;
    if (!stage || !pdfUrl) return;
    const next = Math.min(4, Math.max(0.5, Number((zoom + (event.deltaY < 0 ? 0.15 : -0.15)).toFixed(2))));
    if (next === zoom) return;
    const bounds = stage.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const contentX = stage.scrollLeft + localX;
    const contentY = stage.scrollTop + localY;
    const ratio = next / zoom;
    setZoom(next);
    requestAnimationFrame(() => {
      stage.scrollLeft = contentX * ratio - localX;
      stage.scrollTop = contentY * ratio - localY;
    });
  };

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
  const selectEmptyPoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!eyedropper) return;
    const { x, y } = sampledCoordinates(event);
    setSelectedColorId(null);
    setSampledPoint({ analysisId: analysis.id, x, y, kind: "empty", objectId: null });
  };
  const groups = {
    ripErrors: analysis.checks.filter((check) => check.scope === "rip" && check.severity === "error"),
    ripWarnings: analysis.checks.filter((check) => check.scope === "rip" && check.severity === "warning"),
    quality: analysis.checks.filter((check) => check.scope === "quality" && (check.severity === "error" || check.severity === "warning")),
    information: analysis.checks.filter((check) => check.severity === "info"),
    passes: analysis.checks.filter((check) => check.severity === "pass"),
  };
  return <section className="file-detail">
    <div className="visual-column">
      <div className="detail-heading"><span>Vista vectorial · PDF original</span><small>{analysis.dimensions[0] || "Sin tamaño"}</small></div>
      <div className="preview-toolbar" aria-label="Controles de la vista real"><span>Rueda del mouse sobre la vista para acercar o alejar</span><button type="button" onClick={() => changeZoom(-0.25)} disabled={zoom <= 0.5} aria-label="Alejar">−</button><button className="zoom-value" type="button" onClick={() => setZoom(1)} title="Volver al 100%">{Math.round(zoom * 100)}%</button><button type="button" onClick={() => changeZoom(0.25)} disabled={zoom >= 4} aria-label="Acercar">+</button></div>
      <div ref={stageRef} className={eyedropper ? "thumb-stage eyedropper-active" : "thumb-stage"} onWheel={zoomWithWheel}>{pdfUrl && analysis.thumbnail ? <div className="vector-surface" style={{ width: `${zoom * 100}%`, aspectRatio: `${pageRatio}` }}><object className="vector-object" data={`${pdfUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`} type="application/pdf" aria-label={`Vista vectorial original de ${analysis.fileName}`}><img src={analysis.thumbnail} alt={`Primera página de ${analysis.fileName}`} /></object><svg className={eyedropper ? "vector-object-map active" : "vector-object-map"} viewBox="0 0 1 1" preserveAspectRatio="none" onClick={selectEmptyPoint} aria-label={eyedropper ? `${analysis.paintRegions.length} objetos seleccionables en la primera página` : "Mapa de objetos vectoriales"}>{analysis.paintRegions.map((object) => <path key={object.id} className={`vector-hit ${object.paint} ${currentSample?.objectId === object.id ? "selected" : ""}`} d={object.d} fill={object.paint === "fill" ? "rgba(0,0,0,.001)" : "none"} fillRule={object.fillRule} stroke={object.paint === "stroke" ? "rgba(0,0,0,.001)" : "none"} strokeWidth={Math.max(object.strokeWidth, 0.004)} onClick={(event) => selectVectorObject(event, object)}><title>{object.kind === "raster" ? "Imagen ráster" : object.kind === "text" ? "Objeto de texto" : "Trazado vectorial"}</title></path>)}</svg>{currentSample && <span className="sample-marker" style={{ left: `${currentSample.x * 100}%`, top: `${currentSample.y * 100}%` }} aria-hidden="true" />}</div> : <div className="preview-fallback invalid"><span>AI</span><p>Sin representación vectorial PDF compatible.</p></div>}</div>
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
      <div className="status-pair"><div className={`single-status ${analysis.status}`}><span>COMPATIBILIDAD RIP</span><b>{statusLabel(analysis.status)}</b></div><div className={`single-status quality ${analysis.qualityStatus}`}><span>CALIDAD DE IMPRESIÓN</span><b>{qualityLabel(analysis.qualityStatus)}</b></div></div>
      <div className="metric-grid">
        <Metric label="PPI EFECTIVOS" value={ppiLabel(analysis)} hint={`Objetivo ${targetPpi} ppp`} tone={analysis.ppiMin !== null && analysis.ppiMin < 100 ? "bad" : analysis.ppiMin !== null && analysis.ppiMin < targetPpi ? "warn" : "good"} />
        <Metric label="PERFIL DEL ARCHIVO" value={analysis.profileName} hint="ICC / intención de salida" />
        <Metric label="COLOR" value={analysis.colorSpaces.join(" + ") || "No concluyente"} hint={analysis.colorSpaces.includes("CMYK") ? "CMYK detectado" : "Sin CMYK detectable"} />
        <Metric label="TEXTO" value={analysis.hasText ? "Sí contiene" : "No detectado"} hint={analysis.hasText ? `${analysis.textCharacters.toLocaleString("es-UY")} caracteres` : "Puede estar trazado"} />
        <Metric label="PÁGINAS" value={String(analysis.pages ?? "—")} hint={analysis.dimensions.join(" · ") || "Sin tamaño legible"} />
        <Metric label="IMÁGENES RÁSTER" value={String(analysis.imageCount)} hint={`${analysis.ppiPlacements} colocaciones medibles`} />
        <Metric label="CAPAS PDF" value={layerLabel(analysis)} hint="Registro OCG del documento" tone={analysis.layerState === "orphaned" ? "bad" : analysis.layerState === "unknown" ? "warn" : "good"} />
        <Metric label="RECURSOS INTERNOS" value={resourceIntegrityLabel(analysis)} hint={`${analysis.formXObjectCount} formularios · ${analysis.iccProfileCount} ICC`} tone={analysis.missingFontResources.length ? "bad" : "good"} />
      </div>
      {analysis.spotColors.length > 0 && <div className="spot-line"><span>Tintas directas</span><b>{analysis.spotColors.join(" · ")}</b></div>}
      {analysis.hasText && <div className="text-sample"><span>TEXTO DETECTADO</span><p>{analysis.textPreview || "Texto presente sin contenido extraíble."}</p><small>{analysis.fontNames.length ? `Fuentes: ${analysis.fontNames.join(", ")}` : "Fuentes sin nombre legible"}</small></div>}
      <div className="checklist compact">{groups.ripErrors.length > 0 && <CheckGroup title="Bloqueos de compatibilidad RIP" checks={groups.ripErrors} tone="error" />}{groups.ripWarnings.length > 0 && <CheckGroup title="Riesgos que exigen prueba en RIP" checks={groups.ripWarnings} tone="warning" />}{groups.quality.length > 0 && <CheckGroup title="Problemas de calidad de impresión" checks={groups.quality} tone={groups.quality.some((check) => check.severity === "error") ? "error" : "warning"} />}{groups.information.length > 0 && <CheckGroup title="Alcance del análisis" checks={groups.information} tone="warning" />}{groups.passes.length > 0 && <CheckGroup title="Controles aprobados" checks={groups.passes} tone="pass" />}</div>
    </div>
  </section>;
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "good" | "warn" | "bad" }) {
  return <div className={`metric ${tone || ""}`}><span>{label}</span><b>{value}</b><small>{hint}</small></div>;
}

function Comparison({ items }: { items: BatchItem[] }) {
  const base = items[0].analysis;
  const rows = [
    { label: "Compatibilidad RIP", get: (a: Analysis) => statusLabel(a.status) },
    { label: "Calidad de impresión", get: (a: Analysis) => qualityLabel(a.qualityStatus) },
    { label: "PPI reales", get: ppiLabel },
    { label: "Perfil ICC", get: (a: Analysis) => a.profileName },
    { label: "Espacios de color", get: (a: Analysis) => a.colorSpaces.join(" + ") || "No concluyente" },
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

function CheckGroup({ title, checks, tone }: { title: string; checks: Check[]; tone: "error" | "warning" | "pass" }) {
  const [open, setOpen] = useState(tone !== "pass");
  return <section className={`check-group ${tone}`}><button className="group-title" onClick={() => setOpen(!open)} aria-expanded={open}><span><i>{tone === "error" ? "×" : tone === "warning" ? "!" : "✓"}</i>{title}<b>{checks.length}</b></span><em>{open ? "−" : "+"}</em></button>{open && <div className="check-items">{checks.map((check) => <article className="check-item" key={check.id}><span className="check-dot">{check.severity === "error" ? "×" : check.severity === "pass" ? "✓" : check.severity === "info" ? "i" : "!"}</span><div><h3>{check.title}</h3><p>{check.detail}</p></div>{check.value && <small>{check.value}</small>}</article>)}</div>}</section>;
}
