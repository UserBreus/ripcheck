export type LayerState = "none" | "registered" | "orphaned" | "unknown";
export type PdfSourceColor = {
  id: string;
  space: "CMYK" | "RGB" | "Gray" | "Tint";
  values: number[];
  preview: string;
  source: string;
  uses: number;
};

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

function rawPdfStreams(bytes: Uint8Array, raw: string) {
  const streams: Array<{ dictionary: string; source: Uint8Array }> = [];
  const streamPattern = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw)) && streams.length < 400) {
    const start = match.index + match[0].length;
    const previousObjectEnd = raw.lastIndexOf("endobj", match.index);
    const dictionary = raw.slice(Math.max(previousObjectEnd + 6, match.index - 64 * 1024), match.index);
    const endMarker = raw.indexOf("endstream", start);
    if (endMarker < 0) continue;
    const directLength = dictionary.match(/\/Length\s+(\d+)\s*(?:>>|\/)/)?.[1];
    const indirectLengthRef = dictionary.match(/\/Length\s+(\d+)\s+\d+\s+R\b/)?.[1];
    const indirectLength = indirectLengthRef
      ? raw.match(new RegExp(`(?:^|[\\r\\n])${indirectLengthRef}\\s+\\d+\\s+obj\\s+(\\d+)\\s+endobj\\b`))?.[1]
      : undefined;
    const streamLength = directLength || indirectLength;
    const end = streamLength ? Math.min(bytes.length, start + Number(streamLength)) : endMarker;
    if (end <= start || end - start > 20 * 1024 * 1024) continue;
    streams.push({ dictionary, source: bytes.slice(start, end) });
  }
  return streams;
}

async function decodePdfStream(source: Uint8Array, dictionary: string) {
  let decoded = source;
  if (/\/ASCII85Decode\b/.test(dictionary)) decoded = decodeAscii85(decoded);
  if (/\/FlateDecode\b/.test(dictionary) && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([decoded]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (!/\/Filter\b/.test(dictionary) || /\/ASCII85Decode\b/.test(dictionary)) return decoded;
  return null;
}

export async function decodedContentStreams(bytes: Uint8Array, raw: string) {
  if (bytes.byteLength > 80 * 1024 * 1024) return "";
  const decoder = new TextDecoder("latin1");
  const parts: string[] = [];
  for (const { dictionary, source } of rawPdfStreams(bytes, raw)) {
    if (/\/Subtype\s*\/Image|\/FontFile\d?\b|\/DestOutputProfile\b|\/Type\s*\/Metadata\b|\/N\s+[134]\b/.test(dictionary)) continue;
    try {
      const decoded = await decodePdfStream(source, dictionary);
      if (decoded && decoded.length < 8 * 1024 * 1024) parts.push(decoder.decode(decoded));
    } catch {
      // Unsupported filter combinations remain analyzable by PDF.js.
    }
  }
  return parts.join("\n");
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return Array.from(bytes.slice(start, start + length), (value) => String.fromCharCode(value)).join("");
}

function uint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function iccDescription(bytes: Uint8Array) {
  if (bytes.length < 132 || ascii(bytes, 36, 4) !== "acsp") return null;
  const count = Math.min(uint32(bytes, 128), 256);
  for (let index = 0; index < count; index += 1) {
    const entry = 132 + index * 12;
    if (entry + 12 > bytes.length) break;
    const signature = ascii(bytes, entry, 4);
    if (signature !== "desc" && signature !== "dscm") continue;
    const offset = uint32(bytes, entry + 4);
    const size = uint32(bytes, entry + 8);
    if (offset + Math.min(size, 12) > bytes.length) continue;
    const type = ascii(bytes, offset, 4);
    if (type === "desc") {
      const length = Math.min(uint32(bytes, offset + 8), size - 12, bytes.length - offset - 12);
      const name = ascii(bytes, offset + 12, Math.max(0, length)).replace(/\0+$/, "").trim();
      if (name) return name;
    }
    if (type === "mluc") {
      const records = Math.min(uint32(bytes, offset + 8), 64);
      const recordSize = uint32(bytes, offset + 12);
      for (let record = 0; record < records; record += 1) {
        const recordOffset = offset + 16 + record * recordSize;
        if (recordOffset + 12 > bytes.length) break;
        const length = uint32(bytes, recordOffset + 4);
        const textOffset = offset + uint32(bytes, recordOffset + 8);
        if (textOffset + length > bytes.length) continue;
        let name = "";
        for (let character = 0; character + 1 < length; character += 2) name += String.fromCharCode((bytes[textOffset + character] << 8) | bytes[textOffset + character + 1]);
        if (name.trim()) return name.trim();
      }
    }
  }
  return null;
}

export async function embeddedIccProfiles(bytes: Uint8Array, raw: string) {
  const profiles = new Set<string>();
  for (const { dictionary, source } of rawPdfStreams(bytes, raw)) {
    if (!/\/N\s+[134]\b|\/Alternate\s*\/Device(?:Gray|RGB|CMYK)\b/.test(dictionary)) continue;
    try {
      const decoded = await decodePdfStream(source, dictionary);
      if (!decoded || decoded.length < 132 || ascii(decoded, 36, 4) !== "acsp") continue;
      const name = iccDescription(decoded);
      const colorSpace = ascii(decoded, 16, 4).trim();
      profiles.add(name || `Perfil ICC ${colorSpace || "sin nombre"}`);
    } catch {
      // A damaged ICC stream is reported elsewhere as an unreadable profile.
    }
  }
  return Array.from(profiles);
}

function indirectObjects(raw: string) {
  const objects = new Map<number, string>();
  const headers = Array.from(raw.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g));
  headers.forEach((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const next = headers[index + 1]?.index ?? raw.length;
    const end = raw.lastIndexOf("endobj", next);
    objects.set(Number(match[1]), raw.slice(start, end >= start ? end : next));
  });
  return objects;
}

function fontAliasesFromDictionary(dictionary: string) {
  const aliases = new Set<string>();
  for (const match of dictionary.matchAll(/\/([^\s/<>{}\[\]()]+)\s+(?:\d+\s+\d+\s+R|<<\s*\/Type\s*\/Font\b)/g)) {
    aliases.add(match[1]);
  }
  return aliases;
}

function colorPreview(space: PdfSourceColor["space"], values: number[]) {
  let rgb: number[];
  if (space === "CMYK") {
    const [c, m, y, k] = values;
    rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  } else if (space === "RGB") rgb = values;
  else rgb = [values[0], values[0], values[0]];
  return `#${rgb.map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function colorSpaceMap(raw: string) {
  const objects = indirectObjects(raw);
  const spaces = new Map<string, { components: number; source: string }>();
  const register = (alias: string, definition: string) => {
    if (/\/DeviceCMYK\b/.test(definition)) spaces.set(alias, { components: 4, source: "DeviceCMYK" });
    else if (/\/DeviceRGB\b/.test(definition)) spaces.set(alias, { components: 3, source: "DeviceRGB" });
    else if (/\/DeviceGray\b/.test(definition)) spaces.set(alias, { components: 1, source: "DeviceGray" });
    const icc = definition.match(/\/ICCBased\s+(\d+)\s+\d+\s+R\b/);
    if (icc) {
      const components = Number(objects.get(Number(icc[1]))?.match(/\/N\s+([134])\b/)?.[1] || 0);
      if (components) spaces.set(alias, { components, source: "ICCBased" });
    }
    if (/\/(?:Separation|DeviceN)\b/.test(definition)) {
      const names = definition.match(/\[(.*?)\]/s)?.[1]?.match(/\/[A-Za-z0-9_.-]+/g)?.length || 1;
      spaces.set(alias, { components: Math.max(1, names), source: /\/DeviceN\b/.test(definition) ? "DeviceN" : "Separation" });
    }
  };

  for (const body of objects.values()) {
    for (const match of body.matchAll(/\/([A-Za-z0-9_.-]+)\s+(\[[\s\S]{0,800}?\]|\/(?:DeviceCMYK|DeviceRGB|DeviceGray)|\d+\s+\d+\s+R)/g)) {
      let definition = match[2];
      const indirect = definition.match(/^(\d+)\s+\d+\s+R$/);
      if (indirect) definition = objects.get(Number(indirect[1])) || definition;
      register(match[1], definition);
    }
  }
  return spaces;
}

export function extractSourceColors(raw: string, contentText: string, limit = 18): PdfSourceColor[] {
  const spaces = colorSpaceMap(raw);
  const colors = new Map<string, PdfSourceColor>();
  const tokens = contentText.match(/\/[A-Za-z0-9_.-]+|[-+]?(?:\d*\.\d+|\d+)|[A-Za-z][A-Za-z0-9*']*/g) || [];
  let numbers: number[] = [];
  let names: string[] = [];
  let fillSpace: string | null = null;
  let strokeSpace: string | null = null;

  const add = (space: PdfSourceColor["space"], values: number[], source: string) => {
    if (!values.length || values.some((value) => !Number.isFinite(value))) return;
    const normalized = values.map((value) => Math.max(0, Math.min(1, value)));
    const rounded = normalized.map((value) => Math.round(value * 1000) / 1000);
    const key = `${space}:${rounded.join(":")}`;
    const existing = colors.get(key);
    if (existing) existing.uses += 1;
    else colors.set(key, { id: key, space, values: rounded, preview: colorPreview(space, rounded), source, uses: 1 });
  };

  for (const token of tokens) {
    if (/^[-+]?(?:\d*\.\d+|\d+)$/.test(token)) {
      numbers.push(Number(token));
      continue;
    }
    if (token.startsWith("/")) {
      names.push(token.slice(1));
      continue;
    }

    if (token === "cs") fillSpace = names.at(-1) || null;
    else if (token === "CS") strokeSpace = names.at(-1) || null;
    else if ((token === "k" || token === "K") && numbers.length >= 4) add("CMYK", numbers.slice(-4), "DeviceCMYK");
    else if ((token === "rg" || token === "RG") && numbers.length >= 3) add("RGB", numbers.slice(-3), "DeviceRGB");
    else if ((token === "g" || token === "G") && numbers.length >= 1) add("Gray", numbers.slice(-1), "DeviceGray");
    else if (token === "scn" || token === "SCN") {
      const selected = spaces.get(token === "scn" ? fillSpace || "" : strokeSpace || "");
      const components = selected?.components || numbers.length;
      const values = numbers.length >= components ? numbers.slice(-components) : [];
      const source = selected?.source || `${components} canales`;
      if (components === 4 && source !== "DeviceN") add("CMYK", values, source);
      else if (components === 3) add("RGB", values, source);
      else if (components === 1 && source !== "Separation") add("Gray", values, source);
      else add("Tint", values, source);
    }
    numbers = [];
    names = [];
  }

  return Array.from(colors.values()).sort((a, b) => b.uses - a.uses).slice(0, limit);
}

export function inspectPdfStructure(raw: string, contentText: string) {
  const objects = indirectObjects(raw);
  const objectDictionaries = Array.from(objects.values()).map((body) => body.split(/\bstream\r?\n/, 1)[0]);
  const catalog = objectDictionaries.find((dictionary) => /\/Type\s*\/Catalog\b/.test(dictionary));
  const layerCount = objectDictionaries.filter((dictionary) => /\/Type\s*\/OCG\b/.test(dictionary)).length;
  const layerState: LayerState = layerCount === 0
    ? "none"
    : catalog
      ? (/\/OCProperties\b/.test(catalog) ? "registered" : "orphaned")
      : "unknown";

  const usedFontResources = new Set<string>();
  for (const match of contentText.matchAll(/\/([^\s/<>{}\[\]()]+)\s+[-+]?(?:\d*\.)?\d+\s+Tf\b/g)) {
    usedFontResources.add(match[1]);
  }

  const declaredFontResources = new Set<string>();
  for (const dictionary of objectDictionaries) {
    for (const match of dictionary.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const alias of fontAliasesFromDictionary(match[1])) declaredFontResources.add(alias);
    }
    for (const match of dictionary.matchAll(/\/Font\s+(\d+)\s+\d+\s+R\b/g)) {
      const resourceDictionary = objects.get(Number(match[1]));
      if (resourceDictionary) for (const alias of fontAliasesFromDictionary(resourceDictionary)) declaredFontResources.add(alias);
    }
  }

  const missingFontResources = Array.from(usedFontResources)
    .filter((alias) => !declaredFontResources.has(alias))
    .sort();
  const formXObjectCount = objectDictionaries.filter((dictionary) => /\/Subtype\s*\/Form\b/.test(dictionary)).length;
  const iccProfileRefs = new Set(Array.from(raw.matchAll(/\/ICCBased\s+(\d+)\s+\d+\s+R\b/g), (match) => match[1]));

  return {
    layerCount,
    layerState,
    missingFontResources,
    formXObjectCount,
    iccProfileCount: iccProfileRefs.size,
  };
}
