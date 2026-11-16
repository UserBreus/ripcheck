/**
 * Lector profundo de perfiles ICC (v2 y v4) pensado para preflight de RIP.
 *
 * Cubre la cabecera de 128 bytes definida por la especificación ICC.1,
 * la tabla de etiquetas y los tipos de texto `desc` (v2), `mluc` (v4) y `text`.
 * No depende del DOM: se puede ejecutar en el navegador, en Electron o en Node.
 */

export type IccDeviceClass =
  | "scnr"
  | "mntr"
  | "prtr"
  | "link"
  | "spac"
  | "abst"
  | "nmcl"
  | "unknown";

export type IccFamily =
  | "rgb-working"
  | "rgb-device"
  | "cmyk-press"
  | "cmyk-device"
  | "gray"
  | "lab"
  | "device-link"
  | "named"
  | "unknown";

export type KnownProfile = {
  id: string;
  name: string;
  family: IccFamily;
  /** Descripción corta para el informe en español. */
  note: string;
  /** Perfil genérico de espacio de trabajo, no de una impresora concreta. */
  generic: boolean;
};

export type IccProfile = {
  byteLength: number;
  declaredSize: number;
  cmm: string;
  versionMajor: number;
  versionMinor: number;
  versionLabel: string;
  isV4: boolean;
  deviceClass: IccDeviceClass;
  deviceClassLabel: string;
  dataColorSpace: string;
  dataColorSpaceLabel: string;
  channels: number;
  pcs: string;
  created: string | null;
  platform: string;
  embeddedFlag: boolean;
  dependentFlag: boolean;
  manufacturer: string;
  model: string;
  renderingIntent: number;
  renderingIntentLabel: string;
  creator: string;
  hasProfileId: boolean;
  tagCount: number;
  tags: string[];
  description: string | null;
  copyright: string | null;
  manufacturerText: string | null;
  modelText: string | null;
  known: KnownProfile | null;
  /** Problemas estructurales detectados dentro del propio perfil. */
  defects: string[];
};

const DEVICE_CLASS_LABELS: Record<IccDeviceClass, string> = {
  scnr: "Entrada (escáner/cámara)",
  mntr: "Monitor / espacio de trabajo",
  prtr: "Impresora (salida)",
  link: "DeviceLink",
  spac: "Espacio de color abstracto",
  abst: "Abstracto",
  nmcl: "Colores con nombre",
  unknown: "Clase desconocida",
};

const COLOR_SPACE_CHANNELS: Record<string, number> = {
  XYZ: 3,
  Lab: 3,
  Luv: 3,
  YCbr: 3,
  Yxy: 3,
  RGB: 3,
  GRAY: 1,
  HSV: 3,
  HLS: 3,
  CMYK: 4,
  CMY: 3,
  "2CLR": 2,
  "3CLR": 3,
  "4CLR": 4,
  "5CLR": 5,
  "6CLR": 6,
  "7CLR": 7,
  "8CLR": 8,
  "9CLR": 9,
  ACLR: 10,
  BCLR: 11,
  CCLR: 12,
  DCLR: 13,
  ECLR: 14,
  FCLR: 15,
};

const COLOR_SPACE_LABELS: Record<string, string> = {
  RGB: "RGB",
  CMYK: "CMYK",
  GRAY: "Escala de grises",
  CMY: "CMY",
  Lab: "Lab",
  XYZ: "XYZ",
  "4CLR": "4 canales",
  "5CLR": "5 canales",
  "6CLR": "6 canales",
  "7CLR": "7 canales",
  "8CLR": "8 canales",
};

const RENDERING_INTENT_LABELS = [
  "Perceptual",
  "Colorimétrico relativo",
  "Saturación",
  "Colorimétrico absoluto",
];

/**
 * Catálogo de perfiles habituales en talleres de sublimación, DTF y gran formato.
 * El orden importa: la primera coincidencia gana.
 */
const KNOWN_PROFILES: Array<{ match: RegExp; profile: KnownProfile }> = [
  {
    match: /sRGB.?IEC.?61966.?2[.-]?1|^sRGB$|sRGB Color Space|sRGB built-in|sRGB v4|sRGB IEC61966/i,
    profile: {
      id: "srgb",
      name: "sRGB IEC61966-2.1",
      family: "rgb-working",
      note: "Espacio RGB estándar. Es el origen correcto para sublimación cuando el RIP tiene la entrada RGB en sRGB.",
      generic: true,
    },
  },
  {
    match: /Adobe.?RGB.?\(?1998\)?|AdobeRGB1998/i,
    profile: {
      id: "adobergb",
      name: "Adobe RGB (1998)",
      family: "rgb-working",
      note: "RGB de gama amplia. Aprovecha mejor la gama de sublimación, pero el RIP debe tener la entrada RGB en Adobe RGB o los colores se desaturan.",
      generic: true,
    },
  },
  {
    match: /Display.?P3|DCI.?P3|P3.?D65/i,
    profile: {
      id: "p3",
      name: "Display P3",
      family: "rgb-working",
      note: "Espacio de pantalla Apple. Muchos RIP lo ignoran y lo tratan como sRGB, con cambio visible de color.",
      generic: true,
    },
  },
  {
    match: /ProPhoto|ROMM.?RGB/i,
    profile: {
      id: "prophoto",
      name: "ProPhoto RGB",
      family: "rgb-working",
      note: "Gama enorme con primarios imaginarios. Produce saltos de color al convertir a tinta; conviene reconvertir a sRGB o Adobe RGB.",
      generic: true,
    },
  },
  {
    match: /eci.?RGB/i,
    profile: {
      id: "ecirgb",
      name: "eciRGB v2",
      family: "rgb-working",
      note: "RGB europeo de gama amplia. Verifica que el RIP lo reconozca o conviértelo a Adobe RGB.",
      generic: true,
    },
  },
  {
    match: /Apple.?RGB|ColorMatch.?RGB|Generic.?RGB|Wide.?Gamut.?RGB|scRGB|SMPTE.?C|PAL.?SECAM|Camera.?RGB/i,
    profile: {
      id: "legacy-rgb",
      name: "RGB heredado",
      family: "rgb-working",
      note: "Espacio RGB antiguo o de sistema. Reexporta el arte en sRGB o Adobe RGB para evitar un desplazamiento de color.",
      generic: true,
    },
  },
  {
    match: /Rec\.?\s?2020|BT\.?2020/i,
    profile: {
      id: "rec2020",
      name: "Rec. 2020",
      family: "rgb-working",
      note: "Espacio de video, no de artes gráficas. Conviértelo antes de enviarlo al RIP.",
      generic: true,
    },
  },
  // Las variantes de GRACoL van antes que SWOP para no confundirlas.
  {
    match: /GRACoL2006[_\s-]?Coated1v2/i,
    profile: {
      id: "gracol2006-coated1v2",
      name: "GRACoL2006_Coated1v2",
      family: "cmyk-press",
      note: "Offset americano, versión de Idealliance.",
      generic: true,
    },
  },
  {
    match: /Coated.?GRACoL.?2006/i,
    profile: {
      id: "gracol2006-adobe",
      name: "Coated GRACoL 2006 (ISO 12647-2:2004)",
      family: "cmyk-press",
      note: "El GRACoL de Adobe. Es un archivo distinto del GRACoL2006_Coated1v2 de Idealliance.",
      generic: true,
    },
  },
  {
    match: /GRACoL2013|CRPC6|CGATS21/i,
    profile: {
      id: "gracol2013",
      name: "GRACoL 2013 / CRPC",
      family: "cmyk-press",
      note: "Generación 2013 del estándar americano. Verifica que el RIP tenga el mismo perfil instalado como entrada.",
      generic: true,
    },
  },
  {
    match: /U\.?S\.?.?Web.?Uncoated|US.?Web.?Uncoated/i,
    profile: { id: "swop-uncoated", name: "U.S. Web Uncoated v2", family: "cmyk-press", note: "Offset americano sobre papel no estucado.", generic: true },
  },
  {
    match: /U\.?S\.?.?Sheetfed.?Coated|US.?Sheetfed.?Coated/i,
    profile: { id: "sheetfed-coated", name: "U.S. Sheetfed Coated v2", family: "cmyk-press", note: "Offset plano americano sobre estucado.", generic: true },
  },
  {
    match: /U\.?S\.?.?Sheetfed.?Uncoated|US.?Sheetfed.?Uncoated/i,
    profile: { id: "sheetfed-uncoated", name: "U.S. Sheetfed Uncoated v2", family: "cmyk-press", note: "Offset plano americano sobre no estucado.", generic: true },
  },
  {
    match: /Web.?Coated.?SWOP.?2006.?Grade.?3/i,
    profile: { id: "swop2006g3", name: "Web Coated SWOP 2006 Grade 3", family: "cmyk-press", note: "Offset rotativo americano, papel grado 3.", generic: true },
  },
  {
    match: /Web.?Coated.?SWOP.?2006.?Grade.?5|SWOP2006[_\s-]?Coated5/i,
    profile: { id: "swop2006g5", name: "Web Coated SWOP 2006 Grade 5", family: "cmyk-press", note: "Offset rotativo americano, papel grado 5.", generic: true },
  },
  {
    match: /U\.?S\.?.?Web.?Coated.?\(?SWOP\)?|SWOP.?200[0-9]|SWOP.?201[0-9]|Web.?Coated.?SWOP|Swop.?Standard/i,
    profile: {
      id: "swop",
      name: "U.S. Web Coated (SWOP) v2",
      family: "cmyk-press",
      note: "El CMYK que traen por defecto casi todos los Illustrator de América. Es offset rotativo americano: buena referencia, pero el RIP tiene que tener este mismo perfil cargado como entrada CMYK.",
      generic: true,
    },
  },
  {
    match: /ISO.?Coated.?v2.?300|ISOcoated.?v2.?300/i,
    profile: {
      id: "isocoated300",
      name: "ISO Coated v2 300% (ECI)",
      family: "cmyk-press",
      note: "Offset europeo, variante 300% de ECI.",
      generic: true,
    },
  },
  {
    match: /ISO.?Coated.?v2|ISOcoated.?v2|Coated.?FOGRA39|FOGRA39/i,
    profile: {
      id: "fogra39",
      name: "Coated FOGRA39 / ISO Coated v2",
      family: "cmyk-press",
      note: "Offset europeo estándar.",
      generic: true,
    },
  },
  {
    match: /PSO.?Coated.?v3|FOGRA51|Coated.?FOGRA51/i,
    profile: {
      id: "fogra51",
      name: "PSO Coated v3 (FOGRA51)",
      family: "cmyk-press",
      note: "Offset europeo actual sobre papel estucado.",
      generic: true,
    },
  },
  {
    match: /PSO.?Uncoated.?v3|FOGRA52|Uncoated.?FOGRA52|ISO.?Uncoated/i,
    profile: {
      id: "fogra52",
      name: "PSO Uncoated v3 (FOGRA52)",
      family: "cmyk-press",
      note: "Offset sobre papel no estucado. Gama muy corta: los colores saturados del arte ya vienen apagados de origen.",
      generic: true,
    },
  },
  {
    match: /Coated.?FOGRA27|FOGRA27/i,
    profile: { id: "fogra27", name: "Coated FOGRA27", family: "cmyk-press", note: "Offset europeo anterior a FOGRA39.", generic: true },
  },
  {
    match: /Web.?Coated.?FOGRA28|FOGRA28|Uncoated.?FOGRA29|FOGRA29/i,
    profile: { id: "fogra28", name: "FOGRA28 / FOGRA29", family: "cmyk-press", note: "Offset europeo de rotativa o papel no estucado.", generic: true },
  },
  {
    match: /FOGRA4[0-9]|FOGRA5[3-9]|GRACoL/i,
    profile: {
      id: "fogra-otros",
      name: "FOGRA / GRACoL (offset)",
      family: "cmyk-press",
      note: "Perfil de imprenta offset. Sirve como referencia de color de origen; el perfil de salida lo pone el RIP.",
      generic: true,
    },
  },
  {
    match: /Japan.?Color.?200[12].?Coated|Japan.?Color.?2011/i,
    profile: { id: "japancolor-coated", name: "Japan Color Coated", family: "cmyk-press", note: "Offset japonés sobre estucado.", generic: true },
  },
  {
    match: /Japan.?Color.?2002.?Newspaper/i,
    profile: { id: "japancolor-news", name: "Japan Color 2002 Newspaper", family: "cmyk-press", note: "Offset de diario.", generic: true },
  },
  {
    match: /Japan.?Color|JapanColor/i,
    profile: { id: "japancolor", name: "Japan Color", family: "cmyk-press", note: "Estándar de offset japonés.", generic: true },
  },
  {
    match: /Euroscale.?Coated|Euro.?scale.?Coated/i,
    profile: { id: "euroscale-coated", name: "Euroscale Coated v2", family: "cmyk-press", note: "Perfil CMYK antiguo de Adobe.", generic: true },
  },
  {
    match: /Euroscale|Euro.?scale/i,
    profile: { id: "euroscale", name: "Euroscale Uncoated v2", family: "cmyk-press", note: "Perfil CMYK antiguo de Adobe.", generic: true },
  },
  {
    match: /SNAP.?200[0-9]|Newsprint/i,
    profile: { id: "snap", name: "US Newsprint (SNAP)", family: "cmyk-press", note: "Papel de diario.", generic: true },
  },
  {
    match: /Dot.?Gain|Gray.?Gamma|sGray|Generic.?Gray|Grayscale/i,
    profile: {
      id: "gray",
      name: "Escala de grises",
      family: "gray",
      note: "Perfil de grises. Si el arte debe salir en color, el documento está en el espacio equivocado.",
      generic: true,
    },
  },
  {
    match: /Lab|CIE.?L\*a\*b/i,
    profile: {
      id: "lab",
      name: "Lab / CIE",
      family: "lab",
      note: "Espacio independiente del dispositivo. Muchos RIP lo convierten mal; conviértelo a RGB o CMYK antes de producir.",
      generic: true,
    },
  },
  // Perfiles de máquina, tinta y sustrato: son los que sí corresponden a producción.
  {
    match: /Sawgrass|SubliJet|Virtuoso|ChromaBlast|TexPrint|Sublim|Subly|InkTec|J-?Teck|Kiian|Digistar|Nazdar|Sensient|Hi-?Pro|Mimaki.?Sb|Epson.?F\d|SureColor.?F|DS.?Transfer|Multi-?Purpose.?Transfer/i,
    profile: {
      id: "sublimacion",
      name: "Perfil de sublimación (máquina/tinta/papel)",
      family: "cmyk-device",
      note: "Perfil de una combinación real de impresora, tinta y papel de sublimación. Debe vivir en el RIP como perfil de salida, no incrustado en el arte.",
      generic: false,
    },
  },
  {
    match: /DTF|Film.?Transfer|PET.?Film|Direct.?to.?Film|White.?Ink|Underbase/i,
    profile: {
      id: "dtf",
      name: "Perfil DTF (film/tinta)",
      family: "cmyk-device",
      note: "Perfil de impresión directa a film. El canal blanco se controla desde el RIP, no desde el ICC.",
      generic: false,
    },
  },
  {
    match: /Roland|VersaCAMM|VersaUV|Mimaki|Mutoh|ValueJet|Epson|SureColor|Stylus.?Pro|Canon.?imagePROGRAF|iPF|HP.?Latex|DesignJet|Ricoh|Kyocera|Konica|Seiko|Agfa|Durst|EFI|Fiery|Onyx|Wasatch|Caldera|PhotoPRINT|FlexiPRINT|VersaWorks/i,
    profile: {
      id: "dispositivo",
      name: "Perfil de dispositivo / RIP",
      family: "cmyk-device",
      note: "Perfil de una impresora concreta. Corresponde configurarlo como salida en el RIP; incrustado en el arte confunde la conversión.",
      generic: false,
    },
  },
  {
    match: /Vinyl|Banner|Lona|Mesh|Backlit|Canvas|Polyester|Textile|Fabric|Solvent|Eco.?Sol|Latex/i,
    profile: {
      id: "sustrato",
      name: "Perfil de sustrato",
      family: "cmyk-device",
      note: "Perfil ligado a un material concreto. Pertenece al preset del RIP, no al PDF.",
      generic: false,
    },
  },
];

function ascii(bytes: Uint8Array, start: number, length: number) {
  let out = "";
  for (let index = start; index < Math.min(bytes.length, start + length); index += 1) {
    const value = bytes[index];
    out += value === 0 ? "" : String.fromCharCode(value);
  }
  return out;
}

function uint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function uint16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length) return 0;
  return (bytes[offset] << 8) + bytes[offset + 1];
}

export function looksLikeIcc(bytes: Uint8Array) {
  return bytes.length >= 132 && ascii(bytes, 36, 4) === "acsp";
}

function readTagTable(bytes: Uint8Array) {
  const count = Math.min(uint32(bytes, 128), 512);
  const table = new Map<string, { offset: number; size: number }>();
  for (let index = 0; index < count; index += 1) {
    const entry = 132 + index * 12;
    if (entry + 12 > bytes.length) break;
    const signature = ascii(bytes, entry, 4).trim();
    if (!signature) continue;
    table.set(signature, { offset: uint32(bytes, entry + 4), size: uint32(bytes, entry + 8) });
  }
  return { count, table };
}

function readTextTag(bytes: Uint8Array, offset: number, size: number): string | null {
  if (offset <= 0 || offset + 8 > bytes.length) return null;
  const type = ascii(bytes, offset, 4);

  if (type === "desc") {
    const length = Math.min(uint32(bytes, offset + 8), Math.max(0, size - 12), bytes.length - offset - 12);
    const value = ascii(bytes, offset + 12, Math.max(0, length)).replace(/\0+$/, "").trim();
    return value || null;
  }

  if (type === "mluc") {
    const records = Math.min(uint32(bytes, offset + 8), 128);
    const recordSize = Math.max(12, uint32(bytes, offset + 12));
    let fallback: string | null = null;
    for (let record = 0; record < records; record += 1) {
      const recordOffset = offset + 16 + record * recordSize;
      if (recordOffset + 12 > bytes.length) break;
      const language = ascii(bytes, recordOffset, 2);
      const length = uint32(bytes, recordOffset + 4);
      const textOffset = offset + uint32(bytes, recordOffset + 8);
      if (length <= 0 || textOffset + length > bytes.length) continue;
      let value = "";
      for (let character = 0; character + 1 < length; character += 2) {
        value += String.fromCharCode(uint16(bytes, textOffset + character));
      }
      value = value.replace(/\0+$/, "").trim();
      if (!value) continue;
      if (language.toLowerCase() === "en") return value;
      fallback = fallback || value;
    }
    return fallback;
  }

  if (type === "text") {
    const length = Math.max(0, Math.min(size - 8, bytes.length - offset - 8));
    const value = ascii(bytes, offset + 8, length).replace(/\0+$/, "").trim();
    return value || null;
  }

  if (type === "utf8") {
    const length = Math.max(0, Math.min(size - 12, bytes.length - offset - 12));
    const slice = bytes.slice(offset + 12, offset + 12 + length);
    const value = new TextDecoder("utf-8").decode(slice).replace(/\0+$/, "").trim();
    return value || null;
  }

  return null;
}

export function identifyProfile(description: string | null, dataColorSpace: string, deviceClass: IccDeviceClass): KnownProfile | null {
  const haystack = (description || "").trim();
  if (haystack) {
    for (const entry of KNOWN_PROFILES) {
      if (entry.match.test(haystack)) return entry.profile;
    }
  }
  if (deviceClass === "link") {
    return { id: "devicelink", name: "DeviceLink", family: "device-link", note: "Un DeviceLink fija una conversión concreta. Si el RIP también convierte, el color se altera dos veces.", generic: false };
  }
  if (deviceClass === "nmcl") {
    return { id: "named", name: "Colores con nombre", family: "named", note: "Perfil de colores con nombre. Solo es útil si el RIP resuelve esa biblioteca de tintas.", generic: false };
  }
  if (deviceClass === "prtr" && dataColorSpace === "CMYK") {
    return { id: "prtr-cmyk", name: "Perfil de impresora CMYK", family: "cmyk-device", note: "Perfil de salida de un dispositivo. Debe estar configurado en el RIP, no incrustado en el arte.", generic: false };
  }
  if (deviceClass === "prtr") {
    return { id: "prtr", name: "Perfil de impresora", family: "cmyk-device", note: "Perfil de salida de un dispositivo concreto.", generic: false };
  }
  if (dataColorSpace === "RGB") {
    return { id: "rgb-desconocido", name: "RGB no identificado", family: "rgb-working", note: "Perfil RGB sin nombre reconocible. Confirma en el RIP con qué espacio de entrada se interpreta.", generic: false };
  }
  if (dataColorSpace === "CMYK") {
    return { id: "cmyk-desconocido", name: "CMYK no identificado", family: "cmyk-press", note: "Perfil CMYK sin nombre reconocible. Puede ser de imprenta o de una máquina ajena al taller.", generic: false };
  }
  return null;
}

export function parseIccProfile(bytes: Uint8Array): IccProfile | null {
  if (!looksLikeIcc(bytes)) return null;

  const declaredSize = uint32(bytes, 0);
  const versionRaw = bytes[8];
  const versionMinor = (bytes[9] >> 4) & 0x0f;
  const rawClass = ascii(bytes, 12, 4).trim();
  const deviceClass = (["scnr", "mntr", "prtr", "link", "spac", "abst", "nmcl"].includes(rawClass) ? rawClass : "unknown") as IccDeviceClass;
  const dataColorSpace = ascii(bytes, 16, 4).trim() || "";
  const pcs = ascii(bytes, 20, 4).trim();
  const flags = uint32(bytes, 44);
  const renderingIntent = uint32(bytes, 64);
  const { count, table } = readTagTable(bytes);

  const year = uint16(bytes, 24);
  const month = uint16(bytes, 26);
  const day = uint16(bytes, 28);
  const created = year > 1980 && year < 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`
    : null;

  const readTag = (signature: string) => {
    const tag = table.get(signature);
    return tag ? readTextTag(bytes, tag.offset, tag.size) : null;
  };

  const description = readTag("desc") || readTag("dscm") || readTag("dmdd") || null;
  const defects: string[] = [];
  if (declaredSize && Math.abs(declaredSize - bytes.length) > 4) {
    defects.push(`La cabecera declara ${declaredSize} bytes y el flujo incrustado tiene ${bytes.length}.`);
  }
  if (!count) defects.push("El perfil no declara ninguna etiqueta interna.");
  if (deviceClass === "unknown") defects.push(`Clase de dispositivo no estándar (“${rawClass || "vacía"}”).`);
  if (!dataColorSpace) defects.push("No declara espacio de color de datos.");
  // ICC.1 exige que un perfil v4 tenga longitud múltiplo de 4.
  if (versionRaw >= 4 && declaredSize % 4 !== 0) {
    defects.push("El perfil declara versión 4 pero su longitud no es múltiplo de 4, como exige la norma.");
  }
  if (renderingIntent > 0xffff) {
    defects.push("El campo de intención de reproducción tiene los 16 bits altos distintos de cero.");
  } else if (renderingIntent > 3) {
    defects.push(`Intención de reproducción fuera de rango (${renderingIntent}).`);
  }
  // El iluminante del PCS debe ser D50: X 0,9642 Y 1,0 Z 0,8249.
  const illuminant = [uint32(bytes, 68), uint32(bytes, 72), uint32(bytes, 76)].map((value) => value / 65536);
  const expected = [0.9642, 1.0, 0.8249];
  if (illuminant.some((value, index) => Math.abs(value - expected[index]) > 0.002)) {
    defects.push("El iluminante declarado no es D50; algunos motores de color rechazan el perfil.");
  }
  for (const [signature, tag] of table) {
    if (tag.offset + tag.size > bytes.length) {
      defects.push(`La etiqueta ${signature} apunta fuera del perfil.`);
      break;
    }
  }

  const channels = COLOR_SPACE_CHANNELS[dataColorSpace] ?? 0;

  return {
    byteLength: bytes.length,
    declaredSize,
    cmm: ascii(bytes, 4, 4).trim(),
    versionMajor: versionRaw,
    versionMinor,
    versionLabel: `${versionRaw}.${versionMinor}`,
    isV4: versionRaw >= 4,
    deviceClass,
    deviceClassLabel: DEVICE_CLASS_LABELS[deviceClass],
    dataColorSpace,
    dataColorSpaceLabel: COLOR_SPACE_LABELS[dataColorSpace] || dataColorSpace || "Desconocido",
    channels,
    pcs,
    created,
    platform: ascii(bytes, 40, 4).trim(),
    embeddedFlag: (flags & 0x01) === 0x01,
    dependentFlag: (flags & 0x02) === 0x02,
    manufacturer: ascii(bytes, 48, 4).trim(),
    model: ascii(bytes, 52, 4).trim(),
    renderingIntent,
    renderingIntentLabel: RENDERING_INTENT_LABELS[renderingIntent] || `Intención ${renderingIntent}`,
    creator: ascii(bytes, 80, 4).trim(),
    // El identificador MD5 solo está definido en v4; en v2 esos bytes son reservados.
    hasProfileId: versionRaw >= 4 && Array.from(bytes.slice(84, 100)).some((value) => value !== 0),
    tagCount: count,
    tags: Array.from(table.keys()),
    description,
    copyright: readTag("cprt"),
    manufacturerText: readTag("dmnd"),
    modelText: readTag("dmdd"),
    known: identifyProfile(description, dataColorSpace, deviceClass),
    defects,
  };
}

export function profileLabel(profile: IccProfile) {
  return profile.description || profile.known?.name || `Perfil ICC ${profile.dataColorSpaceLabel}`;
}
