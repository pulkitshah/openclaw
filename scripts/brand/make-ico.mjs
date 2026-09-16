// Pack PNG frames into a Windows ICO container.
//
// ICO is a directory of images; every entry may hold a PNG payload verbatim
// (Vista and newer, plus every current browser), so no re-encoding is needed and
// the repo needs no rasterizer beyond the one that produced the PNGs.
//
// Usage: node scripts/brand/make-ico.mjs <out.ico> <frame.png> [<frame.png> ...]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DIRECTORY_ENTRY_BYTES = 16;

/** Read the frame geometry from the PNG IHDR, which is always the first chunk. */
function readPngSize(bytes, source) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${source} is not a PNG file`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || width > 256 || height < 1 || height > 256) {
    throw new Error(`${source} is ${width}x${height}; ICO frames must be 1-256 px per side`);
  }
  return { width, height };
}

function buildIco(frames) {
  if (frames.length === 0 || frames.length > 0xffff) {
    throw new Error("an ICO needs between 1 and 65535 frames");
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(DIRECTORY_ENTRY_BYTES * frames.length);
  let offset = header.length + directory.length;
  for (const [index, frame] of frames.entries()) {
    const entry = index * DIRECTORY_ENTRY_BYTES;
    // 256 px is encoded as 0; every other side fits one byte.
    directory.writeUInt8(frame.width === 256 ? 0 : frame.width, entry);
    directory.writeUInt8(frame.height === 256 ? 0 : frame.height, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size: truecolor
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(frame.bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.bytes.length;
  }
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.bytes)]);
}

export function writeIcoFromPngs(outputPath, pngPaths) {
  const frames = pngPaths.map((pngPath) => {
    const bytes = readFileSync(pngPath);
    return { ...readPngSize(bytes, pngPath), bytes };
  });
  const ico = buildIco(frames);
  writeFileSync(outputPath, ico);
  return { outputPath, frames: frames.map((frame) => `${frame.width}x${frame.height}`) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [outputPath, ...pngPaths] = process.argv.slice(2);
  if (!outputPath || pngPaths.length === 0) {
    console.error("usage: node scripts/brand/make-ico.mjs <out.ico> <frame.png> [...]");
    process.exit(1);
  }
  const result = writeIcoFromPngs(outputPath, pngPaths);
  console.log(`wrote ${result.outputPath} (${result.frames.join(", ")})`);
}
