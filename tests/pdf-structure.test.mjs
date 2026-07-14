import assert from "node:assert/strict";
import test from "node:test";
import { inspectPdfStructure } from "../app/pdf-structure.ts";

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
