export type LayerState = "none" | "registered" | "orphaned" | "unknown";

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

export async function decodedContentStreams(bytes: Uint8Array, raw: string) {
  if (bytes.byteLength > 80 * 1024 * 1024) return "";
  const decoder = new TextDecoder("latin1");
  const parts: string[] = [];
  const streamPattern = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  let inspected = 0;
  while ((match = streamPattern.exec(raw)) && inspected < 250) {
    const start = match.index + match[0].length;
    const previousObjectEnd = raw.lastIndexOf("endobj", match.index);
    const dictionary = raw.slice(Math.max(previousObjectEnd + 6, match.index - 64 * 1024), match.index);
    if (/\/Subtype\s*\/Image|\/FontFile\d?\b|\/DestOutputProfile\b/.test(dictionary)) continue;
    const endMarker = raw.indexOf("endstream", start);
    if (endMarker < 0) continue;
    const directLength = dictionary.match(/\/Length\s+(\d+)\s*(?:>>|\/)/)?.[1];
    const indirectLengthRef = dictionary.match(/\/Length\s+(\d+)\s+\d+\s+R\b/)?.[1];
    const indirectLength = indirectLengthRef
      ? raw.match(new RegExp(`(?:^|[\\r\\n])${indirectLengthRef}\\s+\\d+\\s+obj\\s+(\\d+)\\s+endobj\\b`))?.[1]
      : undefined;
    const streamLength = directLength || indirectLength;
    const end = streamLength ? Math.min(bytes.length, start + Number(streamLength)) : endMarker;
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
      // Unsupported filter combinations remain analyzable by PDF.js.
    }
  }
  return parts.join("\n");
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
