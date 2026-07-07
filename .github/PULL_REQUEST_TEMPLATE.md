<!-- New tool? Please open a "tool proposal" issue first if you haven't —
     it protects your time. Link it below. -->

**Proposal / issue:** #

**What this adds or changes:**

---

Checklist (see [CONTRIBUTING.md](https://github.com/subnsub-tools/community-tools/blob/main/CONTRIBUTING.md) for the long form):

- [ ] One self-contained directory: `tools/<id>/` with the core module, `demo.html`, `README.md` (for changes to an existing tool: scope stays inside its directory)
- [ ] Core module is dependency-free and never touches DOM / network / storage
- [ ] Size & count caps exported as constants and enforced at the entry points
- [ ] Malformed input fails closed — truncated/lying inputs were actually tried
- [ ] `demo.html` drives the change end to end from a bare `python3 -m http.server`
- [ ] No minified or generated code; comments match the existing style
- [ ] This is my own work — anything derived from someone else's code or spec is declared above
- [ ] I have the right to submit this and agree to license it under AGPL-3.0
