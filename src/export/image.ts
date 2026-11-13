/**
 * Depth-map writers: 16-bit greyscale PNG, 32-bit float OpenEXR and PFM.
 * All take a row-major image whose row 0 is the top edge.
 */

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

async function zlibDeflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** 16-bit greyscale PNG. `values` are expected in 0..1 (clamped). */
export async function writePng16(values: Float32Array, w: number, h: number): Promise<Blob> {
  const stride = 1 + w * 2;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    let o = y * stride + 1; // leading filter byte stays 0 (None)
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = Math.round(Math.min(1, Math.max(0, values[row + x])) * 65535);
      raw[o++] = v >> 8;
      raw[o++] = v & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob(
    [
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', await zlibDeflate(raw)),
      pngChunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' },
  );
}

/** Uncompressed single-channel ("Y") 32-bit float scanline OpenEXR. */
export function writeExr(values: Float32Array, w: number, h: number): ArrayBuffer {
  const enc = new TextEncoder();
  const header: number[] = [];
  const pushStr = (s: string) => {
    header.push(...enc.encode(s), 0);
  };
  const pushInt = (v: number) => {
    header.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };
  const pushFloat = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    header.push(...b);
  };
  const attr = (name: string, type: string, size: number, body: () => void) => {
    pushStr(name);
    pushStr(type);
    pushInt(size);
    body();
  };

  pushInt(20000630); // magic
  pushInt(2); // version 2, single-part scanline
  attr('channels', 'chlist', 18 + 1, () => {
    pushStr('Y');
    pushInt(2); // FLOAT
    header.push(0, 0, 0, 0); // pLinear + reserved
    pushInt(1);
    pushInt(1);
    header.push(0);
  });
  attr('compression', 'compression', 1, () => header.push(0));
  const box = () => {
    pushInt(0);
    pushInt(0);
    pushInt(w - 1);
    pushInt(h - 1);
  };
  attr('dataWindow', 'box2i', 16, box);
  attr('displayWindow', 'box2i', 16, box);
  attr('lineOrder', 'lineOrder', 1, () => header.push(0));
  attr('pixelAspectRatio', 'float', 4, () => pushFloat(1));
  attr('screenWindowCenter', 'v2f', 8, () => {
    pushFloat(0);
    pushFloat(0);
  });
  attr('screenWindowWidth', 'float', 4, () => pushFloat(1));
  header.push(0);

  const rowBytes = w * 4;
  const tableStart = header.length;
  const dataStart = tableStart + h * 8;
  const buf = new ArrayBuffer(dataStart + h * (8 + rowBytes));
  const bytes = new Uint8Array(buf);
  bytes.set(header);
  const dv = new DataView(buf);
  for (let y = 0; y < h; y++) {
    const off = dataStart + y * (8 + rowBytes);
    dv.setBigUint64(tableStart + y * 8, BigInt(off), true);
    dv.setInt32(off, y, true);
    dv.setInt32(off + 4, rowBytes, true);
    const row = y * w;
    for (let x = 0; x < w; x++) dv.setFloat32(off + 8 + x * 4, values[row + x], true);
  }
  return buf;
}

/** Greyscale little-endian PFM (rows are stored bottom to top, per the format). */
export function writePfm(values: Float32Array, w: number, h: number): ArrayBuffer {
  const head = new TextEncoder().encode(`Pf\n${w} ${h}\n-1.0\n`);
  const buf = new ArrayBuffer(head.length + w * h * 4);
  new Uint8Array(buf).set(head);
  const dv = new DataView(buf);
  let o = head.length;
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      dv.setFloat32(o, values[row + x], true);
      o += 4;
    }
  }
  return buf;
}
