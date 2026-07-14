"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Severity = "pass" | "warning" | "error" | "info";
type Status = "ready" | "caution" | "blocked";
type Matrix = [number, number, number, number, number, number];
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type Check = { id: string; title: string; detail: string; severity: Severity; value?: string; scope?: "rip" | "quality" | "info" };
type Metadata = { title: string; author: string; creator: string; producer: string; created: string };

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

function decodeAscii85(source: Uint8Array) {
  const input = new TextDecoder("latin1").decode(source).replace(/\s+/g, "").replace(/^<~/, "").replace(/~>[\s\S]*$/, "");
  const output: number[] = [];
  let group: number[] = [];
  const flush = (final = false) => {
    if (!group.length) return;
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const decoded = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    output.push(...decoded.slice(0, final ? Math.max(0, originalLength - 1) : 4));
    group = [];
  };
  for (const character of input) {
    if (character === "z" && group.length === 0) output.push(0, 0, 0, 0);
    else {
      const digit = character.charCodeAt(0) - 33;
      if (digit < 0 || digit > 84) continue;
      group.push(digit);
      if (group.length === 5) flush();
    }
  }
  flush(true);
  return new Uint8Array(output);
}

async function decodedContentStreams(bytes: Uint8Array, raw: string) {
  if (bytes.byteLength > 80 * 1024 * 1024) return "";
  const decoder = new TextDecoder("latin1");
  const parts: string[] = [];
  const streamPattern = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  let inspected = 0;
  while ((match = streamPattern.exec(raw)) && inspected < 250) {
    const start = match.index + match[0].length;
    const dictionary = raw.slice(Math.max(0, match.index - 1400), match.index);
    if (/\/Subtype\s*\/Image|\/FontFile\d?\b|\/DestOutputProfile\b/.test(dictionary)) continue;
    const endMarker = raw.indexOf("endstream", start);
    if (endMarker < 0) continue;
    const directLength = dictionary.match(/\/Length\s+(\d+)\s*(?:>>|\/)/)?.[1];
    const end = directLength ? Math.min(bytes.length, start + Number(directLength)) : endMarker;
    if (end <= start || end - start > 8 * 1024 * 1024) continue;
    inspected += 1;
    let source = bytes.slice(start, end);
    try {
      if (/\/ASCII85Decode\b/.test(dictionary)) source = decodeAscii85(source);
      if (/\/FlateDecode\b/.test(dictionary) && typeof DecompressionStream !== "undefined") {
        const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream("deflate"));
        const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
        parts.push(decoder.decode(inflated));
      } else if ((!/\/Filter\b/.test(dictionary) || /\/ASCII85Decode\b/.test(dictionary)) && source.length < 1024 * 1024) {
        parts.push(decoder.decode(source));
      }
    } catch {
      // A stream can combine filters or use an indirect length. PDF.js still analyzes it.
    }
  }
  return parts.join("\n");
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

function detectProfile(text: string) {
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
  const profileName = detectProfile(raw);
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
  const hasLayers = /\/OCProperties\b|\/Type\s*\/OCG\b/.test(inspectionText);
  const hasJpeg2000 = /\/JPXDecode\b/.test(inspectionText);
  const hasComplexBlend = /\/BM\s*\/(?!Normal\b)[A-Za-z]+/.test(inspectionText);
  const hasOverprint = /\/(?:OP|op)\s+true\b|\/OPM\s+[12]\b/.test(inspectionText);
  const isPdf2 = version !== null && Number(version) >= 2;

  if (hasXfa) checks.push({ id: "xfa", title: "Formulario XFA detectado", detail: "XFA no es contenido de página PDF convencional y puede no existir para el intérprete del RIP. Imprime o aplana el archivo a un PDF nuevo antes de producción.", severity: "error", value: "APLANAR", scope: "rip" });
  if (hasInteractive) checks.push({ id: "interactive", title: "Contenido interactivo o adjunto", detail: "Se detectaron elementos no orientados a impresión. El RIP puede ignorarlos o rechazar el documento; aplana una copia de producción.", severity: "warning", value: "RIESGO RIP", scope: "rip" });
  if (hasLayers) checks.push({ id: "layers", title: "Capas PDF opcionales", detail: "El resultado depende del estado de visibilidad de las capas. Aplana una copia para asegurar que el RIP reciba exactamente lo visible.", severity: "warning", value: "APLANAR", scope: "rip" });
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
    thumbnail,
    visualHash,
    fileHash,
    analyzedAt: new Date().toISOString(),
  };
}

function statusLabel(status: Status) {
  return status === "ready" ? "APTO PROBABLE PARA RIP" : status === "caution" ? "PRUEBA RIP OBLIGATORIA" : "NO APTO PARA RIP";
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
        `Color: ${analysis.colorSpaces.join(" + ") || "No concluyente"} · Colores visuales: ${analysis.dominantColors.join(", ") || "—"}`,
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
            <div className="batch-counts"><span className="count-ready"><b>{summary.ready}</b>Aptos probables</span><span className="count-caution"><b>{summary.caution}</b>Prueba obligatoria</span><span className="count-blocked"><b>{summary.blocked}</b>No aptos</span></div>
          </div>

          {working && <div className="inline-progress"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /><p>Analizando {progress.name} · {progress.done}/{progress.total}</p></div>}

          <nav className="file-tabs" aria-label="Archivos analizados">
            {items.map(({ analysis }) => <button key={analysis.id} className={selected?.analysis.id === analysis.id ? "file-tab active" : "file-tab"} onClick={() => setSelectedId(analysis.id)}><i className={analysis.status} /> <span>{analysis.fileName}</span><b>{ppiLabel(analysis)}</b></button>)}
          </nav>

          {selected && <FileDetail analysis={selected.analysis} targetPpi={PROFILES[profile].dpi} />}
          {items.length > 1 && <Comparison items={items} />}

          <section className="rip-checklist"><div><p className="kicker">DECISIÓN DE PRODUCCIÓN</p><h2>Compatibilidad y calidad no son lo mismo</h2><p>Un archivo puede abrir en el RIP y tener mala resolución; también puede verse perfecto y contener capas, XFA o filtros que el RIP instalado no interpreta. Por eso ahora se informan por separado y sin puntuación artificial.</p></div><ol><li><span>1</span><div><b>Compatibilidad RIP</b><small>Estructura y funciones PDF de riesgo</small></div></li><li><span>2</span><div><b>Calidad de impresión</b><small>PPI, perfil, color y sobreimpresión</small></div></li><li><span>3</span><div><b>Espejo una sola vez</b><small>En el archivo o en el RIP</small></div></li><li><span>4</span><div><b>Prueba física</b><small>Confirma color y transferencia</small></div></li></ol></section>
          <p className="disclaimer">RIPcheck inspecciona los datos PDF reales en el navegador. La similitud visual compara la primera página; el PPI, texto y tamaños se analizan hasta 100 páginas por archivo.</p>
        </section>
      ) : null}
    </main>
  );
}

function FileDetail({ analysis, targetPpi }: { analysis: Analysis; targetPpi: number }) {
  const groups = {
    ripErrors: analysis.checks.filter((check) => check.scope === "rip" && check.severity === "error"),
    ripWarnings: analysis.checks.filter((check) => check.scope === "rip" && check.severity === "warning"),
    quality: analysis.checks.filter((check) => check.scope === "quality" && (check.severity === "error" || check.severity === "warning")),
    information: analysis.checks.filter((check) => check.severity === "info"),
    passes: analysis.checks.filter((check) => check.severity === "pass"),
  };
  return <section className="file-detail">
    <div className="visual-column">
      <div className="detail-heading"><span>Vista real · primera página</span><small>{analysis.dimensions[0] || "Sin tamaño"}</small></div>
      <div className="thumb-stage">{analysis.thumbnail ? <img src={analysis.thumbnail} alt={`Primera página de ${analysis.fileName}`} /> : <div className="preview-fallback invalid"><span>AI</span><p>Sin representación visual compatible.</p></div>}</div>
      <div className="color-readout"><span>COLORES VISUALES DETECTADOS</span><div>{analysis.dominantColors.length ? analysis.dominantColors.map((color) => <i key={color} style={{ backgroundColor: color }} title={color} />) : <small>No concluyente</small>}</div><small>Colores dominantes renderizados de la primera página</small></div>
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
    { label: "Colores dominantes", get: (a: Analysis) => a.dominantColors.join(" · ") || "—" },
    { label: "Texto", get: (a: Analysis) => a.hasText ? `Sí · ${a.textCharacters} caracteres` : "No detectado" },
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
