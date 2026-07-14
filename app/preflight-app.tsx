"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Severity = "pass" | "warning" | "error" | "info";
type Status = "ready" | "caution" | "blocked";

type Check = {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  value?: string;
};

type Analysis = {
  fileName: string;
  fileSize: number;
  status: Status;
  score: number;
  format: string;
  pdfVersion: string | null;
  pages: number | null;
  dimensions: string[];
  checks: Check[];
  colors: string[];
  fontNames: string[];
  imageCount: number;
  sampled: boolean;
  analyzedAt: string;
};

const PROFILES = {
  textile: { name: "Textil / indumentaria", dpi: 150, note: "Equilibrio entre detalle y archivos de gran tamaño." },
  rigid: { name: "Rígidos / detalle fino", dpi: 200, note: "Para piezas pequeñas vistas a corta distancia." },
  grand: { name: "Gran formato", dpi: 100, note: "Para piezas grandes vistas a mayor distancia." },
} as const;

type ProfileKey = keyof typeof PROFILES;

const mm = (points: number) => (points * 25.4) / 72;
const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

function countMatches(text: string, pattern: RegExp) {
  return Array.from(text.matchAll(pattern)).length;
}

function uniqueMatches(text: string, pattern: RegExp, limit = 20) {
  const values = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const cleaned = (match[1] || "").replace(/^[A-Z]{6}\+/, "").replace(/[#_]/g, " ").trim();
    if (cleaned) values.add(cleaned);
    if (values.size >= limit) break;
  }
  return Array.from(values);
}

async function readPdfText(file: File) {
  const fullReadLimit = 80 * 1024 * 1024;
  if (file.size <= fullReadLimit) {
    const buffer = await file.arrayBuffer();
    return { text: new TextDecoder("latin1").decode(buffer), sampled: false };
  }

  const head = await file.slice(0, 48 * 1024 * 1024).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - 12 * 1024 * 1024)).arrayBuffer();
  const decoder = new TextDecoder("latin1");
  return { text: `${decoder.decode(head)}\n${decoder.decode(tail)}`, sampled: true };
}

async function analyzeFile(file: File): Promise<Analysis> {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const { text, sampled } = await readPdfText(file);
  const startsAsPdf = /^%PDF-/.test(text.slice(0, 16));
  const version = text.slice(0, 32).match(/%PDF-(\d\.\d)/)?.[1] || null;
  const checks: Check[] = [];

  if (!startsAsPdf) {
    checks.push({
      id: "structure",
      title: extension === "ai" ? "AI sin contenido PDF compatible" : "Estructura PDF no reconocida",
      detail:
        extension === "ai"
          ? "Vuelve a guardar desde Illustrator con “Crear archivo compatible con PDF”. Un RIP no puede interpretar de forma confiable este AI nativo."
          : "El encabezado del archivo no corresponde a un PDF válido. Puede estar dañado o tener una extensión incorrecta.",
      severity: "error",
      value: "Bloqueante",
    });

    return {
      fileName: file.name,
      fileSize: file.size,
      status: "blocked",
      score: 18,
      format: extension === "ai" ? "Adobe Illustrator nativo" : extension.toUpperCase() || "Desconocido",
      pdfVersion: null,
      pages: null,
      dimensions: [],
      checks,
      colors: [],
      fontNames: [],
      imageCount: 0,
      sampled,
      analyzedAt: new Date().toISOString(),
    };
  }

  checks.push({
    id: "structure",
    title: extension === "ai" ? "AI compatible con PDF" : "PDF reconocido",
    detail: extension === "ai" ? "El archivo contiene una representación PDF que puede ser procesada por un RIP moderno." : "La firma y estructura base del documento son reconocibles.",
    severity: "pass",
    value: version ? `PDF ${version}` : "Correcto",
  });

  const encrypted = /\/Encrypt\b/.test(text);
  checks.push({
    id: "security",
    title: encrypted ? "Documento protegido" : "Sin bloqueo de seguridad",
    detail: encrypted ? "Quita la contraseña o las restricciones antes de enviarlo a producción." : "No se detectó cifrado que impida el procesamiento.",
    severity: encrypted ? "error" : "pass",
    value: encrypted ? "Bloqueante" : "Correcto",
  });

  const hasEof = /%%EOF/.test(text.slice(-16384));
  checks.push({
    id: "integrity",
    title: hasEof ? "Cierre de archivo correcto" : "Cierre PDF no localizado",
    detail: hasEof ? "El documento incluye su marcador de finalización." : "El archivo puede estar incompleto o usar una estructura que requiere validación adicional.",
    severity: hasEof ? "pass" : "warning",
    value: hasEof ? "Íntegro" : "Revisar",
  });

  const pageMatches = countMatches(text, /\/Type\s*\/Page(?!s)\b/g);
  const pagesTreeCount = Array.from(text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,300}?\/Count\s+(\d+)/g)).map((m) => Number(m[1]));
  const pages = pageMatches || (pagesTreeCount.length ? Math.max(...pagesTreeCount) : null);

  const boxes = Array.from(text.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g));
  const dimensionSet = new Set<string>();
  for (const box of boxes) {
    const width = Math.abs(Number(box[3]) - Number(box[1]));
    const height = Math.abs(Number(box[4]) - Number(box[2]));
    if (width && height) dimensionSet.add(`${mm(width).toFixed(1)} × ${mm(height).toFixed(1)} mm`);
    if (dimensionSet.size === 4) break;
  }
  const dimensions = Array.from(dimensionSet);
  checks.push({
    id: "pages",
    title: pages ? `${pages} ${pages === 1 ? "página detectada" : "páginas detectadas"}` : "Cantidad de páginas no concluyente",
    detail: dimensions.length ? `Tamaño de página: ${dimensions.join(" · ")}. Confirma que coincida con el tamaño final de producción.` : "El tamaño de página no está expuesto en la estructura legible; confírmalo en el RIP.",
    severity: pages && dimensions.length ? "pass" : "warning",
    value: dimensions[0] || "Revisar",
  });

  const hasTrimBox = /\/TrimBox\s*\[/.test(text);
  const hasBleedBox = /\/BleedBox\s*\[/.test(text);
  checks.push({
    id: "boxes",
    title: hasTrimBox ? "Caja de corte definida" : "Sin caja de corte explícita",
    detail: hasTrimBox
      ? hasBleedBox
        ? "Se detectaron TrimBox y BleedBox para delimitar corte y sangrado."
        : "Hay TrimBox, pero no BleedBox. Si la pieza llega al borde, confirma el sangrado necesario."
      : "Para trabajos a sangre o con corte, define TrimBox/BleedBox o confirma manualmente el área final.",
    severity: hasTrimBox && hasBleedBox ? "pass" : "warning",
    value: hasBleedBox ? "Corte + sangrado" : "Revisar",
  });

  const colors: string[] = [];
  if (/\/DeviceRGB\b/.test(text)) colors.push("RGB");
  if (/\/DeviceCMYK\b/.test(text)) colors.push("CMYK");
  if (/\/DeviceGray\b/.test(text)) colors.push("Grises");
  if (/\/ICCBased\b/.test(text)) colors.push("ICC");
  if (/\/(?:Separation|DeviceN)\b/.test(text)) colors.push("Tintas directas");
  const hasOutputIntent = /\/OutputIntents?\b/.test(text);
  const pdfx = text.match(/\/GTS_PDFXVersion\s*\(([^)]+)\)/)?.[1];
  checks.push({
    id: "color",
    title: hasOutputIntent ? "Intención de salida incorporada" : "Sin intención de salida detectable",
    detail: hasOutputIntent
      ? `El PDF declara una condición de salida${pdfx ? ` (${pdfx})` : ""}. El RIP aún debe usar el ICC específico de impresora, tinta, papel y sustrato.`
      : `Se detectó ${colors.length ? colors.join(", ") : "un espacio de color no concluyente"}. Asigna en el RIP el perfil ICC correcto para tu combinación de producción.`,
    severity: hasOutputIntent ? "pass" : "warning",
    value: colors.join(" + ") || "No concluyente",
  });

  const fontNames = uniqueMatches(text, /\/BaseFont\s*\/([^\s/<>{}\[\]()]+)/g);
  const fontReferences = countMatches(text, /\/BaseFont\s*\//g);
  const embeddedReferences = countMatches(text, /\/FontFile\d?\s+/g);
  const usesFonts = fontReferences > 0;
  const fontScanConclusive = usesFonts && !/\/ObjStm\b/.test(text);
  const fontsLikelyEmbedded = !usesFonts || (embeddedReferences > 0 && embeddedReferences >= Math.min(fontReferences, fontNames.length || fontReferences));
  checks.push({
    id: "fonts",
    title: !usesFonts ? "Sin fuentes detectables" : fontsLikelyEmbedded ? "Fuentes incorporadas" : "Fuentes por verificar",
    detail: !usesFonts
      ? "El contenido puede estar trazado, rasterizado o usar una estructura comprimida."
      : fontsLikelyEmbedded
        ? `Se localizaron datos de fuente incorporados${fontNames.length ? `: ${fontNames.slice(0, 4).join(", ")}` : ""}.`
        : fontScanConclusive
          ? "Hay referencias tipográficas sin datos de fuente claramente incorporados. Convierte a curvas o incrusta todas las fuentes."
          : "La estructura comprimida no permite confirmar todas las fuentes en este análisis rápido; revísalas en un preflight profesional.",
    severity: !usesFonts || fontsLikelyEmbedded ? "pass" : "warning",
    value: usesFonts ? `${fontNames.length || fontReferences} detectada${(fontNames.length || fontReferences) === 1 ? "" : "s"}` : "No aplica",
  });

  const imageCount = countMatches(text, /\/Subtype\s*\/Image\b/g);
  const imageSizes = Array.from(text.matchAll(/\/Subtype\s*\/Image\b[\s\S]{0,500}?\/Width\s+(\d+)[\s\S]{0,200}?\/Height\s+(\d+)/g)).map((m) => `${m[1]}×${m[2]} px`);
  checks.push({
    id: "resolution",
    title: imageCount ? "Resolución efectiva por confirmar" : "Arte principalmente vectorial o comprimido",
    detail: imageCount
      ? `Se detectaron ${imageCount} imagen${imageCount === 1 ? "" : "es"}${imageSizes.length ? ` (${Array.from(new Set(imageSizes)).slice(0, 3).join(", ")})` : ""}. La resolución efectiva depende de la escala colocada; confírmala contra el objetivo del trabajo.`
      : "No se detectaron imágenes ráster en la estructura legible. Si el documento usa objetos comprimidos, valida igualmente al tamaño final.",
    severity: imageCount ? "warning" : "pass",
    value: imageCount ? `${imageCount} ráster` : "Sin alerta",
  });

  const transparency = /\/SMask\b|\/Group\s*<<[\s\S]{0,160}?\/S\s*\/Transparency\b|\/(?:ca|CA)\s+0?\.[0-9]+/i.test(text);
  checks.push({
    id: "transparency",
    title: transparency ? "Transparencias detectadas" : "Sin transparencias detectables",
    detail: transparency ? "Realiza una prueba de rasterizado en el RIP. Versiones o configuraciones antiguas pueden interpretar distinto máscaras, sombras o modos de fusión." : "No aparecen máscaras o grupos de transparencia en la estructura legible.",
    severity: transparency ? "warning" : "pass",
    value: transparency ? "Prueba requerida" : "Correcto",
  });

  const spot = /\/(?:Separation|DeviceN)\b/.test(text);
  checks.push({
    id: "spots",
    title: spot ? "Tintas directas / DeviceN" : "Sin tintas directas detectables",
    detail: spot ? "Confirma que el RIP convierta estas tintas mediante el perfil correcto o conviértelas al espacio de trabajo acordado." : "No se detectaron separaciones especiales que requieran mapeo adicional.",
    severity: spot ? "warning" : "pass",
    value: spot ? "Mapear en RIP" : "Correcto",
  });

  if (sampled) {
    checks.push({
      id: "sampling",
      title: "Archivo grande: análisis por muestreo",
      detail: "Para proteger la memoria del equipo se inspeccionaron el inicio y el final del archivo. Realiza además el preflight completo del RIP.",
      severity: "info",
      value: formatBytes(file.size),
    });
  }

  const errors = checks.filter((check) => check.severity === "error").length;
  const warnings = checks.filter((check) => check.severity === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - errors * 45 - warnings * 7 - (sampled ? 4 : 0)));
  const status: Status = errors ? "blocked" : warnings ? "caution" : "ready";

  return {
    fileName: file.name,
    fileSize: file.size,
    status,
    score,
    format: extension === "ai" ? "Illustrator PDF compatible" : `PDF${pdfx ? ` · ${pdfx}` : ""}`,
    pdfVersion: version,
    pages,
    dimensions,
    checks,
    colors,
    fontNames,
    imageCount,
    sampled,
    analyzedAt: new Date().toISOString(),
  };
}

function statusCopy(status: Status) {
  if (status === "ready") return { eyebrow: "APTO", title: "Listo para prueba en RIP", text: "No encontramos alertas técnicas en el análisis automatizado." };
  if (status === "caution") return { eyebrow: "APTO CON ADVERTENCIAS", title: "Puede continuar con controles", text: "No hay bloqueos, pero debes confirmar los puntos marcados antes de producir." };
  return { eyebrow: "NO APTO", title: "Corrige el archivo antes de ripear", text: "Hay al menos un problema que puede impedir o alterar la salida." };
}

export function PreflightApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<ProfileKey>("textile");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const grouped = useMemo(() => {
    if (!analysis) return { errors: [], warnings: [], passes: [] };
    return {
      errors: analysis.checks.filter((c) => c.severity === "error"),
      warnings: analysis.checks.filter((c) => c.severity === "warning" || c.severity === "info"),
      passes: analysis.checks.filter((c) => c.severity === "pass"),
    };
  }, [analysis]);

  async function processFile(file?: File) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["pdf", "ai"].includes(extension)) {
      setError("Selecciona un archivo PDF o AI.");
      return;
    }

    setWorking(true);
    setError(null);
    setAnalysis(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const blobUrl = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
    setPreviewUrl(blobUrl);
    try {
      const result = await analyzeFile(file);
      setAnalysis(result);
    } catch {
      setError("No pudimos leer el archivo. Comprueba que no esté dañado e inténtalo nuevamente.");
      URL.revokeObjectURL(blobUrl);
      setPreviewUrl(null);
    } finally {
      setWorking(false);
    }
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    void processFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void processFile(event.dataTransfer.files?.[0]);
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setAnalysis(null);
    setError(null);
  }

  function exportReport() {
    if (!analysis) return;
    const result = statusCopy(analysis.status);
    const lines = [
      "RIPCHECK — INFORME DE PREFLIGHT",
      "================================",
      `Resultado: ${result.eyebrow}`,
      `Archivo: ${analysis.fileName}`,
      `Tamaño: ${formatBytes(analysis.fileSize)}`,
      `Formato: ${analysis.format}`,
      `Perfil de trabajo: ${PROFILES[profile].name} · objetivo ${PROFILES[profile].dpi} ppp efectivos`,
      `Fecha: ${new Date(analysis.analyzedAt).toLocaleString("es-UY")}`,
      "",
      ...analysis.checks.map((check) => `[${check.severity.toUpperCase()}] ${check.title}\n${check.detail}`),
      "",
      "CONTROL FINAL EN RIP",
      "- Seleccionar ICC específico de impresora, tinta, papel y sustrato.",
      "- Confirmar tamaño, escala y orientación.",
      "- Activar espejo una sola vez para sublimación.",
      `- Confirmar imágenes a ${PROFILES[profile].dpi} ppp efectivos o más al tamaño final.`,
      "- Imprimir una tira de prueba antes de producción.",
      "",
      "Este informe es un preflight preventivo y no reemplaza la prueba en el RIP ni la calibración del equipo.",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${analysis.fileName.replace(/\.[^.]+$/, "")}-preflight.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="RIPcheck, inicio">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>RIP<span>check</span></span>
        </a>
        <div className="topbar-note"><span className="pulse" /> Análisis local · tu archivo no se sube</div>
      </header>

      {!analysis && !working ? (
        <section className="landing" id="inicio">
          <div className="hero-copy">
            <p className="kicker">PREFLIGHT PARA SUBLIMACIÓN</p>
            <h1>Antes de imprimir,<br /><em>verifica.</em></h1>
            <p className="hero-lead">Detecta problemas de estructura, color, fuentes, imágenes y transparencias antes de enviar el trabajo a un RIP tipo PhotoPRINT.</p>
            <div className="trust-row">
              <span><b>01</b> Sin instalar Illustrator</span>
              <span><b>02</b> Sin subir archivos</span>
              <span><b>03</b> Informe explicativo</span>
            </div>
          </div>

          <div className="upload-panel">
            <div className="field-label"><span>Perfil del trabajo</span><span>Objetivo orientativo</span></div>
            <div className="profile-grid" role="radiogroup" aria-label="Perfil del trabajo">
              {(Object.keys(PROFILES) as ProfileKey[]).map((key) => (
                <button key={key} className={profile === key ? "profile active" : "profile"} onClick={() => setProfile(key)} role="radio" aria-checked={profile === key}>
                  <span>{PROFILES[key].name}</span><b>{PROFILES[key].dpi} ppp</b>
                </button>
              ))}
            </div>
            <p className="profile-note">{PROFILES[profile].note}</p>

            <div className={dragging ? "dropzone dragging" : "dropzone"} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}>
              <input ref={inputRef} type="file" accept=".pdf,.ai,application/pdf,application/postscript" onChange={onInput} hidden />
              <span className="upload-icon" aria-hidden="true">↥</span>
              <h2>Suelta tu archivo aquí</h2>
              <p>o haz clic para seleccionar</p>
              <small>PDF o AI · recomendado hasta 500 MB</small>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <p className="privacy"><span>✓</span> El análisis ocurre en este dispositivo. Ningún archivo sale de tu equipo.</p>
          </div>
        </section>
      ) : working ? (
        <section className="working" aria-live="polite">
          <div className="scanner"><span /></div>
          <p className="kicker">ANALIZANDO ESTRUCTURA</p>
          <h1>Revisando el archivo…</h1>
          <p>Buscamos señales que puedan cambiar o detener la salida del RIP.</p>
        </section>
      ) : analysis ? (
        <section className="report-shell">
          <div className="report-actions">
            <button className="back-button" onClick={reset}>← Analizar otro archivo</button>
            <button className="export-button" onClick={exportReport}>Exportar informe</button>
          </div>

          <div className={`result-banner ${analysis.status}`}>
            <div className="result-main">
              <span className="result-symbol" aria-hidden="true">{analysis.status === "blocked" ? "×" : analysis.status === "caution" ? "!" : "✓"}</span>
              <div>
                <p className="result-label">{statusCopy(analysis.status).eyebrow}</p>
                <h1>{statusCopy(analysis.status).title}</h1>
                <p>{statusCopy(analysis.status).text}</p>
              </div>
            </div>
            <div className="score" aria-label={`Puntuación ${analysis.score} de 100`}>
              <strong>{analysis.score}</strong><span>/100</span><small>confianza técnica</small>
            </div>
          </div>

          <div className="file-strip">
            <div><span>ARCHIVO</span><b title={analysis.fileName}>{analysis.fileName}</b></div>
            <div><span>FORMATO</span><b>{analysis.format}</b></div>
            <div><span>TAMAÑO</span><b>{formatBytes(analysis.fileSize)}</b></div>
            <div><span>PERFIL</span><b>{PROFILES[profile].name} · {PROFILES[profile].dpi} ppp</b></div>
          </div>

          <div className="workspace">
            <aside className="preview-card">
              <div className="card-heading"><span>Vista real del archivo</span><small>representación PDF</small></div>
              {previewUrl && analysis.pdfVersion ? (
                <object data={previewUrl} type="application/pdf" className="pdf-preview" aria-label={`Vista previa de ${analysis.fileName}`}>
                  <div className="preview-fallback"><span>PDF</span><p>Tu navegador no puede mostrar la vista previa, pero el análisis continúa siendo válido.</p></div>
                </object>
              ) : (
                <div className="preview-fallback invalid"><span>AI</span><p>Este archivo no contiene una vista PDF compatible.</p></div>
              )}
              <p className="preview-caption">La vista proviene del archivo cargado; no reconstruimos ni inventamos el diseño.</p>
            </aside>

            <div className="checklist">
              {grouped.errors.length > 0 && <CheckGroup title="Problemas bloqueantes" count={grouped.errors.length} checks={grouped.errors} tone="error" />}
              {grouped.warnings.length > 0 && <CheckGroup title="Requiere confirmación" count={grouped.warnings.length} checks={grouped.warnings} tone="warning" />}
              {grouped.passes.length > 0 && <CheckGroup title="Controles aprobados" count={grouped.passes.length} checks={grouped.passes} tone="pass" />}
            </div>
          </div>

          <section className="rip-checklist">
            <div>
              <p className="kicker">ANTES DE PRODUCIR</p>
              <h2>Cuatro decisiones que toma el RIP</h2>
              <p>El archivo puede estar técnicamente apto y aun así salir mal si la cola no coincide con el equipo y los materiales.</p>
            </div>
            <ol>
              <li><span>1</span><div><b>Perfil ICC</b><small>Impresora + tinta + papel + sustrato</small></div></li>
              <li><span>2</span><div><b>Tamaño y escala</b><small>Sin ajuste automático inesperado</small></div></li>
              <li><span>3</span><div><b>Espejo una sola vez</b><small>En el archivo o en el RIP, nunca en ambos</small></div></li>
              <li><span>4</span><div><b>Tira de prueba</b><small>Color, detalle y transferencia</small></div></li>
            </ol>
          </section>

          <p className="disclaimer">RIPcheck realiza un análisis preventivo de estructura legible. No reemplaza el preflight interno del RIP, la calibración ni una prueba física de producción.</p>
        </section>
      ) : null}
    </main>
  );
}

function CheckGroup({ title, count, checks, tone }: { title: string; count: number; checks: Check[]; tone: "error" | "warning" | "pass" }) {
  const [open, setOpen] = useState(tone !== "pass");
  return (
    <section className={`check-group ${tone}`}>
      <button className="group-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><i>{tone === "error" ? "×" : tone === "warning" ? "!" : "✓"}</i>{title}<b>{count}</b></span><em>{open ? "−" : "+"}</em>
      </button>
      {open && <div className="check-items">{checks.map((check) => (
        <article className="check-item" key={check.id}>
          <span className="check-dot">{check.severity === "error" ? "×" : check.severity === "pass" ? "✓" : check.severity === "info" ? "i" : "!"}</span>
          <div><h3>{check.title}</h3><p>{check.detail}</p></div>
          {check.value && <small>{check.value}</small>}
        </article>
      ))}</div>}
    </section>
  );
}
