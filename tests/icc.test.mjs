import assert from "node:assert/strict";
import test from "node:test";
import { identifyProfile, looksLikeIcc, parseIccProfile } from "../app/icc.ts";

function buildProfile({ deviceClass = "prtr", space = "CMYK", pcs = "Lab ", major = 2, minor = 4, intent = 1, description = "U.S. Web Coated (SWOP) v2", useMluc = false } = {}) {
  const descBytes = useMluc
    ? (() => {
      const text = Buffer.alloc(description.length * 2);
      for (let index = 0; index < description.length; index += 1) text.writeUInt16BE(description.charCodeAt(index), index * 2);
      const body = Buffer.alloc(16 + 12 + text.length);
      body.write("mluc", 0, "ascii");
      body.writeUInt32BE(1, 8);
      body.writeUInt32BE(12, 12);
      body.write("en", 16, "ascii");
      body.write("US", 18, "ascii");
      body.writeUInt32BE(text.length, 20);
      body.writeUInt32BE(28, 24);
      text.copy(body, 28);
      return body;
    })()
    : (() => {
      const body = Buffer.alloc(12 + description.length + 1);
      body.write("desc", 0, "ascii");
      body.writeUInt32BE(description.length + 1, 8);
      body.write(description, 12, "ascii");
      return body;
    })();

  const tagOffset = 132 + 12;
  const total = tagOffset + descBytes.length;
  const profile = Buffer.alloc(total);
  profile.writeUInt32BE(total, 0);
  profile.write("appl", 4, "ascii");
  profile[8] = major;
  profile[9] = minor << 4;
  profile.write(deviceClass, 12, "ascii");
  profile.write(space.padEnd(4, " "), 16, "ascii");
  profile.write(pcs.padEnd(4, " "), 20, "ascii");
  profile.writeUInt16BE(2023, 24);
  profile.writeUInt16BE(5, 26);
  profile.writeUInt16BE(9, 28);
  profile.write("acsp", 36, "ascii");
  profile.writeUInt32BE(0x0000F6D6, 68);
  profile.writeUInt32BE(0x00010000, 72);
  profile.writeUInt32BE(0x0000D32D, 76);
  profile.write("MSFT", 40, "ascii");
  profile.writeUInt32BE(1, 44);
  profile.writeUInt32BE(intent, 64);
  profile.writeUInt32BE(1, 128);
  profile.write("desc", 132, "ascii");
  profile.writeUInt32BE(tagOffset, 136);
  profile.writeUInt32BE(descBytes.length, 140);
  descBytes.copy(profile, tagOffset);
  return new Uint8Array(profile);
}

test("reads the full ICC header of a v2 printer profile", () => {
  const profile = parseIccProfile(buildProfile());

  assert.ok(profile);
  assert.equal(profile.deviceClass, "prtr");
  assert.equal(profile.dataColorSpace, "CMYK");
  assert.equal(profile.channels, 4);
  assert.equal(profile.versionLabel, "2.4");
  assert.equal(profile.isV4, false);
  assert.equal(profile.renderingIntentLabel, "Colorimétrico relativo");
  assert.equal(profile.created, "09/05/2023");
  assert.equal(profile.platform, "MSFT");
  assert.equal(profile.embeddedFlag, true);
  assert.equal(profile.description, "U.S. Web Coated (SWOP) v2");
  assert.equal(profile.known?.id, "swop");
  assert.equal(profile.known?.family, "cmyk-press");
  assert.deepEqual(profile.defects, []);
});

test("reads a v4 profile description stored as multiLocalizedUnicode", () => {
  const profile = parseIccProfile(buildProfile({ major: 4, minor: 3, space: "RGB", deviceClass: "mntr", description: "sRGB IEC61966-2.1", useMluc: true }));

  assert.ok(profile);
  assert.equal(profile.isV4, true);
  assert.equal(profile.versionLabel, "4.3");
  assert.equal(profile.description, "sRGB IEC61966-2.1");
  assert.equal(profile.known?.id, "srgb");
  assert.equal(profile.channels, 3);
  assert.equal(profile.deviceClassLabel, "Monitor / espacio de trabajo");
});

test("rejects data that is not an ICC profile", () => {
  assert.equal(looksLikeIcc(new Uint8Array(64)), false);
  assert.equal(parseIccProfile(new Uint8Array(200)), null);
});

test("identifies the profiles used in sublimation, DTF and banner work", () => {
  assert.equal(identifyProfile("Coated FOGRA39 (ISO 12647-2:2004)", "CMYK", "prtr")?.id, "fogra39");
  assert.equal(identifyProfile("Adobe RGB (1998)", "RGB", "mntr")?.id, "adobergb");
  assert.equal(identifyProfile("SureColor F570 DS Transfer Multi-Purpose", "CMYK", "prtr")?.id, "sublimacion");
  assert.equal(identifyProfile("Generic DTF PET Film 60cm", "CMYK", "prtr")?.id, "dtf");
  assert.equal(identifyProfile("Roland VersaCAMM SG3 Banner", "CMYK", "prtr")?.id, "dispositivo");
  assert.equal(identifyProfile(null, "CMYK", "link")?.family, "device-link");
});

test("flags a truncated profile as defective", () => {
  const bytes = buildProfile();
  const truncated = bytes.slice(0, bytes.length - 8);
  const profile = parseIccProfile(truncated);

  assert.ok(profile);
  assert.ok(profile.defects.length > 0);
});
