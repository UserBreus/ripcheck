import assert from "node:assert/strict";
import test from "node:test";
import { buildFindings, groupRects } from "../app/findings.ts";

const region = (extra = {}) => ({
  kind: "vector", colorId: null, alpha: 1, blend: null, softMask: false,
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, ppi: null, ...extra,
});

const emptyDocument = {
  blockers: [], hasRgb: false, rgbInImages: false, fontsNotEmbedded: false,
  missingFontResources: [], minPpi: null, imageCount: 0, spotInks: [], rgbInPalette: false,
  mirroredMixed: false, totalPages: 1,
};

const run = (regions, document = {}, options = {}) => buildFindings({
  regions,
  targetPpi: options.targetPpi ?? 300,
  document: { ...emptyDocument, ...document },
});

test("a clean file produces no alerts at all", () => {
  assert.deepEqual(run([region(), region({ kind: "text" })]), []);
});

test("does not alert on page size", () => {
  // Una pieza enorme, a escala, no genera ninguna alerta por su medida.
  const findings = run([region({ bbox: { x: 0, y: 0, w: 1, h: 1 } })]);
  assert.deepEqual(findings.map((finding) => finding.id), []);
});

test("never alerts on ink coverage, the print profile limits it", () => {
  // Un 100/100/100/100 en el arte no sale así: el perfil de impresión lo recorta.
  const findings = run([region({ colorId: "CMYK:1:1:1:1" }), region({ colorId: "CMYK:0.9:0.9:0.9:0.9" })]);
  assert.deepEqual(findings, []);
});

test("locates transparencies on the page", () => {
  const findings = run([
    region({ alpha: 0.4, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
    region({ softMask: true, bbox: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } }),
    region(),
  ]);
  const found = findings.find((finding) => finding.id === "transparencia");

  assert.ok(found);
  assert.equal(found.severity, "warning");
  assert.equal(found.count, 2);
  assert.equal(found.rects.length, 2);
  assert.ok(found.detail.includes("sombra"));
  // Sin jerga: nada de SMask, ExtGState ni blend mode en el texto visible.
  assert.doesNotMatch(`${found.title} ${found.detail}`, /SMask|ExtGState|blend|OCG|XObject/i);
});

test("locates low resolution images and grades how bad they are", () => {
  // 289 contra un objetivo de 300 no molesta a nadie: no debe avisar.
  const fine = run([region({ kind: "raster", ppi: 289, bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } })]);
  assert.equal(fine.find((finding) => finding.id === "resolucion"), undefined);

  const mild = run([region({ kind: "raster", ppi: 200, bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } })]);
  assert.equal(mild.find((finding) => finding.id === "resolucion")?.severity, "warning");

  const bad = run([region({ kind: "raster", ppi: 60, bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } })]);
  const finding = bad.find((item) => item.id === "resolucion");
  assert.equal(finding?.severity, "error");
  assert.equal(finding?.badge, "60 ppp");
  assert.equal(finding?.rects.length, 1);
});

test("treats RGB as something to fix and points at it", () => {
  const findings = run([region({ colorId: "RGB:1:0:0", bbox: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } })], { hasRgb: true });
  const finding = findings.find((item) => item.id === "rgb");

  assert.equal(finding?.severity, "error");
  assert.equal(finding?.rects.length, 1);
  assert.match(finding?.detail ?? "", /CMYK/);
});

test("puts blockers first and keeps the whole list short", () => {
  const findings = run(
    [region({ alpha: 0.5 }), region({ kind: "raster", ppi: 50 }), region({ colorId: "RGB:1:0:0" })],
    {
      blockers: [{ id: "danado", title: "El archivo está dañado por dentro", detail: "…" }],
      hasRgb: true,
      fontsNotEmbedded: true,
    },
  );

  assert.equal(findings[0].id, "danado");
  assert.ok(findings.length <= 8);
  assert.ok(findings.every((finding) => finding.severity === "error" || finding.severity === "warning"));
});

test("merges touching zones so the preview is not covered in boxes", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ x: 0.1 + index * 0.001, y: 0.1, w: 0.02, h: 0.02 }));
  assert.equal(groupRects(many).length, 1);

  const apart = [{ x: 0.1, y: 0.1, w: 0.05, h: 0.05 }, { x: 0.8, y: 0.8, w: 0.05, h: 0.05 }];
  assert.equal(groupRects(apart).length, 2);

  assert.ok(groupRects(Array.from({ length: 60 }, (_, i) => ({ x: (i % 10) * 0.1, y: Math.floor(i / 10) * 0.16, w: 0.02, h: 0.02 }))).length <= 6);
});
