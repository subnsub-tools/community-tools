/* SNSE1 — password file sealing. Core logic of the File Encrypt tool on
   subnsub.com, kept in lockstep with the in-page version.

   Container format (versioned by the magic — see FORMAT.md):
     bytes 0-4   "SNSE1"
     bytes 5-20  PBKDF2 salt (16, random per file)
     bytes 21-32 AES-GCM IV (12, random per file)
     bytes 33-   AES-256-GCM ciphertext of: u32BE metaLen | meta JSON
                 {n:name,t:type,s:size} | raw file bytes

   Key = PBKDF2-SHA256, 600 000 iterations. GCM authentication makes
   "wrong passphrase" and "corrupted file" the same failure — callers
   should say so honestly. Whole-buffer operation (no streaming), so
   keep inputs within MAX_BYTES.

   Requires a secure context (HTTPS or localhost): crypto.subtle is
   undefined elsewhere. */

const MAGIC = [0x53, 0x4e, 0x53, 0x45, 0x31]; /* "SNSE1" */
const SALT_LEN = 16;
const IV_LEN = 12;
const HEADER_LEN = 5 + SALT_LEN + IV_LEN;     /* 33 */
const GCM_TAG_LEN = 16;
const META_CAP = 65536;                       /* sanity cap on the meta frame */

export const ITERATIONS = 600000;
export const MAX_BYTES = 512 * 1024 * 1024;
/* Decrypt must admit the container overhead on top of MAX_BYTES, or a file
   sealed exactly at the limit could never be opened again. */
export const MAX_CONTAINER_BYTES = MAX_BYTES + HEADER_LEN + 4 + META_CAP + GCM_TAG_LEN;

function fail(code) {
  const e = new Error(code === 'magic' ? 'Not an SNSE1 container.'
    : code === 'pass' ? 'Wrong passphrase or corrupted file.'
    : 'Could not process this input.');
  e.code = code;
  return e;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

async function deriveKey(passphrase, salt) {
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/* Cheap "is this one of ours?" sniff — true when the buffer starts with the
   SNSE1 magic. Only the first 5 bytes are looked at. */
export function looksSealed(data) {
  const b = toBytes(data);
  return b.length >= 5 && MAGIC.every((v, i) => b[i] === v);
}

/* Seal raw bytes under a passphrase.
     data       Uint8Array | ArrayBuffer — the file's bytes
     meta       { name, type } — restored verbatim on open()
     passphrase string
   Resolves to a Uint8Array holding the complete .snse container. */
export async function seal(data, meta, passphrase) {
  const bytes = toBytes(data);
  if (bytes.length > MAX_BYTES) throw fail('big');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  /* Cap name/type so the meta frame can never approach META_CAP — a
     writer must not emit containers its own reader would reject. Worst
     case here (1024 + 256 chars, every one JSON-escaped to \uXXXX) stays
     under 8 KB. */
  const metaBytes = new TextEncoder().encode(JSON.stringify({
    n: String((meta && meta.name) || '').slice(0, 1024),
    t: String((meta && meta.type) || '').slice(0, 256),
    s: bytes.length,
  }));
  const plain = new Uint8Array(4 + metaBytes.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, metaBytes.length);
  plain.set(metaBytes, 4);
  plain.set(bytes, 4 + metaBytes.length);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, 5);
  out.set(iv, 5 + SALT_LEN);
  out.set(ct, HEADER_LEN);
  return out;
}

/* Open an SNSE1 container.
   Resolves to { name, type, bytes } — name already sanitised for use as a
   download filename. Rejects with err.code === 'magic' (not our format) or
   'pass' (wrong passphrase / corrupted — GCM cannot tell them apart). */
export async function open(container, passphrase) {
  const b = toBytes(container);
  if (b.length < HEADER_LEN + 1 || !looksSealed(b)) throw fail('magic');
  if (b.length > MAX_CONTAINER_BYTES) throw fail('big');
  const salt = b.slice(5, 5 + SALT_LEN);
  const iv = b.slice(5 + SALT_LEN, HEADER_LEN);
  const ct = b.slice(HEADER_LEN);
  const key = await deriveKey(passphrase, salt);
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch (_) {
    throw fail('pass');
  }
  const plain = new Uint8Array(plainBuf);
  /* Frame bounds before getUint32 — an authenticated-but-malformed plaintext
     (someone hand-rolled a container under a known passphrase) must land on
     the honest "not our format" error, not a RangeError. META_CAP bounds the
     meta frame: real metas are a file name + MIME type, ~1 KB tops. */
  if (plain.length < 4) throw fail('magic');
  const mlen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (mlen > plain.length - 4 || mlen > META_CAP) throw fail('magic');
  /* Bad meta JSON is tolerated on purpose: GCM already authenticated the
     payload, so recover the DATA under fallback name/type rather than
     refusing a decryptable file. */
  let meta = {};
  try { meta = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + mlen))) || {}; } catch (_) {}
  const bytes = plain.slice(4 + mlen);
  const type = typeof meta.t === 'string' && meta.t ? meta.t : 'application/octet-stream';
  let name = typeof meta.n === 'string' && meta.n ? meta.n : 'decrypted.bin';
  /* A download attribute can't escape the downloads dir, but strip control
     chars / path separators / bidi overrides and bound the length anyway so
     a crafted container can't produce a hostile-looking save name. */
  name = name.replace(/[\/\\:*?"<>|\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '_').slice(0, 200) || 'decrypted.bin';
  return { name, type, bytes };
}
