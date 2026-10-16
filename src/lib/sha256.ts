/**
 * Pure TypeScript SHA-256 (no dependencies).
 * ===========================================================================
 * Used to one-way hash invitation secrets so that NO plaintext secret is ever
 * stored in the database, printed in logs, or written to audit entries. The
 * identical implementation runs on the browser client (acceptance page) and
 * in Convex functions (default runtime), so a link secret can be verified by
 * comparing hex digests without transmitting the secret to any API except
 * for the hash argument.
 *
 * Deterministic, well-known algorithm (FIPS 180-4); verified against Node's
 * crypto in the security test suite.
 */

const K = /* @__PURE__ */ Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** Hash arbitrary UTF-8 text; returns the lowercase hex digest. */
export function sha256Hex(message: string): string {
  // UTF-8 encode (TextEncoder is available in all target runtimes).
  const bytes: number[] = Array.from(new TextEncoder().encode(message));
  const bitLength = bytes.length * 8;

  // Padding: 0x80, zeros, then the 64-bit big-endian message length.
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) {
    bytes.push((bitLength / 2 ** (i * 8)) & 0xff);
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        ((bytes[block + t * 4] ?? 0) << 24) |
        ((bytes[block + t * 4 + 1] ?? 0) << 16) |
        ((bytes[block + t * 4 + 2] ?? 0) << 8) |
        (bytes[block + t * 4 + 3] ?? 0);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = ((w[t - 16] + s0 + w[t - 7] + s1) >>> 0) as number;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = ((h + S1 + ch + K[t] + w[t]) >>> 0) as number;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = ((S0 + maj) >>> 0) as number;
      h = g;
      g = f;
      f = e;
      e = ((d + temp1) >>> 0) as number;
      d = c;
      c = b;
      b = a;
      a = ((temp1 + temp2) >>> 0) as number;
    }

    h0 = ((h0 + a) >>> 0) as number;
    h1 = ((h1 + b) >>> 0) as number;
    h2 = ((h2 + c) >>> 0) as number;
    h3 = ((h3 + d) >>> 0) as number;
    h4 = ((h4 + e) >>> 0) as number;
    h5 = ((h5 + f) >>> 0) as number;
    h6 = ((h6 + g) >>> 0) as number;
    h7 = ((h7 + h) >>> 0) as number;
  }

  let hexOut = "";
  for (const n of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    // 32-bit big-endian hex
    hexOut += n.toString(16).padStart(8, "0");
  }
  return hexOut;
}
