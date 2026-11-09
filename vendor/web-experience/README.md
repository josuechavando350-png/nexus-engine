# NEXUS Web Experience Toolkit

Four upstream repositories are retained as **pinned Git submodules** for selective
reuse. These are third-party sources, not exclusive NEXUS intellectual property.
No client is changed and no library is automatically added to a browser bundle.

| Module | Source snapshot | Use |
| --- | --- | --- |
| `scroll-rig` | `123663599e4b31af56f1845a19132d17e6a9b81f` | React/WebGL and DOM scroll synchronization |
| `seam-transitions` | `54ce5b6480b0502e0afa8781a6130b84638b77a3` | 11 upstream transition experiments |
| `photoswipe` | `cd41cb587a460634e4cae53134f3d01d06e284a6` | Image lightbox/gallery |
| `embla-carousel` | `0fe65834136f1aa35e4c1a4a477e5ccb4bb5ee54` (v8.6.0) | Touch carousel; deliberately not upstream v9 RC |

From the repository root:

```sh
node scripts/web-experience.mjs list
node scripts/web-experience.mjs fetch all
node scripts/web-experience.mjs verify all --sources
```

To retrieve only one source, replace `all` with its module id. Downloading sources
requires Git and network access but does **not** run upstream package scripts.
A normal checkout without submodules still builds NEXUS as before. A GitHub ZIP
is not a recursive clone; use Git and the commands above for source retrieval.

`registry.json` records upstream identities, commits, license fingerprints and
activation requirements. The CLI refuses floating revisions, index drift,
modified source checkouts and mismatching license files. It never follows an
upstream branch with `--remote` and never uses `--force` to overwrite local work.

See [integration guide](../../docs/WEB_EXPERIENCE_TOOLKIT.md) for app-owned imports,
adapters, accessibility requirements and the distinction between source adoption
and production validation.

## License/provenance cautions

Keep upstream notices with redistributed source. All four pinned LICENSE files
contain MIT terms. Scroll Rig's pinned package.json instead declares ISC; this
inconsistency is explicitly retained in the registry and must be reviewed for the
actual distribution used. This is not a blanket clearance of transitive assets.

SeamTransitions is a demo collection, not an installable NEXUS component. Its GSAP
plugins, external fonts, photographs and other assets require separate review.
The original demos reference external dependencies; fetching the repositories
does not make their demos fully offline. Do not copy demo branding into Core.
