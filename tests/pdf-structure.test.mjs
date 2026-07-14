import assert from "node:assert/strict";
import test from "node:test";
import { embeddedIccProfiles, extractSourceColorOccurrences, extractSourceColors, inspectPdfStructure, resolveOriginalColorOccurrence } from "../app/pdf-structure.ts";

test("blocks orphan OCG layers and missing font resources", () => {
  const raw = `%PDF-1.6
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages >>
endobj
10 0 obj
<< /Type /OCG /Name (Diseño) >>
endobj
11 0 obj
<< /Type /OCG /Name (Nombre) >>
endobj
`;
  const result = inspectPdfStructure(raw, "BT /TT0 12 Tf /T1_0 8 Tf ET");

  assert.equal(result.layerState, "orphaned");
  assert.equal(result.layerCount, 2);
  assert.deepEqual(result.missingFontResources, ["T1_0", "TT0"]);
});

test("accepts a correctly registered OCG and declared font", () => {
  const raw = `%PDF-1.6
1 0 obj
<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] >> >>
endobj
2 0 obj
<< /Type /Page /Resources << /Font << /TT0 5 0 R >> >> >>
endobj
5 0 obj
<< /Type /Font /BaseFont /EmbeddedFont >>
endobj
6 0 obj
<< /Type /OCG /Name (Capa 1) >>
endobj
`;
  const result = inspectPdfStructure(raw, "BT /TT0 12 Tf ET");

  assert.equal(result.layerState, "registered");
  assert.equal(result.layerCount, 1);
  assert.deepEqual(result.missingFontResources, []);
});

test("reports flattened and nested structures separately", () => {
  const raw = `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Page /XObject << /F1 3 0 R /F2 4 0 R >> /ColorSpace << /CS0 [ /ICCBased 8 0 R ] /CS1 [ /ICCBased 9 0 R ] >> >>
endobj
3 0 obj
<< /Type /XObject /Subtype /Form >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Form >>
endobj
`;
  const result = inspectPdfStructure(raw, "");

  assert.equal(result.layerState, "none");
  assert.equal(result.formXObjectCount, 2);
  assert.equal(result.iccProfileCount, 2);
});

test("extracts original CMYK operators without converting from screen RGB", () => {
  const raw = `%PDF-1.7
1 0 obj
<< /Type /Catalog >>
endobj
2 0 obj
<< /N 4 >>
endobj
3 0 obj
<< /ColorSpace << /CS0 [ /ICCBased 2 0 R ] >> >>
endobj
`;
  const colors = extractSourceColors(raw, "/CS0 cs 0 0.94 0.91 0 scn 0 0 0 1 k");

  assert.deepEqual(colors.map(({ space, values, source }) => ({ space, values, source })), [
    { space: "CMYK", values: [0, 0.94, 0.91, 0], source: "ICCBased" },
    { space: "CMYK", values: [0, 0, 0, 1], source: "DeviceCMYK" },
  ]);
});

test("preserves the original color operator order and fill or stroke target", () => {
  const occurrences = extractSourceColorOccurrences("%PDF-1.7", "0 1 1 0 k 1 0 0 rg 1 0 0 0 K");

  assert.deepEqual(occurrences.map(({ space, values, target }) => ({ space, values, target })), [
    { space: "CMYK", values: [0, 1, 1, 0], target: "fill" },
    { space: "RGB", values: [1, 0, 0], target: "fill" },
    { space: "CMYK", values: [1, 0, 0, 0], target: "stroke" },
  ]);
});

test("keeps CMYK source values when the following RGB color looks closer on screen", () => {
  const queue = extractSourceColorOccurrences("%PDF-1.7", "0 0.204 0.98 0 k 1 0.78 0.22 rg").filter((color) => color.target === "fill");
  const resolved = resolveOriginalColorOccurrence(queue, 0, "#FFC737");

  assert.equal(resolved.color?.space, "CMYK");
  assert.deepEqual(resolved.color?.values, [0, 0.204, 0.98, 0]);
});

test("reads the description from an embedded ICC profile", async () => {
  const profile = new Uint8Array(220);
  const putAscii = (offset, value) => Array.from(value).forEach((character, index) => { profile[offset + index] = character.charCodeAt(0); });
  const putUint32 = (offset, value) => { profile[offset] = value >>> 24; profile[offset + 1] = value >>> 16; profile[offset + 2] = value >>> 8; profile[offset + 3] = value; };
  putAscii(16, "CMYK");
  putAscii(36, "acsp");
  putUint32(128, 1);
  putAscii(132, "desc");
  putUint32(136, 144);
  putUint32(140, 64);
  putAscii(144, "desc");
  putUint32(152, 27);
  putAscii(156, "U.S. Web Coated (SWOP) v2");

  const prefix = new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /N 4 /Length ${profile.length} >>\nstream\n`);
  const suffix = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
  const bytes = new Uint8Array(prefix.length + profile.length + suffix.length);
  bytes.set(prefix);
  bytes.set(profile, prefix.length);
  bytes.set(suffix, prefix.length + profile.length);
  const raw = new TextDecoder("latin1").decode(bytes);

  assert.deepEqual(await embeddedIccProfiles(bytes, raw), ["U.S. Web Coated (SWOP) v2"]);
});
