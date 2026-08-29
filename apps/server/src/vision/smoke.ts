import zlib from "node:zlib";
import { inspectScreenVisually, type VisionGatewayLike } from "./inspect.js";
import { config } from "../config.js";

/**
 * End-to-end check of the real vision path with no tablet attached.
 *
 * The unit tests stub the model, so they prove the scaling and validation but
 * not that the prompt actually elicits the JSON contract from
 * `deepseek-v4-flash-vision-exp`. This renders a synthetic 600x1000 "screen"
 * and drives the genuine HTTPS call through a fake gateway, which is the only
 * part of the feature hardware cannot verify for us.
 *
 * The scene is chosen so both interesting answers are exercised: two grey
 * blocks that DO have accessibility nodes, and a red disc that deliberately
 * has none - a stand-in for a canvas-drawn control.
 */

const W = 600;
const H = 1000;
const SCALE = 2; // Native screen is 1200x2000.

/** Disc centre in image space; the tool must return this doubled. */
const DISC = { x: 300, y: 700, r: 70 };

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (const b of buf) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]));
    const row = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      row[x * 3] = r;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function scene(): string {
  return png(W, H, (x, y) => {
    const dx = x - DISC.x;
    const dy = y - DISC.y;
    if (dx * dx + dy * dy <= DISC.r * DISC.r) return [220, 30, 30];
    if (y >= 100 && y <= 180 && x >= 40 && x <= 560) return [120, 120, 120];
    if (y >= 300 && y <= 380 && x >= 40 && x <= 560) return [120, 120, 120];
    return [245, 245, 245];
  }).toString("base64");
}

function fakeGateway(imageBase64: string): VisionGatewayLike {
  return {
    listDevices: () => [{ deviceId: "smoke" }],
    isOnline: () => true,
    sendRequest: async (_deviceId, request) => {
      if (request.type === "get_screen") {
        return {
          ok: true,
          result: {
            snapshotId: "smoke-snap",
            packageName: "dev.trueforge.smoke",
            windowTitle: "Vision smoke",
            nodes: [
              // Bounds are native (image space x SCALE); the tool halves them.
              { id: "row-top", bounds: [80, 200, 1120, 360], text: "Top row", clickable: true, className: "android.widget.Button" },
              { id: "row-mid", bounds: [80, 600, 1120, 760], text: "Middle row", clickable: true, className: "android.widget.Button" },
            ],
          },
        };
      }
      return {
        ok: true,
        result: {
          format: "png",
          dataBase64: imageBase64,
          width: W,
          height: H,
          sourceWidth: W * SCALE,
          sourceHeight: H * SCALE,
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const gateway = fakeGateway(scene());
  console.log(`[vision-smoke] model=${config.visionModelId}`);

  const failures: string[] = [];
  const report = (name: string, passed: boolean, detail: string): void => {
    console.log(`${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
    if (!passed) failures.push(name);
  };

  // 1. The red disc has no node, so the only correct answer is coordinates.
  const disc = await inspectScreenVisually(gateway, {
    question: "Where is the red circle? It is a drawn control with no accessibility node.",
  });
  if (disc.resolution === "coordinates") {
    // Generous tolerance: this grades the coordinate space, not the model's aim.
    const dx = Math.abs(disc.x - DISC.x * SCALE);
    const dy = Math.abs(disc.y - DISC.y * SCALE);
    report(
      "drawn control resolves to native coordinates",
      dx <= 200 && dy <= 200,
      `got (${disc.x},${disc.y}) expected ~(${DISC.x * SCALE},${DISC.y * SCALE}) delta=(${dx},${dy})`,
    );
  } else {
    report("drawn control resolves to native coordinates", false, `resolution=${disc.resolution}`);
  }

  // 2. A target that is not on screen must come back absent, not guessed at.
  const missing = await inspectScreenVisually(gateway, {
    question: "Where is the green triangle?",
  });
  report(
    "an absent target is reported as absent",
    missing.resolution === "absent",
    `resolution=${missing.resolution} observation=${JSON.stringify(missing.observation)}`,
  );

  if (failures.length > 0) {
    console.error(`\n[vision-smoke] FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\n[vision-smoke] ok");
}

void main();
