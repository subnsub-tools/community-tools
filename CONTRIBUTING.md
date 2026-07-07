# Contributing

The Community tab on [subnsub.com](https://subnsub.com) grows in one of two
ways: someone asks for a tool, or someone builds one. Both start in this
repository, and both are open to anyone.

## Ground rules — what fits this collection

Every tool here makes the same promise, so every submission must keep it:

- **Client-side only.** All the work happens in the browser. No servers, no
  uploads, no accounts, no telemetry, no analytics. If the job fundamentally
  needs a backend, it doesn't fit this collection.
- **Dependency-free core.** One ES module a reviewer can read top to bottom.
  No npm packages, no build step, no minified or generated code. (The pinned
  pdf-lib reference is a grandfathered exception that belongs to the existing
  `tools/pdf` only — new tools ship with zero dependencies, no exceptions.)
- **One tool, one job.** A small, sharp scope beats a Swiss Army knife.
- **Not a duplicate.** If an existing tool almost does it, improve that
  module instead — a focused PR to an existing tool lands much faster than a
  new one.

Not sure whether an idea fits? Open a request first and ask — that costs
nothing.

## Track 1 — request a tool (no code needed)

Open a **[tool request](https://github.com/subnsub-tools/community-tools/issues/new/choose)**
and describe:

1. what goes in and what comes out,
2. the situation where you'd reach for it,
3. anything you know about why it can run purely in the browser.

That's the whole job. A maintainer will label it `accepted`, `needs-info`,
or `declined` (always with a reason). Accepted requests are built by the
maintainers and go through the same review as any other code.

## Track 2 — build it yourself (pull request)

If you want to write the tool, open a
**[tool proposal](https://github.com/subnsub-tools/community-tools/issues/new/choose)**
issue *before* you start coding. It's a two-minute form and it protects your
time: we'll confirm the idea fits (or explain why not) before you invest in
an implementation.

### The shape of a tool

Each tool is one self-contained directory. Copy the layout of any existing
one (`tools/exif/` is a good small example):

```
tools/<id>/
  <name>.js     the core module — all the logic, zero dependencies
  demo.html     a plain, unstyled page that drives the module end to end
  README.md     what it does, the exported API, and design/hardening notes
```

**The core module** is where the rules are strict:

- Plain JavaScript ES module. Exports functions and constants; never touches
  `document`, `window`, the network, or storage. Input is raw data
  (`Uint8Array`, `File`, `ImageData`, strings); output is raw data. All DOM
  work lives in the demo page.
- **Limits are part of the API.** Export size/count caps as constants
  (`MAX_BYTES`, `MAX_PIXELS`, …) and enforce them at the entry points —
  before any expensive parsing or decoding runs.
- **Errors carry a machine-readable code**: throw
  `Object.assign(new Error('big'), { code: 'big' })`-style errors and let
  the caller map codes to wording. Existing modules share this convention.
- **Fail closed on malformed input.** A truncated header, an impossible
  declared length, a decompression-bomb-shaped file — reject them; never
  guess. Assume every input is adversarial. This is what review will probe
  hardest.
- Style: match the existing modules (2-space indent, single quotes, comments
  explain *constraints*, not what the next line does).

**The demo page** proves the module works without any site plumbing: plain
HTML, one `<script type="module">`, no external resources (the pdf demo's
pinned pdf-lib fetch is grandfathered, not a precedent), no CSS framework.
It must run from a bare static server:

```
python3 -m http.server 8000
# → http://localhost:8000/tools/<id>/demo.html
```

### What review looks at

Expect concrete change requests — almost every tool that's now live went
through several. The checklist reviewers work from:

1. **Correctness** on well-formed input, verified against the demo.
2. **Malformed-input behaviour** — truncated files, lying length fields,
   forged magic bytes, zero-byte input. Fail-closed, no hangs, no memory
   blowups.
3. **Caps enforced at the entry**, not after the expensive work.
4. **No hidden I/O** — no network calls, no storage writes, no `eval` or
   `new Function`, nothing minified or obfuscated.
5. **Browser baseline** — current Chrome, Firefox and Safari without
   transpilation.

### What happens after the merge

Merging into this repository and appearing on subnsub.com are separate
steps:

1. **Merge** — your module lands here under AGPL-3.0, credited to your
   GitHub account (we merge preserving you as the commit author; substantial
   maintainer-side changes land as their own commits or are noted in the
   merge, so authorship stays honest in both directions).
2. **Site integration** — the maintainers wrap the module in the site's UI,
   design system, translations and offline plumbing. You don't do any of
   this part, and the site version's logic is kept in lockstep with your
   module here.
3. **Launch** — the tool appears in the Community tab with a credit line:
   *by \<your GitHub username\>* linking back to its directory in this repo.

A merged tool is expected to launch once integration and final checks are
done — usually days, not months, though a late-stage security or legal snag
can still stop one. If site-side constraints force any change to the logic
itself, it happens as a visible PR against your module here, not as a
silent divergence.

## Licensing

This repository is AGPL-3.0. By opening a pull request you confirm the
contribution is yours to license — your own work, with anything derived
from someone else's code or spec declared in the PR — and you agree to
license it under AGPL-3.0. You keep your copyright; no CLA, no paperwork.
Undisclosed copied code is grounds for rejection, or removal if it's found
after a merge. "SUB&SUB", "subnsub" and the site's visual identity remain
unlicensed by this repository.

## Security issues in existing tools

If you've found a security problem (a parser that can be crashed into
misbehaving, a guard that can be bypassed), please use
**[private vulnerability reporting](https://github.com/subnsub-tools/community-tools/security/advisories/new)**
rather than a public issue, so a fix can land before the details do. If that
form is unavailable to you, open an issue titled `[security]` with just
enough detail to make contact — hold the proof-of-concept until we respond.
