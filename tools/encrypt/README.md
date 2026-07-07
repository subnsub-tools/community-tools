# File Encrypt

Password-seal any file entirely in the browser — AES-256-GCM via WebCrypto,
nothing ever uploaded. This is the core logic of the
[File Encrypt tool on subnsub.com](https://subnsub.com), published so the
"your file never leaves your device" claim is auditable and the container
format is independently implementable.

## Files

- [`encrypt.js`](encrypt.js) — the module: `seal()`, `open()`, `looksSealed()`
- [`FORMAT.md`](FORMAT.md) — the `.snse` container specification, including a
  ~30-line Python reference decryptor. **Your files are never locked to our
  code or our site.**
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { seal, open, looksSealed } from './encrypt.js';

const sealed = await seal(fileBytes, { name: 'photo.jpg', type: 'image/jpeg' }, 'passphrase');
// → Uint8Array (.snse container)

const { name, type, bytes } = await open(sealed, 'passphrase');
// err.code === 'magic' → not an SNSE1 container
// err.code === 'pass'  → wrong passphrase or corrupted (GCM cannot tell apart)
// err.code === 'big'   → input over the 512 MB cap (either direction)
```

Requires a secure context (HTTPS or localhost) — `crypto.subtle` does not
exist elsewhere.

## Security model

- Key = PBKDF2-HMAC-SHA256, 600 000 iterations; fresh 16-byte salt and
  12-byte IV per file.
- AES-256-GCM authenticates everything: a wrong passphrase and a tampered
  file are the same failure, and the tool says so honestly.
- **There is no recovery.** No key escrow, no reset — a lost passphrase means
  the data is gone. That is the point.
- Whole-buffer operation (no streaming); inputs are bounded to 512 MB.
