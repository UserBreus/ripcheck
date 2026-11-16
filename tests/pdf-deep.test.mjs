import assert from "node:assert/strict";
import test from "node:test";
import { collectIccUsages, readImageColorSpaces, readOutputIntents, readPageGeometry, readPdfXStamp, readSpotInks, scanRiskFeatures } from "../app/pdf-deep.ts";

test("reads the output intent and its embedded destination profile reference", () => {
  const raw = `%PDF-1.6
1 0 obj
<< /Type /Catalog /OutputIntents [ 4 0 R ] /Pages 2 0 R >>
endobj
4 0 obj
<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (Coated FOGRA39) /RegistryName (http://www.color.org) /DestOutputProfile 5 0 R >>
endobj
`;
  const [intent] = readOutputIntents(raw);

  assert.equal(intent.subtype, "GTS_PDFX");
  assert.equal(intent.outputConditionIdentifier, "Coated FOGRA39");
  assert.equal(intent.destProfileRef, 5);
  assert.equal(intent.hasDestProfile, true);
});

test("detects an output intent that only names a condition without embedding the profile", () => {
  const raw = `%PDF-1.4
1 0 obj
<< /Type /Catalog /OutputIntents [ << /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (U.S. Web Coated \\(SWOP\\) v2) >> ] >>
endobj
`;
  const [intent] = readOutputIntents(raw);

  assert.equal(intent.outputConditionIdentifier, "U.S. Web Coated (SWOP) v2");
  assert.equal(intent.hasDestProfile, false);
});

test("reads the PDF/X stamp left by the exporter", () => {
  assert.equal(readPdfXStamp("/GTS_PDFXVersion (PDF/X-4)").version, "PDF/X-4");
  assert.equal(readPdfXStamp("<pdfaid:part>2</pdfaid:part>").pdfaPart, 2);
  assert.equal(readPdfXStamp("%PDF-1.7").version, null);
});

test("reads page boxes, rotation and user unit", () => {
  const raw = `%PDF-1.7
1 0 obj
<< /Type /Pages /MediaBox [0 0 1000 2000] /Kids [3 0 R] >>
endobj
3 0 obj
<< /Type /Page /TrimBox [28.35 28.35 971.65 1971.65] /Rotate 90 /UserUnit 10 >>
endobj
`;
  const [page] = readPageGeometry(raw);

  assert.deepEqual(page.media, [0, 0, 1000, 2000]);
  assert.deepEqual(page.trim, [28.35, 28.35, 971.65, 1971.65]);
  assert.equal(page.rotate, 90);
  assert.equal(page.userUnit, 10);
});

test("reads spot inks with the space they fall back to", () => {
  const raw = `%PDF-1.7
2 0 obj
[ /Separation /CutContour /DeviceCMYK 7 0 R ]
endobj
3 0 obj
[ /Separation /RDG_WHITE /DeviceGray 8 0 R ]
endobj
4 0 obj
[ /DeviceN [ /PANTONE#20185#20C /Gold ] /DeviceCMYK 9 0 R ]
endobj
`;
  const inks = readSpotInks(raw, "");

  assert.deepEqual(inks.map((ink) => ink.name), ["CutContour", "RDG_WHITE", "PANTONE 185 C", "Gold"]);
  assert.equal(inks[0].alternate, "DeviceCMYK");
  assert.equal(inks[1].alternate, "DeviceGray");
  assert.equal(inks[2].kind, "DeviceN");
});

test("flags mesh shadings, Type 3 fonts, transfer functions and printable annotations", () => {
  const raw = `%PDF-1.7
5 0 obj
<< /ShadingType 6 /ColorSpace /DeviceRGB >>
endobj
6 0 obj
<< /Type /Font /Subtype /Type3 >>
endobj
7 0 obj
<< /Type /ExtGState /TR 12 0 R >>
endobj
8 0 obj
<< /Type /Annot /Subtype /Stamp /F 4 >>
endobj
9 0 obj
<< /Subtype /Image /Filter /JBIG2Decode >>
endobj
`;
  const features = scanRiskFeatures(raw, "");

  assert.deepEqual(features.shadingTypes, [6]);
  assert.equal(features.type3Fonts, 1);
  assert.equal(features.transferFunctions, true);
  assert.equal(features.printableAnnotations, 1);
  assert.deepEqual(features.annotationSubtypes, ["Stamp"]);
  assert.equal(features.jbig2, true);
});

test("reads the color space of every placed raster image", () => {
  const raw = `%PDF-1.7
3 0 obj
<< /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB >>
endobj
4 0 obj
<< /Subtype /Image /Width 10 /Height 10 /ColorSpace 9 0 R >>
endobj
9 0 obj
[ /ICCBased 10 0 R ]
endobj
5 0 obj
<< /Subtype /Image /Width 4 /Height 4 /ImageMask true >>
endobj
`;
  const spaces = readImageColorSpaces(raw);

  assert.ok(spaces.includes("RGB"));
  assert.ok(spaces.includes("ICC"));
});

test("assigns a role to every embedded ICC profile", async () => {
  const profile = Buffer.alloc(180);
  profile.writeUInt32BE(180, 0);
  profile[8] = 2;
  profile[9] = 0x40;
  profile.write("prtr", 12, "ascii");
  profile.write("CMYK", 16, "ascii");
  profile.write("acsp", 36, "ascii");
  profile.writeUInt32BE(0x0000F6D6, 68);
  profile.writeUInt32BE(0x00010000, 72);
  profile.writeUInt32BE(0x0000D32D, 76);
  profile.writeUInt32BE(1, 128);
  profile.write("desc", 132, "ascii");
  profile.writeUInt32BE(144, 136);
  profile.writeUInt32BE(36, 140);
  profile.write("desc", 144, "ascii");
  profile.writeUInt32BE(15, 152);
  profile.write("ISO Coated v2", 156, "ascii");

  const head = Buffer.from(`%PDF-1.6\n1 0 obj\n<< /Type /Catalog /OutputIntents [ 2 0 R ] >>\nendobj\n2 0 obj\n<< /Type /OutputIntent /S /GTS_PDFX /DestOutputProfile 3 0 R >>\nendobj\n3 0 obj\n<< /N 4 /Length ${profile.length} >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\n%%EOF", "latin1");
  const bytes = new Uint8Array(Buffer.concat([head, profile, tail]));
  const raw = Buffer.from(bytes).toString("latin1");

  const usages = await collectIccUsages(bytes, raw);

  assert.equal(usages.length, 1);
  assert.equal(usages[0].role, "output-intent");
  assert.equal(usages[0].declaredComponents, 4);
  assert.equal(usages[0].profile?.description, "ISO Coated v2");
  assert.deepEqual(usages[0].mismatches, []);
});

test("reports a mismatch when the declared channel count contradicts the profile", async () => {
  const profile = Buffer.alloc(140);
  profile.writeUInt32BE(140, 0);
  profile.write("mntr", 12, "ascii");
  profile.write("RGB ", 16, "ascii");
  profile.write("acsp", 36, "ascii");

  const head = Buffer.from(`%PDF-1.6\n3 0 obj\n<< /N 4 /Alternate /DeviceCMYK /Length ${profile.length} >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\n%%EOF", "latin1");
  const bytes = new Uint8Array(Buffer.concat([head, profile, tail]));
  const raw = Buffer.from(bytes).toString("latin1");

  const [usage] = await collectIccUsages(bytes, raw);

  assert.ok(usage.mismatches.some((issue) => issue.includes("4 canales")));
  assert.ok(usage.mismatches.some((issue) => issue.includes("/DeviceCMYK")));
});
