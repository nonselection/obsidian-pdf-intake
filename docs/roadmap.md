# PDF Intake roadmap

Status: working roadmap  
Last updated: 2026-10-11

This document records planned product directions, deferred questions and explicit non-goals. Current behavior and architecture are described in [architecture.md](architecture.md).

## Near-term: explicit-session redesign

The target replaces the configured intake-folder queue with a fresh empty session and explicit vault-scoped PDF addition. Presence defines scope; no permanent inclusion checkboxes, automatic scans or ordinary global Resolve button remain in the target interaction.

### Implemented: session, repair and draft recovery

The session/configuration foundation, coordinated persistence, canonical authorship, explicit vault-scoped PDF admission, bounded automatic identification, stable membership-ordered cards, contextual inspection and repair, unfinished-session draft recovery, pure rename planning, frozen invocation model, and rename-only ApplyChangesService are implemented. A new session copies detached defaults. An admitted unfinished session recovers its own configuration after an explicit decision. The Settings Defaults section begins with the workspace-edit policy, then default Output and Metadata & naming.

Begin review requires positive membership and starts identification automatically. The working surface shows Identifying, Needs you and Ready counts in fixed order, with no global Resolve action. Contextual inspection exposes bounded evidence and explicit DOI/ISBN lookup, candidate selection, manual record Save, retry, and leave-unresolved actions. Only eligible Ready changes can enter the frozen Apply scope. PDF text extraction is limited to the first three pages and starts only during review. After first successful PDF admission, an unfinished session is saved in a bounded versioned draft and requires Resume or confirmed discard on reload.

### Deferred product work

Embedded PDF metadata writeback and later artifact/recovery capabilities remain future work. Final visual/accessibility and mobile/iPad qualification also remain outstanding. Do not reintroduce folder scanning as a substitute for explicit admission.

Setup concerns are **PDFs**, **Output**, **Metadata & naming**. The PDFs concern shows the explicit manifest before review. Working mode keeps stable visible cards and explicit Apply of the Ready subset. Difficult PDFs remain in the session until repaired or explicitly left unresolved.

Existing view reuse/reveal, shared resolver, filename sanitation and isolated lazy PDF.js worker behavior remain in place.

The ribbon action already exists in current source and shares the command's open/reveal method. It is no longer pending work.

### Output/defaults UX

The default keeps each PDF in its own current folder, regardless of where it was added from. Another existing vault folder can be chosen; invalid/unset destinations must be unmistakable and block Apply without blocking identification. Do not silently create folders.

Plugin Settings shows a Defaults section with workspace-edit persistence policy first, followed by actual defaults. Workspace changes either become future defaults (factory policy) or stay in the current session. Recovery restores the draft's values, regardless of later defaults.

### Filename-template builder

Move away from requiring users to type placeholder syntax such as `{author}` manually.

The naming model must support:

- arbitrary ordered and repeated components;
- literal separators/punctuation between chips;
- immediate concrete filename examples;
- clear behavior for missing optional fields.

Field-specific formatting and a structure without a mandatory three-slot limit are required. Exact builder controls/gestures remain a design question for the relevant slice; early setup can preserve existing template semantics with an example.

Canonical authorship and derived representations are now separate approved concepts. Preserve the full ordered author list and provider-supplied structure; do not truncate canonical data for filenames or infer surnames from unstructured strings.

The factory convention is `<first-author family name>[ et al.] (<year>). <title>`, for example `Tesar (2023). Example Title.pdf` or `Chilisa et al. (2016). Decolonizing and Indigenizing Evaluation Practice in Africa.pdf`. Slice 1 establishes this factory representation. Valid existing user templates remain exact preferences; only absent/invalid preferences use the new factory convention.

The eventual builder offers a parameterized authorship component family: first/all authors, family-only/abbreviated-given/full names, optional conditional `et al.`, explicit name ordering and separators. Labels/controls remain later design work. Current `{author}` / `{authors}` tokens are compatibility aliases, not the new canonical abstraction. Institutions, mononyms and unstructured names use conservative literal fallback with diagnostics rather than guessed family names.

Canonical authorship and filename representations remain separate. Current Crossref and Open Library adapters preserve ordered positions and explicit incompleteness; Open Library detail requests are bounded without truncating the canonical sequence. See the [current provider contract](architecture.md#current-provider-authorship-evidence).

### Intake view qualification

The contextual inspector and card UI are implemented, but final qualification is not complete.

Continue to review:

- information hierarchy;
- status visibility;
- session membership/add/remove affordances;
- compact vs expanded evidence presentation;
- mobile/iPad layout;
- path presentation;
- batch action placement;
- post-process feedback.

The fixed working context bar keeps Edit session/state on the left, status information in Identifying → Needs you → Ready order, and Apply changes on the right. Zero states may disappear without reordering. Do not require a total PDF count or move cards for state progression. Inspectors are contextual, explicitly closable and have no permanent right rail or nested modal chain. Grayscale-readable structure, selectable text and responsive/accessibility basics remain qualification requirements. Slice 4 does not claim pixel-level polish or mobile/iPad qualification.

Avoid returning to a wide spreadsheet/table layout.

## Resolver follow-up

Automatic identification retains bounded DOI/ISBN evidence from the first three PDF pages, local normalization, direct identifier lookup with exact local-title corroboration, and bounded title search through Crossref and Open Library. The inspector presents bounded current evidence. A direct manual DOI/ISBN lookup uses one mapped provider request, while explicit retry reruns the bounded automatic pipeline. Manual provider success still requires deliberate user acceptance.

Further resolver changes remain evidence-driven. When a controlled PDF exposes a failure, capture the smallest useful fixture where appropriate, inspect the actual PDF.js text and identify whether the cause is the three-page window, line wrapping/encoding, text-item order, extraction, normalization, or provider lookup. Add regression tests for understood failures before changing extraction or provider scope. Do not add OCR, full-document indexing, fuzzy matching or new providers as a shortcut, and do not turn failed identification into invented metadata.

Progress feedback names only the stage actually underway and does not use fabricated percentages. Failed and ambiguous outcomes remain available for inspection and explicit repair.

## Core next capability: embedded PDF metadata normalization

The product goal is not merely good filenames. A processed PDF should eventually have a clean bibliographic envelope both externally and internally.

The normalized PDF remains the primary artifact. Optional Markdown companions and cover images are later outputs, off by default. Output defines artifact existence/destinations; Metadata & naming defines their bibliographic expression. An artifact model precedes generation. User-authored companion notes cannot be treated like regenerable cover images or silently overwritten. All final writes use the same Apply boundary.

### Define metadata mapping

Decide how resolved bibliographic truth maps into PDF metadata.

Questions include:

- Title;
- Author / multiple authors;
- Subject;
- Keywords;
- Publisher/journal where appropriate;
- DOI;
- ISBN;
- creation vs publication date semantics;
- XMP vs Info dictionary;
- existing conflicting metadata.

Do not overload fields merely because they exist.

### Choose a write library / boundary

Evaluate a dedicated PDF writer such as `pdf-lib` or another suitable library.

Keep the write operation behind a very small boundary so the rest of the plugin does not depend on library-specific mutation APIs.

Conceptually:

```ts
rewritePdfMetadata(sourceBytes, normalizedMetadata)
  -> replacementBytes
```

The current upstream writeback implementation should not be restored wholesale merely because it already existed.

### Make "processed" mean bibliographically normalized

Once metadata writeback ships, filename equality must not imply that a PDF needs no processing.

A correctly named PDF with bad internal metadata still requires normalization.

Revisit the current `unchanged` state accordingly.

## Robustness, sync and recovery

This work depends on verified evidence about Obsidian, the host filesystem and sync behavior.

Session-draft preservation restores unfinished work and cannot certify or replay a file operation. Cross-reload source trust is exact path plus PDF extension plus matching finite mtime/size; it is not byte-level identity. Binary writeback remains gated on a reviewed safe replacement/interruption/recovery design. Verified findings may change the required scope.

Relevant questions include:

- what filesystem/write events Obsidian and iCloud actually expose;
- behavior if Obsidian crashes during mutation;
- behavior if a device powers off/interruption occurs;
- behavior when devices go offline/online;
- how conflicting versions appear;
- rename/replacement behavior under iCloud;
- whether temporary siblings are synced/reconciled in surprising ways;
- what evidence can reliably identify that a source changed during processing.

Once those findings are available, design PDF Intake's guarded processing path.

Likely concerns:

- source fingerprint/revision before work;
- generation of replacement bytes without touching the canonical source;
- validation that generated bytes reopen as a PDF;
- validation that intended metadata is present;
- recheck that source did not change before commit;
- safest available replace/rename sequence;
- recovery markers/state only if actually required;
- explicit handling of partial completion and sync conflicts.

Do not build speculative transaction machinery before the platform behavior is understood.

## Later / evidence-driven

Potential future improvements, only if real use justifies them:

- additional manual bibliographic fields after real repair use establishes a need;
- file-operation recovery behavior after verified platform evidence and a separate design;
- explicit metadata-only reprocess action;
- additional filename presets;
- more sophisticated author-name formatting/localization.

Drag/drop and external-file import remain feasibility questions outside the vault chooser. Provider/title-search expansion remains evidence-driven rather than inferred from visual references.

## Explicit non-goals

PDF Intake should remain small.

Unless the product definition changes, do not expand into:

- OCR;
- image-to-text processing;
- PDF compression;
- page manipulation;
- PDF annotation tooling;
- citation-manager/library replacement;
- general document conversion;
- automatic watched-folder processing;
- broad filesystem organization outside the configured intake workflow.
