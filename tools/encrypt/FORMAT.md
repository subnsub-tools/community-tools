# SNSE1 container format

`.snse` files produced by the File Encrypt tool are versioned, self-contained
containers. This document specifies the format completely, so that anyone can
implement an independent decryptor — your files are never locked to our code.

## Layout

| offset | length | content |
|-------:|-------:|---------|
| 0 | 5 | magic: ASCII `SNSE1` (`53 4E 53 45 31`) |
| 5 | 16 | PBKDF2 salt, random per file |
| 21 | 12 | AES-GCM IV (nonce), random per file |
| 33 | rest | AES-256-GCM ciphertext, 16-byte auth tag appended (WebCrypto layout) |

## Key derivation

```
key = PBKDF2-HMAC-SHA256(passphrase-UTF8, salt, iterations = 600000, dkLen = 32)
```

The passphrase is the user's string encoded as UTF-8, no normalisation.

## Plaintext frame

Decrypting the ciphertext yields:

| offset | length | content |
|-------:|-------:|---------|
| 0 | 4 | `metaLen` — big-endian u32 |
| 4 | metaLen | meta: UTF-8 JSON `{"n": name, "t": MIME type, "s": size}` |
| 4 + metaLen | rest | the original file bytes, unchanged |

`metaLen` is bounded: a conforming reader rejects `metaLen > remaining` or
`metaLen > 65536` as malformed. Malformed meta **JSON** (frame intact, JSON
unparseable) should be tolerated: GCM already authenticated the payload, so
recover the data under a fallback name rather than refuse a decryptable file.

## Failure semantics

AES-GCM is authenticated, so a wrong passphrase and a corrupted file are the
same, indistinguishable failure. Honest tooling reports them as one case.

A reader restoring `n` as a local filename should sanitise it (strip path
separators, control characters and bidi-override characters) — the field is
authenticated but still originates from whoever built the container.

## Reference decryptor (Python)

Requires `pip install cryptography`.

```python
import json, re, struct, sys
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def snse1_open(container: bytes, passphrase: str):
    if container[:5] != b"SNSE1" or len(container) < 34:
        raise ValueError("not an SNSE1 container")
    salt, iv, ct = container[5:21], container[21:33], container[33:]
    key = PBKDF2HMAC(SHA256(), 32, salt, 600000).derive(passphrase.encode())
    plain = AESGCM(key).decrypt(iv, ct, None)   # raises on wrong passphrase
    if len(plain) < 4:
        raise ValueError("malformed frame")
    (mlen,) = struct.unpack(">I", plain[:4])
    if mlen > len(plain) - 4 or mlen > 65536:
        raise ValueError("malformed frame")
    try:
        meta = json.loads(plain[4 : 4 + mlen])
    except ValueError:
        meta = {}
    return meta.get("n", "decrypted.bin"), plain[4 + mlen :]

def safe_name(name: str) -> str:
    # the sanitisation the spec asks of readers: path separators, reserved
    # chars, C0/C1 controls and bidi/invisible direction marks
    name = re.sub(r'[/\\:*?"<>|\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]', "_", name)
    return name[:200] or "decrypted.bin"

if __name__ == "__main__":
    name, data = snse1_open(open(sys.argv[1], "rb").read(), sys.argv[2])
    out = "recovered-" + safe_name(name)
    open(out, "wb").write(data)
    print(f"wrote {out} ({len(data)} bytes)")
```

Usage: `python snse1_decrypt.py sealed.snse "your passphrase"`.

## Versioning

The magic doubles as the version. A future format change will ship under a
new magic (`SNSE2`, …); `SNSE1` files will always decrypt as specified here.
