/**
 * Alertas del preflight.
 *
 * Una alerta solo existe si cambia lo que el operador tiene que hacer. Todo lo
 * demás son datos del archivo y van en otra lista, sin color ni severidad.
 * Cada alerta se escribe en criollo y, cuando se puede, dice dónde mirar.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type FindingSeverity = "error" | "warning";

export type Finding = {
  id: string;
  /** Qué pasa, en pocas palabras. */
  title: string;
  /** Qué significa y qué hacer, en criollo. */
  detail: string;
  severity: FindingSeverity;
  /** Etiqueta corta para la tarjeta. */
  badge: string;
  /** Zonas de la primera página donde está el problema. */
  rects: Rect[];
  /** Cuántos objetos afecta en todo el documento. */
  count: number;
};

export type RegionLike = {
  kind: "vector" | "text" | "raster";
  colorId: string | null;
  alpha: number;
  blend: string | null;
  softMask: boolean;
  bbox: Rect;
  ppi: number | null;
};

const area = (rect: Rect) => rect.w * rect.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function merge(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Junta las zonas que se tocan y deja unas pocas, para que la vista previa
 * muestre tres o cuatro marcas grandes y no doscientas cajitas.
 */
export function groupRects(rects: Rect[], limit = 6): Rect[] {
  const usable = rects.filter((rect) => rect.w > 0.0005 && rect.h > 0.0005 && rect.w <= 1 && rect.h <= 1);
  if (!usable.length) return [];

  const padded = usable.map((rect) => ({
    x: Math.max(0, rect.x - 0.004),
    y: Math.max(0, rect.y - 0.004),
    w: Math.min(1, rect.w + 0.008),
    h: Math.min(1, rect.h + 0.008),
  }));

  const groups: Rect[] = [];
  for (const rect of padded) {
    const hit = groups.findIndex((group) => overlaps(group, rect));
    if (hit >= 0) groups[hit] = merge(groups[hit], rect);
    else groups.push({ ...rect });
  }

  // Segunda pasada: al fusionar aparecen solapes nuevos.
  let changed = true;
  while (changed && groups.length > 1) {
    changed = false;
    for (let i = 0; i < groups.length && !changed; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        if (!overlaps(groups[i], groups[j])) continue;
        groups[i] = merge(groups[i], groups[j]);
        groups.splice(j, 1);
        changed = true;
        break;
      }
    }
  }

  return groups.sort((a, b) => area(b) - area(a)).slice(0, limit);
}

export type FindingsInput = {
  regions: RegionLike[];
  /** PPI mínimo aceptable para este trabajo. */
  targetPpi: number;
  /** Resultados que valen para todo el documento, no solo la primera página. */
  document: {
    /** Bloqueos estructurales ya detectados. */
    blockers: Array<{ id: string; title: string; detail: string }>;
    hasRgb: boolean;
    rgbInImages: boolean;
    /** El RGB está en la paleta de una imagen indexada, sin objeto que señalar. */
    rgbInPalette: boolean;
    fontsNotEmbedded: boolean;
    missingFontResources: string[];
    minPpi: number | null;
    imageCount: number;
    spotInks: Array<{ name: string; usedAsFill: boolean; usedAsStroke: boolean; usedInImage: boolean }>;
    mirroredMixed: boolean;
    totalPages: number;
  };
};

export function buildFindings({ regions, targetPpi, document }: FindingsInput): Finding[] {
  const findings: Finding[] = [];

  for (const blocker of document.blockers) {
    findings.push({ id: blocker.id, title: blocker.title, detail: blocker.detail, severity: "error", badge: "No se puede usar", rects: [], count: 1 });
  }

  // Transparencias, sombras y fusiones: lo que puede verse distinto al ripear.
  const soft = regions.filter((region) => region.alpha < 0.999 || region.softMask || region.blend);
  if (soft.length) {
    const withShadow = soft.filter((region) => region.softMask).length;
    const withBlend = soft.filter((region) => region.blend).length;
    const faded = soft.filter((region) => region.alpha < 0.999).length;
    const parts: string[] = [];
    if (withShadow) parts.push(`${withShadow} tiene${withShadow === 1 ? "" : "n"} sombra o degradado suave`);
    if (faded) parts.push(`${faded} está${faded === 1 ? "" : "n"} a media opacidad`);
    if (withBlend) parts.push(`${withBlend} usa${withBlend === 1 ? "" : "n"} un modo de fusión`);
    findings.push({
      id: "transparencia",
      title: `${soft.length} objeto${soft.length === 1 ? "" : "s"} con transparencia`,
      detail: `De esos, ${parts.join("; ")}. Son efectos que la pantalla arma en vivo y el RIP tiene que aplanar para imprimir. Casi siempre sale bien, pero es la zona donde pueden aparecer recuadros claros o bordes duros. Miralas en la prueba antes de tirar la tirada.`,
      severity: "warning",
      badge: "Mirar en la prueba",
      rects: groupRects(soft.map((region) => region.bbox)),
      count: soft.length,
    });
  }

  // Imágenes con pocos píxeles para el tamaño al que están puestas.
  const lowResLimit = Math.round(targetPpi * 0.85);
  const lowRes = regions.filter((region) => region.kind === "raster" && region.ppi !== null && region.ppi < lowResLimit);
  if (lowRes.length) {
    const worst = Math.min(...lowRes.map((region) => region.ppi as number));
    const severe = worst < targetPpi / 2;
    findings.push({
      id: "resolucion",
      title: `${lowRes.length} ${lowRes.length === 1 ? "imagen" : "imágenes"} con poca definición`,
      detail: `La más floja tiene ${worst} puntos por pulgada al tamaño en que está puesta, y el objetivo es ${targetPpi}. ${severe ? "A esa resolución se va a ver pixelada de cerca." : "Puede pasar desapercibido si la pieza se mira de lejos."} Pedí la imagen más grande o achicá el tamaño en que está colocada.`,
      severity: severe ? "error" : "warning",
      badge: `${worst} ppp`,
      rects: groupRects(lowRes.map((region) => region.bbox)),
      count: lowRes.length,
    });
  } else if (document.minPpi !== null && document.minPpi < lowResLimit && document.totalPages > 1) {
    findings.push({
      id: "resolucion",
      title: "Hay imágenes con poca definición en otras páginas",
      detail: `La más floja del documento tiene ${document.minPpi} puntos por pulgada y el objetivo es ${targetPpi}. No está en la primera página, así que no se puede señalar acá.`,
      severity: document.minPpi < targetPpi / 2 ? "error" : "warning",
      badge: `${document.minPpi} ppp`,
      rects: [],
      count: 1,
    });
  }

  if (document.hasRgb || document.rgbInImages) {
    const rgbRegions = regions.filter((region) => region.colorId?.startsWith("RGB:"));
    // Si el RGB está dentro de una imagen no hay un color vectorial que
    // señalar, así que se marcan las imágenes colocadas.
    const located = rgbRegions.length ? rgbRegions : document.rgbInImages ? regions.filter((region) => region.kind === "raster") : [];
    const onlyImages = !rgbRegions.length && document.rgbInImages;
    const onlyPalette = !rgbRegions.length && !document.rgbInImages && document.rgbInPalette;
    findings.push({
      id: "rgb",
      title: onlyImages ? "Hay imágenes en RGB" : onlyPalette ? "Hay una paleta de color en RGB" : "Hay color en RGB",
      detail: onlyImages
        ? "Acá se imprime todo en CMYK. Esas imágenes las va a convertir el RIP por su cuenta, con otra referencia, así que su color puede no coincidir con el resto de la pieza. Convertilas a CMYK antes de colocarlas y volvé a exportar."
        : onlyPalette
          ? "Acá se imprime todo en CMYK. El archivo define sus colores con una paleta armada en RGB, que no está pegada a un objeto puntual y por eso no se puede señalar en la vista. El RIP la va a convertir por su cuenta. Pasá el documento a CMYK y volvé a exportar."
          : "Acá se imprime todo en CMYK. Lo que quedó en RGB lo convierte el RIP por su cuenta, con otra referencia, así que ese color va a salir distinto del resto de la pieza. Convertí el documento a CMYK y volvé a exportar.",
      severity: "error",
      badge: "Convertir a CMYK",
      rects: groupRects(located.map((region) => region.bbox)),
      count: located.length || 1,
    });
  }

  if (document.missingFontResources.length) {
    findings.push({
      id: "fuentes-rotas",
      title: "Faltan fuentes que el archivo usa",
      detail: `El contenido pide ${document.missingFontResources.join(", ")} pero esas fuentes no están dentro del PDF. El texto puede salir con otra tipografía o directamente no salir. Volvé a exportar incrustando las fuentes, o pasá el texto a curvas.`,
      severity: "error",
      badge: "Texto en riesgo",
      rects: groupRects(regions.filter((region) => region.kind === "text").map((region) => region.bbox)),
      count: document.missingFontResources.length,
    });
  } else if (document.fontsNotEmbedded) {
    findings.push({
      id: "fuentes",
      title: "El texto no trae las fuentes incrustadas",
      detail: "Si la máquina no tiene esa tipografía instalada, la reemplaza por otra y el texto cambia de forma y de largo. Exportá de nuevo incrustando las fuentes, o convertí el texto a curvas.",
      severity: "warning",
      badge: "Texto en riesgo",
      rects: groupRects(regions.filter((region) => region.kind === "text").map((region) => region.bbox)),
      count: 1,
    });
  }

  const cutFill = document.spotInks.filter((ink) => /cut|corte|contorno/i.test(ink.name) && ink.usedAsFill && !ink.usedAsStroke);
  if (cutFill.length) {
    findings.push({
      id: "corte",
      title: "El contorno de corte está pintado como relleno",
      detail: `“${cutFill[0].name}” está rellenando una figura en vez de ser una línea. Así se imprime como una mancha de color y el plotter no corta nada. Aplicalo como contorno.`,
      severity: "error",
      badge: "No va a cortar",
      rects: [],
      count: cutFill.length,
    });
  }

  const rasterSpots = document.spotInks.filter((ink) => ink.usedInImage);
  if (rasterSpots.length) {
    findings.push({
      id: "tinta-directa-imagen",
      title: "Hay tintas directas dentro de una imagen",
      detail: `${rasterSpots.map((ink) => ink.name).join(", ")} quedaron dentro de un ráster. El RIP solo reemplaza tintas directas en vectores, así que ahí no puede hacer nada y va a salir como color común. Rehacé ese elemento como vector.`,
      severity: "error",
      badge: "No se puede mapear",
      rects: [],
      count: rasterSpots.length,
    });
  }

  const plainSpots = document.spotInks.filter((ink) => !ink.usedInImage);
  if (plainSpots.length) {
    findings.push({
      id: "tintas-directas",
      title: `El archivo usa ${plainSpots.length} tinta${plainSpots.length === 1 ? "" : "s"} directa${plainSpots.length === 1 ? "" : "s"}`,
      detail: `Son ${plainSpots.slice(0, 6).map((ink) => ink.name).join(", ")}. La máquina no las tiene: el RIP las va a reemplazar por la mezcla de CMYK que le parezca. Si alguna tiene que dar un color exacto, hay que mapearla o acordarla con una prueba impresa.`,
      severity: "warning",
      badge: "Color aproximado",
      rects: [],
      count: plainSpots.length,
    });
  }

  if (document.mirroredMixed) {
    findings.push({
      id: "espejo",
      title: "Parte del arte está espejado y parte no",
      detail: "Algunas imágenes están dadas vuelta y otras no. El espejo del RIP se aplica a toda la pieza junta, así que no lo arregla. Hay que emparejarlo en el archivo original.",
      severity: "error",
      badge: "Revisar",
      rects: [],
      count: 1,
    });
  }

  const order = { error: 0, warning: 1 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}
