# PDF Intake roadmap

Status: working roadmap  
Last updated: 2026-10-07

This document records planned product directions and deferred questions. The implemented baseline and approved target decisions are distinguished in [architecture.md](architecture.md). The [overall implementation plan](implementation-plan.md) owns redesign delivery boundaries/dependencies; detailed Codex plans will be written one slice at a time under `.codex/plans/`. This roadmap is not an execution plan.

## Near-term: explicit-session redesign

The target replaces the configured intake-folder queue with a fresh empty session and explicit vault-scoped PDF addition. Presence defines scope; no permanent inclusion checkboxes, automatic scans or ordinary global Resolve button remain in the target interaction.

Setup concerns are **PDFs**, **Output**, **Metadata & naming**. The initial rail stays present; the PDFs concern shows the admitted manifest before review. Begin review requires at least one PDF and starts automatic read-only identification. Working mode keeps stable visible cards, contextual inspection/repair and explicit Apply of the Ready subset. Difficult PDFs remain untouched.

Planned foundations are a session/coordinator, durable defaults versus session values, hierarchical vault chooser and one simple rename-only ApplyChangesService. Unfinished-session draft preservation is planned by Slice 4, substantially before file-operation recovery. Existing view reuse/reveal, shared resolver, filename sanitation/path planning and PDF.js isolation survive.

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

The factory convention is `<first-author family name>[ et al.] (<year>). <title>`, for example `Tesar (2023). Example Title.pdf` or `Chilisa et al. (2016). Decolonizing and Indigenizing Evaluation Practice in Africa.pdf`. Valid existing user templates remain exact preferences; only absent/invalid preferences use the new factory convention.

The eventual builder offers a parameterized authorship component family: first/all authors, family-only/abbreviated-given/full names, optional conditional `et al.`, explicit name ordering and separators. Labels/controls remain later design work. Current `{author}` / `{authors}` tokens are compatibility aliases, not the new canonical abstraction. Institutions, mononyms and unstructured names use conservative literal fallback with diagnostics rather than guessed family names.

Slice 1 establishes canonical types and the pure formatter/component seam without the full builder. Before Slice 3 automatic identification, fix current provider-mapping losses: Crossref flattens given/family and drops unsupported entries; Open Library caps references at five and skips failures. Preserve all ordered references/positions and explicit incompleteness; verify actual provider fields before mapping additional structure. See the [source audit and durable contract](architecture.md#current-provider-authorship-evidence-and-delivery-dependency).

### Intake view polish

The current card UI is pragmatic and usable but not final.

Review:

- information hierarchy;
- status visibility;
- session membership/add/remove affordances;
- compact vs expanded problem states;
- mobile/iPad layout;
- path presentation;
- batch action placement;
- post-process feedback.

The fixed working context bar keeps Edit session/state on the left, status information in Identifying → Needs you → Ready order, and Apply changes on the right. Zero states may disappear without reordering. Do not require a total PDF count or move cards for state progression. Inspectors are contextual, explicitly closable and have no permanent right rail or nested modal chain. Grayscale-readable structure, selectable text and responsive/accessibility basics are requirements throughout delivery.

Avoid returning to a wide spreadsheet/table layout.

## Resolver hardening

### Investigate missed visible DOIs

Several real PDFs visibly contain a DOI that current automatic detection did not find.

Before adding providers or large heuristics:

1. capture representative failing PDFs in the development test set where legally/practically appropriate;
2. inspect the actual text PDF.js extracts from the first pages;
3. determine whether failures come from:
    - DOI outside the current page window;
    - line breaks or inserted whitespace;
    - punctuation/encoding artifacts;
    - text-layer ordering;
    - extraction failure;
    - identifier-regex normalization;
    - provider lookup rather than extraction.

Add regression tests for understood failure modes.

### Better progress/system feedback

When resolution is taking place, surface truthful stage information, for example:

- extracting PDF text;
- checking detected DOI;
- querying Crossref;
- checking detected ISBN;
- querying Open Library;
- trying manual identifier.

Do not fake progress percentages.

### Resolver fallback strategy

After failure modes are understood, evaluate whether to add:

- stronger DOI/ISBN normalization;
- additional page-window strategies;
- title/author fallback search;
- additional bibliographic providers.

Any provider addition should have a clear reason, defined data mapping, error behavior and test coverage.

Do not turn failed identification into invented metadata.

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

This work is intentionally dependent on evidence from the sibling plugin's iCloud/sync spikes.

Session-draft preservation restores unfinished work and cannot certify or replay a file operation. Binary writeback remains gated on an approved safe replacement/interruption/recovery design; labeling broader robustness as Slice 8 does not permit Slice 7 to ship before that prerequisite. Verified findings may bring required robustness work earlier.

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

- richer metadata-field editing after an explicit repair/save interaction is designed;
- repair/retry surface for interrupted operations;
- explicit metadata-only reprocess action;
- additional filename presets;
- more sophisticated author-name formatting/localization.

Drag/drop and external-file import remain feasibility questions outside the baseline vault chooser. Provider/title-search expansion remains evidence-driven rather than inferred from visual references.

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
