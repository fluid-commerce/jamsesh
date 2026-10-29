// What an uploaded image must be before anything is written: a whole PNG or JPEG, its structure walked to the end.

export type CheckedImage = { kind: "png" | "jpeg"; width: number; height: number };

/** Bigger than any screen a room shows; a header claiming more is broken or hostile. */
const MAX_SIDE = 20_000;

/** The image's kind and size, or why it isn't a whole PNG or JPEG. */
export function checkImage(b: Uint8Array): CheckedImage | string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return checkPng(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return checkJpeg(b);
  return "Send a PNG or JPEG.";
}

const sized = (kind: CheckedImage["kind"], width: number, height: number): CheckedImage | string =>
  width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE ? { kind, width, height } : "That image's size isn't one a screen could have.";

/** Every chunk inside the file with a matching CRC, IHDR first, IEND last and at the very end. */
function checkPng(b: Uint8Array): CheckedImage | string {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  let size: { width: number; height: number } | null = null;
  while (off + 12 <= b.length) {
    const len = v.getUint32(off);
    const type = String.fromCharCode(...b.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (end > b.length) return "That PNG is cut off.";
    if ((Bun.hash.crc32(b.subarray(off + 4, off + 8 + len)) >>> 0) !== v.getUint32(off + 8 + len)) return "That PNG is damaged.";
    if (!size) {
      if (type !== "IHDR" || len !== 13) return "That PNG is damaged.";
      size = { width: v.getUint32(off + 8), height: v.getUint32(off + 12) };
    }
    if (type === "IEND") return end === b.length ? sized("png", size.width, size.height) : "That PNG has bytes after its end.";
    off = end;
  }
  return "That PNG is cut off.";
}

/** Segments in order up to the scan, a frame header giving the size, and the end marker as the last two bytes. */
function checkJpeg(b: Uint8Array): CheckedImage | string {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return "That JPEG is cut off.";
  let off = 2;
  let size: { width: number; height: number } | null = null;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return "That JPEG is damaged.";
    const marker = b[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = (b[off + 2] << 8) | b[off + 3];
    if (len < 2 || off + 2 + len > b.length) return "That JPEG is cut off.";
    // Start of frame (baseline, progressive and the rest; not DHT, JPG or DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 8) return "That JPEG is damaged.";
      size = { height: (b[off + 5] << 8) | b[off + 6], width: (b[off + 7] << 8) | b[off + 8] };
    }
    // Start of scan: the compressed data runs to the end marker, already checked.
    if (marker === 0xda) return size ? sized("jpeg", size.width, size.height) : "That JPEG has no frame header.";
    off += 2 + len;
  }
  return "That JPEG is cut off.";
}
