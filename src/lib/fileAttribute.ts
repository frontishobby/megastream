import { File } from 'megajs';

export type FaType = 0 | 1;

interface FaEntry {
  type: number;
  hash: string;
}

interface FileWithFa extends File {
  fa?: string;
}

let patched = false;
export function patchMegaForFa(): void {
  if (patched) return;
  const proto = (File as unknown as { prototype: Record<string, unknown> }).prototype;
  const original = proto.loadMetadata;
  if (typeof original !== 'function') return;
  proto.loadMetadata = function (this: FileWithFa, aes: unknown, opt: Record<string, unknown>) {
    (original as (a: unknown, o: unknown) => void).call(this, aes, opt);
    const fa = opt?.fa;
    if (typeof fa === 'string' && fa.length > 0) {
      this.fa = fa;
    }
  };
  patched = true;
}

export function parseFa(fa: string | undefined): FaEntry[] {
  if (!fa) return [];
  const out: FaEntry[] = [];
  for (const part of fa.split('/')) {
    const star = part.indexOf('*');
    if (star <= 0) continue;
    const type = Number(part.slice(0, star));
    const hash = part.slice(star + 1);
    if (Number.isFinite(type) && hash) out.push({ type, hash });
  }
  return out;
}

function b64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std.length % 4 ? std + '='.repeat(4 - (std.length % 4)) : std;
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-CTR' }, false, ['encrypt']);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: block as BufferSource, length: 64 },
    k,
    new Uint8Array(16),
  );
  return new Uint8Array(out);
}

// MEGA encrypts FA payloads with AES-CBC, zero IV, and zero-padding to a 16B
// boundary. Web Crypto enforces PKCS7, so we synthesise one trailing ciphertext
// block whose plaintext is exactly 16 bytes of 0x10 — a valid full-block PKCS7
// trailer that Web Crypto then strips, leaving the original zero-padded data.
async function aesCbcDecryptZeroPadded(
  key: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('FA ciphertext length must be a non-zero multiple of 16');
  }
  const lastCt = ciphertext.subarray(ciphertext.length - 16);
  const xored = new Uint8Array(16);
  for (let i = 0; i < 16; i++) xored[i] = 0x10 ^ lastCt[i];
  const synthetic = await aesEcbEncryptBlock(key, xored);

  const extended = new Uint8Array(ciphertext.length + 16);
  extended.set(ciphertext);
  extended.set(synthetic, ciphertext.length);

  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: new Uint8Array(16) },
    k,
    extended,
  );
  return new Uint8Array(plain);
}

function trimJpegPadding(buf: Uint8Array): Uint8Array {
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) return buf.subarray(0, i + 2);
  }
  return buf;
}

export async function fetchFileAttribute(
  file: FileWithFa,
  type: FaType,
): Promise<Blob | null> {
  const entries = parseFa(file.fa);
  const entry = entries.find((e) => e.type === type);
  if (!entry) return null;

  const rawKey = file.key as Uint8Array | null;
  if (!rawKey || rawKey.length < 16) return null;
  const keyBytes = new Uint8Array(rawKey.buffer, rawKey.byteOffset, 16);

  const handleBytes = b64UrlDecode(entry.hash);
  if (handleBytes.length !== 8) return null;

  const resp = (await file.api.request({
    a: 'ufa',
    fah: entry.hash,
    r: 1,
    ssl: 2,
    v: 3,
  } as unknown as JSON)) as unknown as { p?: string };
  const posturl = resp?.p;
  if (!posturl) return null;

  const fetchRes = await fetch(posturl, { method: 'POST', body: handleBytes as BodyInit });
  if (!fetchRes.ok) throw new Error(`FA fetch failed: ${fetchRes.status}`);
  const respBuf = new Uint8Array(await fetchRes.arrayBuffer());
  if (respBuf.length < 12) throw new Error('FA response too short');

  const view = new DataView(respBuf.buffer, respBuf.byteOffset, respBuf.byteLength);
  const len = view.getUint32(8, true);
  if (len <= 0 || len % 16 !== 0 || respBuf.length < 12 + len) {
    throw new Error('FA response payload malformed');
  }
  const ciphertext = respBuf.subarray(12, 12 + len);
  const plain = await aesCbcDecryptZeroPadded(keyBytes, ciphertext);
  const jpeg = trimJpegPadding(plain);
  return new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
}
