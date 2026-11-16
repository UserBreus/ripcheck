import assert from "node:assert/strict";
import test from "node:test";
import { fileFacts, iccVerdict, pieceSize } from "../app/preflight-rules.ts";

function profile({ deviceClass = "prtr", space = "CMYK", version = "2.1", description = "U.S. Web Coated (SWOP) v2", tags = ["desc", "A2B0", "B2A0"] } = {}) {
  return {
    byteLength: 557168, declaredSize: 557168, cmm: "", versionMajor: Number(version[0]), versionMinor: 1,
    versionLabel: version, isV4: version.startsWith("4"), deviceClass,
    deviceClassLabel: deviceClass === "prtr" ? "Impresora (salida)" : "Monitor / espacio de trabajo",
    dataColorSpace: space, dataColorSpaceLabel: space, channels: space === "CMYK" ? 4 : 3,
    pcs: "Lab", created: "26/07/2000", platform: "", embeddedFlag: true, dependentFlag: false,
    manufacturer: "", model: "", renderingIntent: 0, renderingIntentLabel: "Perceptual",
    creator: "", hasProfileId: false, tagCount: tags.length, tags, description,
    copyright: null, manufacturerText: null, modelText: null, known: null, defects: [],
  };
}

const usage = (role, extra = {}) => ({
  objectNumber: 4, role, declaredComponents: 4, alternate: "DeviceCMYK",
  broken: false, mismatches: [], profile: profile(), ...extra,
});

const intent = (hasDestProfile) => ({
  subtype: "GTS_PDFX", outputCondition: null, outputConditionIdentifier: "Coated FOGRA39",
  registryName: null, info: null, destProfileRef: hasDestProfile ? 5 : null, hasDestProfile,
});

test("says whether the profile really travels inside the file", () => {
  assert.equal(iccVerdict([usage("output-intent")], [intent(true)]).state, "incrustado");
  assert.equal(iccVerdict([], [intent(false)]).state, "solo-nombre");
  assert.equal(iccVerdict([usage("colorspace")], []).state, "del-exportador");
  assert.equal(iccVerdict([], []).state, "sin-icc");
  assert.equal(iccVerdict([usage("colorspace", { broken: true, profile: null })], []).state, "incoherente");
});

test("explains a name-only profile as a label, not as colour data", () => {
  const verdict = iccVerdict([], [intent(false)]);
  assert.match(verdict.summary, /Coated FOGRA39/);
  assert.match(verdict.summary, /no incluye el perfil/);
});

test("uses the scale factor to report the real size of the piece", () => {
  // Caso real: una tizada de 8 m exportada con la página a la mitad.
  const page = { page: 1, media: [0, 0, 2551.185, 11325.138], crop: null, trim: null, bleed: null, art: null, rotate: 0, userUnit: 2 };
  const size = pieceSize([page]);

  assert.equal(Math.round(size.widthMm), 1800);
  assert.equal(Math.round(size.heightMm), 7991);
  assert.equal(size.scale, 2);
});

const factsInput = (overrides = {}) => ({
  pdfVersion: "1.3",
  pages: 1,
  geometry: [{ page: 1, media: [0, 0, 2551.185, 11325.138], crop: null, trim: null, bleed: null, art: null, rotate: 0, userUnit: 2 }],
  colorSpaces: ["CMYK"],
  imageColorSpaces: [],
  imageCount: 0,
  ppiMin: null,
  ppiMax: null,
  hasText: false,
  textCharacters: 0,
  fontNames: [],
  spotInks: [],
  iccUsages: [usage("output-intent")],
  outputIntents: [intent(true)],
  pdfxVersion: null,
  layerCount: 0,
  mirrored: { mirrored: 0, upright: 0 },
  ...overrides,
});

test("the facts list reports the real measurement and flags the scale", () => {
  const facts = fileFacts(factsInput());
  const size = facts.find((fact) => fact.label === "Medida");

  assert.equal(size?.value, "180 × 799.1 cm");
  assert.match(size?.note ?? "", /escala ×2/);
});

test("the facts say whether the profile carries real colour tables", () => {
  const withTables = fileFacts(factsInput()).find((fact) => fact.label === "Contenido del perfil");
  assert.equal(withTables?.value, "Tablas de color reales");
  assert.match(withTables?.note ?? "", /A2B0/);

  const labelOnly = fileFacts(factsInput({ iccUsages: [usage("output-intent", { profile: profile({ tags: ["desc", "cprt"] }) })] }))
    .find((fact) => fact.label === "Contenido del perfil");
  assert.equal(labelOnly?.value, "Solo etiquetas");
  assert.match(labelOnly?.note ?? "", /no sirve para convertir color/);
});

test("does not report ink coverage at all", () => {
  assert.equal(fileFacts(factsInput()).find((fact) => /tinta/i.test(fact.label)), undefined);
});
