import assert from "node:assert/strict";
import test from "node:test";
import { clearFrames, frameReference, getFrame, storeFrame } from "./frames.js";

const PIXEL = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

test("a stored frame is retrievable by id and carries both geometries", () => {
  clearFrames();
  const frame = storeFrame({
    dataBase64: PIXEL,
    format: "jpeg",
    width: 1024,
    height: 768,
    sourceWidth: 2000,
    sourceHeight: 1500,
  });
  const found = getFrame(frame.id);
  assert.equal(found?.mimeType, "image/jpeg");
  assert.equal(found?.sourceWidth, 2000);
  assert.deepEqual(found?.bytes, Buffer.from(PIXEL, "base64"));
});

test("a frame with no reported source size reports the image size instead", () => {
  clearFrames();
  const frame = storeFrame({ dataBase64: PIXEL, format: "png", width: 800, height: 600 });
  assert.equal(frame.mimeType, "image/png");
  assert.equal(frame.sourceWidth, 800);
  assert.equal(frame.sourceHeight, 600);
});

test("the reference exposes the id and geometry but never the pixels", () => {
  clearFrames();
  const reference = frameReference(storeFrame({
    dataBase64: PIXEL,
    format: "jpeg",
    width: 10,
    height: 20,
  }));
  assert.deepEqual(Object.keys(reference).sort(), [
    "frameId", "height", "sourceHeight", "sourceWidth", "width",
  ]);
  assert.equal(JSON.stringify(reference).includes(PIXEL), false);
});

test("the store is bounded and evicts oldest first", () => {
  clearFrames();
  const first = storeFrame({ dataBase64: PIXEL, format: "jpeg", width: 1, height: 1 });
  const ids = [first.id];
  for (let i = 0; i < 60; i += 1) {
    ids.push(storeFrame({ dataBase64: PIXEL, format: "jpeg", width: 1, height: 1 }).id);
  }
  // Screens are held only as long as the cap allows; the dashboard renders an
  // "expired" placeholder for the miss rather than a broken image.
  assert.equal(getFrame(first.id), undefined);
  assert.ok(getFrame(ids.at(-1)!));
});

test("rejects malformed and oversized frame payloads before retention", () => {
  clearFrames();
  assert.throws(
    () => storeFrame({ dataBase64: "not base64", width: 10, height: 10 }),
    /valid base64/,
  );
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
  assert.throws(
    () => storeFrame({ dataBase64: oversized, width: 10, height: 10 }),
    /per-frame byte limit/,
  );
  assert.throws(
    () => storeFrame({
      dataBase64: PIXEL,
      width: 10,
      height: 10,
      sourceWidth: 50_000,
      sourceHeight: 10,
    }),
    /source dimensions/,
  );
});
