/* Format — Audio. The parts of the Audio section of the Format tool on
   subnsub.com that touch your samples: the guards, the multichannel
   down-mix, the PCM quantiser, the WAV writer and the output naming.
   Kept in lockstep with the in-page version.

   What is NOT here, and why: MP3, OGG Vorbis, FLAC and AAC are produced by
   third-party encoders the site vendors — wasm-media-encoders (MP3 and
   Vorbis), libflacjs (FLAC) and the browser's own WebCodecs AudioEncoder
   muxed with mp4-muxer (AAC). Those are somebody else's code and are not
   republished here. What this module holds is everything of ours that runs
   before and around them, which is where the decisions live: how many
   samples we agree to load, how a 5.1 source is folded to stereo, how a
   float sample becomes an integer. WAV needs no encoder at all, so it is
   written out in full below and doubles as a runnable reference for the
   quantiser the other paths share.

   The site drives the encoders from a Blob worker, so a long encode never
   blocks the page; the shapes below (`EncodeJob`) are exactly what it
   posts across. Nothing is uploaded on any path.

   Browser-only where noted (decodeAudioData needs an AudioContext); the
   pure functions run anywhere.

   Error codes on err.code: 'big', 'empty', 'decode', 'toolong',
   'channels'. */

/* decodeAudioData runs on the main thread and inflates the file to raw
   PCM — roughly tenfold for a 128 kbps MP3, far more for a low-bitrate
   one — and then each encoder allocates another copy. So the ceilings are
   deliberately low: 30 MB in, half an hour long, which is already
   hundreds of megabytes of samples. The byte check is what bounds decode;
   the duration check is a second guard, after. */
export const MAX_BYTES = 30 * 1024 * 1024;
export const MAX_SECONDS = 30 * 60;

export const AUDIO_FORMATS = {
  wav:  { ext: 'wav',  mime: 'audio/wav',  lossless: true },
  flac: { ext: 'flac', mime: 'audio/flac', lossless: true },
  mp3:  { ext: 'mp3',  mime: 'audio/mpeg', lossless: false },
  ogg:  { ext: 'ogg',  mime: 'audio/ogg',  lossless: false },
  aac:  { ext: 'm4a',  mime: 'audio/mp4',  lossless: false },
};

export const BITRATES = [96, 128, 192, 256, 320];

/* Vorbis is VBR: the kbps numbers above are a familiar dial, and this maps
   each onto the encoder's own quality scale. */
export const VORBIS_QUALITY = { 96: 3, 128: 5, 192: 6, 256: 8, 320: 10 };

function codeErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/* Reject before decoding: an oversized or empty file never reaches the
   AudioContext. Throws 'big' / 'empty'. */
export function checkSource(file) {
  if (!file || file.size === 0) throw codeErr('empty');
  if (file.size > MAX_BYTES) throw codeErr('big');
  return file;
}

/* Fold an arbitrary channel layout down to what the encoders take.
   Mono and stereo pass through untouched. Quad and 5.1 use the standard
   Web Audio matrices, by channel order:

     quad [L R SL SR]        Lo = ½(L + SL)            Ro = ½(R + SR)
     5.1  [L R C LFE SL SR]  Lo = L + .7071(C + SL)    Ro = R + .7071(C + SR)

   LFE is dropped, as the spec does, and the sums are clamped on output.
   Any other layout above stereo (3.0, 6.1, 7.1, …) has no reliable stereo
   matrix, so it is refused ('channels') rather than mis-routed — sending
   a surround channel to the wrong speaker is worse than saying no.

   `buffer` is an AudioBuffer or anything with the same three members.
   Returns Float32Array[] — fresh arrays, safe to transfer. */
export function downmixToStereo(buffer) {
  const srcCh = buffer.numberOfChannels || 1;
  const n = buffer.length;
  if (srcCh <= 2) {
    const out = [];
    for (let c = 0; c < srcCh; c++) out.push(new Float32Array(buffer.getChannelData(c)));
    return out;
  }
  if (srcCh !== 4 && srcCh !== 6) throw codeErr('channels');
  const dl = new Float32Array(n), dr = new Float32Array(n), s = [];
  for (let c = 0; c < srcCh; c++) s.push(buffer.getChannelData(c));
  const five = srcCh === 6;
  for (let i = 0; i < n; i++) {
    let lv, rv;
    if (five) {
      const cc = s[2][i] * 0.7071;
      lv = s[0][i] + cc + 0.7071 * s[4][i];
      rv = s[1][i] + cc + 0.7071 * s[5][i];
    } else {
      lv = 0.5 * (s[0][i] + s[2][i]);
      rv = 0.5 * (s[1][i] + s[3][i]);
    }
    dl[i] = lv < -1 ? -1 : lv > 1 ? 1 : lv;
    dr[i] = rv < -1 ? -1 : rv > 1 ? 1 : rv;
  }
  return [dl, dr];
}

/* Decoded buffer → the job an encoder consumes. Throws 'toolong' past the
   duration ceiling and 'channels' on a layout we will not fold.
   `format` and `bitrate` are carried through untouched. */
export function buildEncodeJob(buffer, { format = 'wav', bitrate = 192 } = {}) {
  if (buffer.duration > MAX_SECONDS) throw codeErr('toolong');
  const channels = downmixToStereo(buffer);
  return { format, bitrate, sampleRate: buffer.sampleRate, length: buffer.length, channels };
}

/* Decode a file into an AudioBuffer. decodeAudioData may resample to the
   context's rate — the AudioBuffer's OWN sampleRate is what the job then
   carries, so the output stays coherent either way. Browser only. */
export async function decodeAudio(file) {
  checkSource(file);
  const ab = await file.arrayBuffer();
  const AC = (typeof AudioContext !== 'undefined' && AudioContext)
    || (typeof globalThis !== 'undefined' && globalThis.webkitAudioContext);
  if (!AC) throw codeErr('decode');
  const ctx = new AC();
  try {
    return await ctx.decodeAudioData(ab);
  } catch (_) {
    throw codeErr('decode');
  } finally {
    try { ctx.close(); } catch (_) { /* already closed */ }
  }
}

/* Float sample → signed 16-bit, clamped. Asymmetric on purpose: full
   scale is -32768…+32767, so the negative and positive halves scale by
   different factors. Every integer path in this tool goes through here. */
export function clamp16(s) {
  s = s < -1 ? -1 : s > 1 ? 1 : s;
  return s < 0 ? s * 0x8000 : s * 0x7FFF;
}

/* Interleave a slice of planar float channels into signed 16-bit
   integers — the shape libflacjs' process call wants. The site walks the
   file about a second at a time rather than in one pass: progress stays
   live and the allocation stays small, instead of one array the length of
   the whole song. */
export function interleaveInt16(channels, start, len) {
  const nch = channels.length;
  const out = new Int32Array(len * nch);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) out[i * nch + c] = Math.round(clamp16(channels[c][start + i]));
  }
  return out;
}

/* 16-bit PCM WAV, written here in full — no encoder involved. Takes an
   encode job (or any { channels, length, sampleRate }) and returns the
   file bytes. */
export function encodeWav(job) {
  const ch = job.channels, n = job.length, nch = ch.length, sr = job.sampleRate;
  const blockAlign = nch * 2, dataLen = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let k = 0; k < s.length; k++) dv.setUint8(o + k, s.charCodeAt(k)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                 /* PCM */
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) { dv.setInt16(off, clamp16(ch[c][i]), true); off += 2; }
  }
  return new Uint8Array(buf);
}

/* Output name: the source's base name with the new extension. Path
   separators and control characters are stripped — a download name is
   still a file name. */
export function outputName(sourceName, ext) {
  const base = String(sourceName || 'audio')
    .replace(/\.[^.]*$/, '')
    .replace(/[/\\\x00-\x1F\x7F]/g, '') || 'audio';
  return base + '.' + ext;
}
