# PDF Intake architecture

Status: Slice 3 implemented; repair, draft recovery, and final mobile/accessibility qualification remain incomplete
Last updated: 2026-10-09

PDF Intake is a small Obsidian plugin for normalizing the bibliographic envelope of existing PDFs.

The target input is a PDF whose document content is already useful/correct but whose filename and/or bibliographic metadata are poor.

The target output is the same document content with a clean, trustworthy bibliographic envelope.

The current implementation provides explicit vault-scoped admission, coordinator-owned automatic identification, the stable working surface and reviewed rename-only Apply. Slice 3 results remain transient across plugin reload. The [redesign contract and architectural seams](#redesign-contract-and-architectural-seams) record the approved target, and the [overall implementation plan](../.codex/architecture/implementation-plan.md) defines its delivery boundaries.

## Product boundary

The complete product is intended to:

- identifying bibliographic works from explicitly selected existing PDFs;
- resolving bibliographic metadata from DOI/ISBN;
- previewing intended changes before mutation;
- normalizing filenames and final vault locations;
- in a later core phase, normalizing embedded PDF bibliographic metadata safely.

PDF Intake is not a general PDF processor.

It does not aim to provide:

- OCR;
- compression/optimization;
- page editing;
- image cleanup;
- annotation management;
- reference-library management;
- background watched-folder automation.

## Current Slice 3 system shape

```text
Open or focus PDF Intake
        ↓
fresh plugin-owned empty session
        ↓
setup: explicit PDFs / Output / Metadata & naming
        ↓
Begin review → bounded automatic identification
        ↓
membership-ordered Identifying / Needs you / Ready cards
        ↓
pure planning → frozen Ready subset → rename-only ApplyChangesService
```

The plugin does not scan folders for membership. PDF bytes remain read-only; explicit Apply changes paths only.

## Main components

### Workspace view and setup shell

PDF Intake is exposed as a custom Obsidian `ItemView` with view type:

`pdf-intake-view`

The view is the durable setup surface. Its Obsidian display name is `PDF Intake`.

The registered command is `Open PDF Intake` (command ID `open-pdf-intake`).

Running the command or ribbon action:

1. find an existing PDF Intake leaf if one exists;
2. reveal/focus it;
3. load it if Obsidian has deferred the custom view;
4. create a new leaf only if no PDF Intake view exists.

The plugin owns one session coordinator for its lifetime. A newly opened session copies effective defaults into detached session values and starts with a fresh identity, zero PDFs, setup open and PDFs selected. Closing and reopening the ItemView does not reset the session. Plugin reload creates a new empty runtime session; Slice 3 membership and identification results are transient and are not restored.

The setup rail always contains PDFs, Output and Metadata & naming. Add PDFs opens the explicit vault-scoped chooser. Begin review is disabled at zero membership and automatically begins identification for current admitted PDFs when membership is positive. Edit session returns to the same setup and preserves completed evidence. Output supports current source folders and a selected existing vault folder, including an explicit vault-root choice. Metadata & naming shows a concrete example and accepts a simple custom template while preserving component-format defaults and exact valid migrated templates.

Working cards stay in session membership order while status changes. Identifying, Needs you and Ready counts appear in that order with zero counts omitted. Planner no-change and verified Applied outcomes are neutral. Apply sends the exact current eligible Ready subset through the frozen invocation and rename-only service.

The workflow deliberately avoids a blocking batch modal because intake work may require switching to PDFs, browser research or other Obsidian tabs and then returning.

### Session and persistence ownership

Session membership is coordinator-owned and comes only from explicit chooser admission. There is no intake-folder scanning or background membership discovery. Identification state, attempt evidence and Apply outcomes remain in memory for the plugin lifetime; no draft write is made.

Plugin data is schema-versioned and separates settings/defaults, workspace edit policy and an opaque unfinished-session draft namespace. One `PluginDataStore` serializes partial updates against the latest successfully saved envelope. Settings patches preserve the draft; draft patches preserve settings. Failed writes do not publish speculative committed values. Local queue ordering is not a crash-atomic or multi-device guarantee.

Known flat legacy settings migrate selectively. `intakeFolder` and `intakeFolders` never become session membership. Valid supported filename templates and unambiguous existing destinations are preserved. An empty or invalid legacy `another` destination becomes current source folders; it is not interpreted as vault root. Corrupt or unknown data stays read-only and is not automatically rewritten. New-model destinations that later disappear remain visible as invalid intent.

Workspace edits copy into defaults only under the committed `future-sessions` policy. `session-only` edits stay in the current session. Later default changes never rewrite an existing session.

### PDF text extraction

The shared resolver's PDF.js 4.10.38 read boundary runs only when Begin review schedules identification. It reads at most the first three pages and forms ordered segments from PDF.js `TextItem.hasEOL`; it does not OCR or inspect the full document.

The build copies the matching `pdf.worker.mjs` into the plugin directory. On first extraction, PDF Intake reads that asset through the vault adapter, creates a Blob-backed module Worker, and assigns that Worker to the bundled PDF.js instance through `GlobalWorkerOptions.workerPort`. Plugin enable/load does not construct a Worker. The Worker is terminated and its Blob URL revoked when the plugin unloads.

The worker handler and PDF.js configuration must stay isolated from renderer globals. PDF Intake must not publish or modify `globalThis.pdfjsWorker` or `window.pdfjsWorker`; enabling it must not alter Obsidian's built-in PDF viewer. The official worker bundle may use its own worker-scope global inside the dedicated Worker.

Extraction:

- reads the PDF through Obsidian's Vault API;
- processes only the three-page window currently requested by the resolver;
- disables unnecessary auto-fetch/stream behavior;
- destroys the PDF document in `finally` after extraction.

PDF.js is a read/parser dependency here, not the future metadata-write library.

### Bibliographic resolver

Begin review starts coordinator-owned automatic identification through the shared resolver. The working surface has no ordinary global Resolve action. Manual DOI/ISBN repair remains deferred.

Current supported provider behavior:

- DOI → Crossref
- ISBN → Open Library

The resolver must not invent missing bibliographic metadata.

A manual DOI/ISBN can be supplied for unresolved/error entries and retried without leaving the workspace.

Known limitation: some real PDFs visibly contain a DOI that current extraction/detection does not find. This is a resolver/extraction quality issue, not expected behavior.

### Provider DTO and canonical bibliographic record

The resolver maps Crossref and Open Library into detached provider records that preserve ordered author positions, structured/literal values, unresolved authors, date evidence and ordered ISBNs. Open Library author-detail lookup is sequential and capped at 50 requests per edition while preserving every supplied position. The resolver returns a typed result that can include:

- title;
- authors;
- first author;
- publication year;
- DOI;
- ISBN;
- journal;
- publisher;
- selected provider and route provenance;
- bounded identifier and provider-attempt evidence.

Successful direct DOI/ISBN results become canonical only when a nonempty provider title exactly matches a bounded normalized PDF title candidate. Query context is search input only. Fallback search requires both query context and title evidence, and fallback provider results use the same exact title-candidate match. Conflicting corroborated works remain Needs you; compatible provider records remain separate and the strongest in-document identifier evidence selects one whole record. Partial provider detail does not independently block Ready; the pure planner owns filename eligibility.

Long-term, both filename projection and embedded-PDF metadata projection should derive from this same resolved bibliographic truth rather than from independent lookup paths.

### Filename planning

Filename generation is template-based.

Current supported placeholders include:

- `{title}`
- `{author}`
- `{authors}`
- `{year}`
- `{journal}`
- `{publisher}`

Planning sanitizes unsafe filename characters and produces a final vault-relative path before mutation.

Pure formatting derives output-specific names without mutating canonical authorship. The factory format is `<first-author family name>[ et al.] (<year>). <title>`. Literal/organization/mononym values are retained conservatively; no surname is guessed. Valid legacy templates keep their exact text and compile `{author}` / `{authors}` into full-name compatibility formats. The setup shell's example does not describe a real PDF.

### Folder configuration

Settings and session configuration define:

- output location:
    - current source folder for each PDF;
    - one explicitly selected existing vault folder, including the root;
- metadata/naming format, including the factory component convention or an exact legacy/custom template;
- a workspace-edit policy controlling whether setup edits also become future defaults.

No intake folder is configured. Chosen output folders must exist when selected; a saved new-model folder that later disappears remains visible and blocks planning. No folder is created automatically.

Configured folders must already exist. The plugin must not silently create a hierarchy because of a typo.

The Defaults section presents workspace-edit policy first, followed by default Output and Metadata & naming. It contains no PDF set.

### Planning and conflicts

`planRenames()` is pure and accepts explicit items, configuration and detached read-only vault paths. It returns detached per-item eligible/no-change/blocked results. SessionCoordinator obtains fresh collision inputs through its PlanningEnvironmentProvider and owns automatic replanning after identification, configuration changes, source revalidation and Apply reconciliation. ItemView does not pass collision arrays or run the planner.

Conflict handling:

- existing files and folders at a destination block planning;
- all candidates for a shared destination are blocked, independent of input order;
- case-conflict keys use NFC normalization and locale-independent lowercase; only the exact source path is exempted for a case-only rename, while distinct case-confusable paths block;
- destination existence is rechecked immediately before mutation;
- a no-op is not an Apply operation.

The session coordinator builds planning input from its current session configuration, item evidence and source observations. Callers provide only read-only vault file/folder path observations; they cannot register eligible planning results. The coordinator stores detached planning values and their basis, and rechecks that basis and the planner result before creating an Apply invocation. A changed session, configuration, evidence or source observation invalidates the reviewed plan.

### Processing

`ApplyChangesService` receives an explicit frozen invocation containing fixed source paths, observed size/mtime and reviewed destinations. It validates the complete invocation before writing and rejects a destination that conflicts with another operation's original source, so rename chains cannot depend on input order or intermediate path vacating. It copies only bindings for listed item IDs, validates current source identity/stat and destination state, and performs one `Vault.rename()` per eligible operation. It cannot enumerate session work, consult mutable session configuration, replan or add unsupported metadata/sidecar/cover actions. Only a resolved rename yields a path-only `renamed` outcome. SessionCoordinator guards conflicting edits during Apply and advances current source observations only after the exact retained `TFile` is verified at its destination. It then invalidates the consumed plan and replans from fresh path snapshots. Freshness checks are best-effort and do not promise atomic exclusion, rollback, journaling or crash recovery.

### Current session state

The current session model represents:

- phase (`setup` or `working`);
- setup visibility and selected concern;
- detached configuration and ordered admitted items with immutable admission observation and current trusted source observation;
- unattempted, identifying, resolved or Needs you state with bounded evidence;
- coordinator-owned planning snapshots, Apply state and path-only outcomes.

No scanner status or success claim that PDF metadata was written exists. Path-only no-change is excluded from Apply.

## Current implementation interaction contracts

### Open / focus

Running the PDF Intake command must reveal the existing PDF Intake tab if present rather than silently doing nothing or creating duplicates.

The current ribbon action uses the same open/reveal method as the command.

### Resolution

Begin review starts coordinator-owned automatic identification through the shared resolver. The working surface has no ordinary global Resolve action.

Manual DOI/ISBN repair is a later slice and will use the shared resolver.

Manual DOI/ISBN repair and retry remain deferred. Any progress feedback must remain truthful about the current provider or fallback attempt.

### Mutation

Apply is explicit and reviewed, and is available only for the current eligible Ready subset. It uses the frozen invocation and rename-only ApplyChangesService.

The reviewed destination is frozen into the invocation and revalidated immediately before each rename.

Unresolved, error and conflict items remain untouched.

### Session persistence boundary

The coordinator-owned runtime session survives view close/reopen within one plugin lifetime. Slice 3 membership and identification results are transient across plugin reload. Complete session-draft serialization/restoration remains deferred; the opaque draft namespace is not hydrated or cleared by session/default edits.

## Redesign contract and architectural seams

These are durable target decisions. Slices 1–3 implement the session/configuration/persistence/authorship/planning/Apply seams, explicit admission, automatic identification and the initial working surface. Repair, draft restoration, and final visual/accessibility qualification remain incomplete. Behavioral authority is [Interaction Contract v0.1.2](../.codex/architecture/PDF_Intake_Interaction_Contract_v0.1.2.md), with the human's 2026-10-07 additions recorded here taking precedence where they differ. Visual concepts are design references, not executable specifications.

### Reconciled interaction authority

| Topic           | Target decision                                                                                                                                                                                   | Superseded assumption                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session scope   | A fresh session starts empty. Explicitly added vault PDFs form its working set. Presence means scope; removal means leaving the session, never deleting a file.                                   | Configured intake folder, recursive scan, processed-subtree exclusion, automatic queue refresh and permanent inclusion checkboxes. |
| Setup           | Three revisitable concerns: **PDFs**, **Output**, **Metadata & naming**. Output owns which artifacts exist and where; Metadata & naming owns their bibliographic expression.                      | v0.1.2's narrower Output location / Filename format labels; settings-first setup.                                                  |
| Begin review    | Available only with at least one PDF. It enters working mode and automatically starts read-only identification of unresolved PDFs. Invalid output must not prevent identification.                | v0.1.2 section 13's ordinary manual/global lookup trigger.                                                                         |
| Working surface | Fixed context bar: Edit session and **Identifying → Needs you → Ready** information on the left; **Apply changes to N PDFs** on the right. Zero states may disappear without reordering the rest. | Global Resolve/Process-selected toolbar; summary's compulsory total-PDF count.                                                     |
| PDF objects     | Stable session membership/order; identity becomes primary after identification and the old name remains provenance. Successful cards stay visible.                                                | Moving cards to express process progress, permanent state columns or gravity simulation.                                           |
| Repair          | Card-local, explicitly closable contextual inspection and DOI/ISBN retry, including inspecting a suspicious successful match.                                                                     | Permanent right inspector; nested Edit → modal → modal chains; failure addressed by another global resolver pass.                  |
| Apply           | Explicitly apply eligible Ready PDFs; unresolved/problem entries remain untouched and stay in the session.                                                                                        | Checkbox-driven batch scope and a global busy flag coupling read-only identification to mutation eligibility.                      |

Setup navigation remains present from the initial empty state. Before review, the PDFs concern shows the explicit manifest, **Add more PDFs** and individual removal. Fresh setup may quietly show current Output and Metadata & naming values without dashboard-style setting cards. Setup collapses in working mode and Edit session reopens the same surface without restarting the session.

Metadata & naming always includes a concrete filename example. Cards communicate Identifying, Needs you and Ready through text, content hierarchy and structure that survive grayscale. Informational text remains selectable/copyable. Exact spacing, layout and inspector presentation remain design choices within these constraints; default PDF icons/thumbnails, cover imagery and image-replacement tools are not required by a concept picture.

### Session authority and defaults

The session owns its ordered working-set manifest, current setup values, identification results, manual repair inputs/overrides and proposed transformations. Views render this state and issue domain actions; they do not become a second authority through DOM values or private parallel entry arrays. File references are resolved through the active vault. Session membership does not establish that a file still exists or still has the observed contents.

Session lifecycle and setup visibility are separate: a working session may reopen setup without becoming a fresh session. A fresh session copies durable defaults once and starts with no PDFs. An unfinished restored session uses its own values, not the defaults in effect at restoration time.

Plugin Settings has a **Defaults** section whose first control is the workspace-edit persistence policy:

- **Keep them for future sessions** (factory default): workspace configuration edits also update durable defaults.
- **Use them only for the current session**: workspace edits change only that session.

The defaults follow that control. The working set is never a durable default. Keep each PDF in its current parent folder is the factory output-location default, including PDFs originating in different folders or the vault root. A single chosen existing vault folder is the other baseline mode. Invalid/missing output folders block Apply, not read-only identification, and are never silently created.

Legacy settings migration preserves valid filename-format preferences where they map cleanly and valid destinations only where they map unambiguously. Old `intake` destination mode maps to **current source folders**, not an intake root. An empty/invalid legacy `another` destination is malformed obsolete state and falls back to **Keep each PDF in its current folder**; migration must not retain a permanently blocked preference or infer a destination folder. `intakeFolder` / `intakeFolders` never populate a session or initiate scanning. This repair rule concerns legacy migration; a new-model destination that later disappears remains an explicit current configuration problem. Detailed decode/migration rules belong in Slice 1's plan.

Plugin persistence has one versioned envelope with separate durable defaults/settings, workspace persistence policy and unfinished-session draft namespaces. One persistence owner serializes partial updates against its latest successfully saved envelope; settings updates preserve draft data and draft updates preserve settings/policy. No view or settings component writes the entire plugin-data object. Absent data can initialize factory defaults, while corrupt/unreadable or unsupported-version data is preserved without an automatic destructive overwrite. Complete draft save/restore behavior remains deferred, but the namespace and update API must already exist in Slice 1.

The naming model must support arbitrary ordered/repeated components, literal text and parameterized output-specific representations without a mandatory three-slot structure. Valid existing user templates remain exact compatibility preferences, not the new component-domain abstraction. The final builder interaction remains a later design prerequisite; Slice 1 establishes the representation/formatter boundary and factory format now.

### Canonical authorship and derived output representations

Canonical bibliographic authorship preserves the full provider-ordered author sequence and the structure actually supplied: person given/family fields, explicit institutional/literal names, mononyms/unstructured names, and unresolved positions/references where retrieval failed. Never alphabetize, truncate the canonical list to produce `et al.`, infer a person's family name from the last word of an unstructured string, or silently promote a later author into first place. Completeness/unknown information must remain distinguishable from a genuinely single-author work.

Filename authorship is a **derived component family**. Its parameters can select first/all authors, family/abbreviated-given/full-name presentation, conditional `et al.`, explicit name order and list separators. The same canonical record may legitimately produce different representations for filenames, embedded PDF metadata or companion metadata; each output has its own formatter. `{author}` and `{authors}` remain legacy template aliases for their historical first-full/all-full presentation, not canonical fields or the only future component choices. `firstAuthor` must not be a second canonical source.

The current factory filename convention is:

```text
<first-author family name>[ et al.] (<year>). <title>.pdf

Tesar (2023). Example Title.pdf
Chilisa et al. (2016). Decolonizing and Indigenizing Evaluation Practice in Africa.pdf
```

One known author uses their supplied family name; multiple authors use the first author's supplied family name plus `et al.`. Use provider ordering and structured names, preserving supplied family-name particles/accents rather than guessing or reordering them. Institutional authors, mononyms and unstructured strings fall back to the complete supplied literal name with an explicit formatter diagnostic when family structure is unavailable. If the first author cannot be represented truthfully, block the relevant naming plan; never skip that position or invent `Anonymous`. Emit `et al.` only when multiple authors are established. Unknown total cardinality/completeness is a naming blocker for a component needing a reliable single/multiple distinction. A missing year is not invented: omit its parenthesized group, with a missing-field diagnostic. Required title/authorship remains a blocker when unavailable.

The factory applies only where no valid prior convention exists. Preserve each valid user template string exactly and retain its existing representation choices; do not silently replace it with the new citation-like format. Store an explicit legacy-template versus component-format choice so later builder edits do not masquerade as migration.

### Current provider authorship evidence

Provider DTOs preserve ordered structured Crossref authors, literal and unresolved positions, publication-date evidence, ordered ISBNs and per-record provenance. Open Library retains every ordered author reference; it requests at most 50 author details per edition and represents failed or over-budget positions as unresolved with bounded incompleteness diagnostics. The network budget does not truncate canonical authorship. Provider candidates remain separate and are not fieldwise merged. Canonical authorship is independent of the derived filename representation.

DOI/ISBN evidence retains raw text, normalized value where valid, validity, page, offset and nearby-label evidence. ISBN normalization validates checksums. Direct provider results become canonical automatically only after an exact normalized title match against a bounded local title candidate. Uncorroborated records and failed attempts remain evidence; deterministic identifier order, conflict handling and the bounded fallback gate are implemented in the shared resolver. Query context is distinct from identity-bearing title candidates.

### Vault selection and current-file binding

One vault-scoped chooser begins at the active vault root, preserves folder hierarchy, permits multiple PDF selections and repeated addition, and cannot navigate outside/above that vault. Selection marks within that transient chooser are compatible with the contract; permanent inclusion checkboxes on session cards are not.

Addition references an existing PDF, with no copy/import/move or folder scan that implicitly adds files. Repeated selection of the same current file must not create duplicate session objects. Revalidation reconciles already admitted files, never expands membership. Missing/changed sources are surfaced locally and cannot be silently substituted by a different file at the old path. Source-reference reconciliation is a modest validation responsibility; it does not promise durable cross-device file identity. Drag/drop and external-file import remain deferred.

### Identification, planning and presentation are distinct

Keep the shared resolver and its PDF.js read boundary. SessionCoordinator schedules unresolved work on Begin review with a maximum of two unsettled PDF jobs. Editing the session returns to setup; re-entry schedules newly admitted/unattempted work without restarting completed evidence. Manual DOI/ISBN retry remains deferred.

Identification state/evidence, user repairs, plan validity and apply outcome must be distinguishable. A resolved bibliographic record is not automatically an applicable transformation. Missing required naming data, invalid destinations, source invalidation and conflicts are separately explainable blockers; changing Output must not erase successful identification. At the surface, local failures/blockers can appear as Needs you, with shared configuration problems explained in setup/context.

Ready means a current, valid preview with changes supported by the current implementation, not merely a provider response. Ready counts and Apply scope derive from the same plans. A filename/path no-op is not a normalization success or a Ready mutation; later metadata/sidecar changes must be considered independently. Applied outcomes are shown truthfully and excluded from another Apply; unresolved objects remain available. Exact completion/new-session UX remains a slice-level design question.

The coordinator owns asynchronous results independently of the DOM. Removed/replaced session items, changed sources and superseded attempts cannot receive late results. Slice 3 uses a bounded queue of two unsettled PDF jobs; configuration changes replan retained evidence without repeating provider work. Render updates preserve stable membership order and focus while statuses change.

The planner derives previews from session configuration and the effective bibliographic record, checks vault destinations and collisions through a coordinator-injected read-only PlanningEnvironmentProvider, and stays independent of file writes. Applying a reviewed set freezes that invocation's scope so new asynchronous results do not join it silently. If a relevant plan changes after preview, it must be shown again rather than applied under an obsolete preview.

### One consequential mutation boundary

**ApplyChangesService** is the domain boundary for all final PDF path/binary and optional artifact writes. UI, cards, inspectors and setup components may request Apply but must not call `Vault.rename()`, binary writes or companion/cover writes directly. Slice 1 extracted the rename-only service; Slice 3 activates it for the frozen Ready subset. The old `processEntry()` and ItemView-owned batch orchestration have been removed.

Mutable session state feeds pure planning, which produces the reviewed **frozen Apply invocation plan** consumed by the service. That snapshot explicitly lists every operation's source, reviewed destination and relevant observed source/configuration context. It contains detached values rather than live session-entry/settings references; host `TFile` bindings are kept separate and must not be frozen. The service receives this explicit scope and returns per-PDF outcomes for the coordinator to record. It never discovers additional session entries, replans against live session configuration or repeatedly reads mutable UI/session scope during execution.

Its initial implementation remains small: validate the invocation, revalidate each bound source/destination, recheck conflicts, and perform one `Vault.rename(file, reviewedFinalPath)` per eligible PDF. Current-vault reads are safety checks on the fixed operations, not a means of expanding scope. Changed state blocks the affected operation rather than selecting another file or destination. Only successful completion establishes an applied result; failed/blocked entries remain explicit and no-op/unresolved entries cause no writes. These checks reduce known stale-plan risks without promising atomic exclusion of a concurrent device.

Mutation invocation control belongs here/the coordinator, not in individual cards. Repeated Apply must not dispatch overlapping work for the same PDF. A failed or interrupted invocation must not be reported as successful or blindly replayed from recovered UI state. Identify/repair results cannot alter an in-flight mutation plan. Single-PDF and batch operations share this boundary.

Later this service can compose preflight/current-state validation, byte preparation, temporary artifacts, verification, guarded commits, operation journaling and recovery/conflict handling. Those mechanisms are deliberately **not** part of the redesign implementation. Do not introduce a general transaction engine, storage protocol, speculative journal or claim multi-file atomicity merely to establish the seam.

### Artifact ownership and projections

The normalized PDF is always the primary artifact; until metadata writeback is accepted, previews explicitly describe path-only changes and do not imply that embedded fields were normalized. Optional outputs are off by default and cannot be offered as functional toggles before generation exists.

Embedded-PDF-metadata preferences may exist in defaults/session configuration before a binary writer exists. Configuration intent is distinct from executable capability: no current Apply plan/result can claim metadata was written, and no enabled control may promise an unavailable operation. Slice 1 may reserve a small preference representation without choosing PDF field mappings or a writer; exact transitional metadata UI can be deferred.

| Artifact           | Ownership/risk                          | Consequence for later planning and Apply                                                                                                         |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normalized PDF     | Canonical, high risk                    | Preserve useful document content/features; binary replacement requires reviewed current-state and recovery semantics.                            |
| Markdown companion | May become user-authored after creation | Existing/edited notes cannot be treated as disposable generated cache or silently overwritten. Creation/update policies require explicit design. |
| Cover image        | Derived, regenerable                    | Regeneration policy differs from note/PDF replacement; path collisions and provenance still matter.                                              |

One effective bibliographic record feeds filename, embedded-PDF metadata and any companion metadata projections. Projection/writer functions prepare proposed values/bytes; only ApplyChangesService executes final vault mutations. A later artifact plan records kinds, destinations, intended actions, ownership and outcomes; it does not force three artifacts per PDF today. PDF field mapping, writer library, cover extraction and companion formatting remain unapproved implementation choices.

### Session-draft recovery is a separate concern

A small, versioned **SessionDraftStore** preserves unfinished work: manifest, source observations, identification evidence, repairs, session values and previews. It can use plugin-local persistence without becoming a library/history database. It is separate from durable defaults even if both share Obsidian's plugin-data storage; neither save path may clobber the other.

Restoring a draft restores the session's own configuration and revalidates source references and proposed transformations against the active vault before they can become Ready. Persisted previews are recoverable context, never permission to replay mutation. Interrupted identification becomes resumable read-only work; an interrupted Apply cannot be inferred successful or safe to retry from a draft alone. Missing/changed files, corrupt/unsupported draft data and unavailable destinations produce truthful recovery feedback.

Draft recovery may ship by Slice 4, well before file-operation recovery. It does not repair a partially written PDF, prove a multi-file Apply committed, or resolve syncing versions. File-operation recovery belongs inside the mutation boundary and requires verified platform findings and a separate approved design before binary writeback can ship.

## Safety boundary

Current PDF processing does not modify binary PDF contents.

This is intentionally narrower than the final product.

Embedded metadata normalization is a core next-stage capability, but it changes the failure model from path mutation to binary replacement and must therefore be implemented with an explicit write/recovery design.

The project must not assume that iCloud or other synchronizers provide atomic/recoverable behavior without evidence.

## Embedded metadata direction

The intended product model is:

```text
resolved bibliographic record
        ├─ filename projection
        └─ embedded PDF metadata projection
```

A future PDF writer boundary should accept source bytes plus normalized bibliographic metadata and produce validated replacement bytes.

The exact metadata field mapping and writer library are not yet approved.

Likely concerns include:

- PDF Info dictionary vs XMP metadata;
- title;
- author(s);
- subject/keywords where semantically appropriate;
- creation/modification semantics;
- DOI/ISBN representation;
- preservation of existing document structure/features;
- signatures and other mutation-sensitive PDFs.

PDF.js should remain the read/parser boundary unless evidence supports a different decision.

## Robustness / recovery direction

A sibling Obsidian plugin is currently running dedicated iCloud/sync failure-mode spikes covering events such as:

- application crash during writes;
- device interruption;
- offline/online transitions;
- multiple devices reconciling against the same sync source.

PDF Intake should reuse verified platform findings from that work rather than independently guessing at sync semantics.

Before binary metadata writeback ships, the processing path should be reviewed for:

- source-state fingerprint/revision checking;
- preparation of replacement bytes away from the canonical source;
- validation of the prepared PDF and intended metadata;
- detection of source changes before commit;
- safest available replacement/rename semantics;
- recoverability after interruption;
- handling of sync conflict copies or concurrent changes.

A multi-step write must not be called transactional unless the verified platform behavior supports that claim.

## Tooling and verification

Project health commands:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run check
```

`npm run check` is the aggregate validation command.

The repository also has local deployment commands:

```bash
npm run deploy
npm run deploy:actual
```

`deploy` targets the dedicated development vault.

`deploy:actual` targets the actual/personal vault and must not be run by an agent without explicit human authorization.

Real Obsidian behavior should be tested in the development vault after runtime-facing changes.

## Lightweight decision log

### 2026-09-27 — Narrow the upstream plugin into PDF Intake

Decision: remove unrelated upstream PDF-management functionality and focus the fork on bibliographic PDF intake.

Why: the desired product is a small, legible tool for turning poorly named/identified PDFs into clean bibliographic artifacts rather than a broad PDF utility.

### 2026-09-27 — Use a workspace ItemView instead of a batch modal

Decision: intake work lives in a durable Obsidian tab.

Why: resolving failures often requires switching context, researching an identifier and returning. A blocking modal makes that workflow fragile and uncomfortable.

### 2026-09-27 — Reuse/reveal one PDF Intake view

Decision: opening PDF Intake reveals/focuses an existing view instead of opening duplicates.

Why: the intake surface should have one obvious durable home.

### 2026-09-27 — Keep processing explicit

Decision: scanning and resolving do not automatically mutate files.

Why: rename/move is destructive enough to require preview and user intent; future metadata rewriting will make this boundary even more important.

### 2026-09-27 — Use one final Vault.rename for rename + move

Decision: when a separate processed folder is configured, compute the final path first and perform one vault-level rename/move.

Why: this avoids an unnecessary intermediate state between rename and move.

### 2026-09-27 — Initially use PDF.js fake-worker path

Decision: the first implementation used the bundled worker handler/fake-worker path rather than a CDN or separately deployed worker.

Why: the plugin performs limited first-page text extraction and benefits from a simple cross-platform deployment surface.

This approach was superseded on 2026-10-04 after live testing showed that importing the worker handler into the renderer interfered with Obsidian's built-in PDF viewer. The current contract is an isolated module Worker artifact.

### 2026-10-05 — Isolate PDF Intake's PDF.js worker

Decision: read the matching local PDF.js worker asset through the vault adapter on first extraction, create a Blob-backed module Worker, and configure only PDF Intake's imported PDF.js instance through `GlobalWorkerOptions.workerPort`. Plugin load does not construct the Worker.

Why: publishing `WorkerMessageHandler` on a renderer global contaminated Obsidian's PDF.js runtime and caused built-in PDF pages to render blank. Passing the `app://` asset URL directly to `Worker` also fails cross-origin checks. The worker is therefore initialized lazily from local asset text without exposing the app URL to the Worker constructor or changing renderer globals.

Contract: enabling PDF Intake does not create a Worker. Worker setup failures are contained to the extraction/resolution operation, and the plugin terminates its worker and revokes its Blob URL on unload. The worker handler may use globals only inside its dedicated Worker realm; it must not publish PDF.js worker handlers or configuration through renderer globals. Enabling PDF Intake must not alter Obsidian's built-in PDF viewer.

### 2026-09-27 — Defer persistent intake-session state

Decision: do not persist checkbox/manual-input state yet.

Why: the filesystem is authoritative and current use has not demonstrated that session persistence is worth another state authority.

### 2026-09-27 — Treat embedded bibliographic metadata normalization as core future behavior

Decision: the final product definition includes both clean filenames and clean PDF bibliographic metadata.

Why: a PDF with a correct filename but garbage Title/Author metadata is still an incompletely normalized intake artifact.

### 2026-09-27 — Defer binary writeback until recovery semantics are evidence-based

Decision: do not restore the upstream metadata writer as a simple in-place overwrite.

Why: writing metadata is mechanically simple but safe replacement under crashes, sync and concurrent device activity requires a deliberate recovery model.

### 2026-10-07 — Adopt explicit sessions and automatic read-only identification

Decision: the redesign replaces folder-driven admission/checkbox scope with an empty fresh session, vault-scoped explicit addition and the PDFs / Output / Metadata & naming setup model. Begin review starts identification; Apply remains explicit. Status order is contextual and never moves cards to represent progress.

Why: the human's v0.1.2 contract and subsequent decisions define the working set and interaction. This supersedes the old folder/refresh/manual-global-resolution assumptions for target implementation, while the baseline descriptions above remain evidence of current code.

### 2026-10-07 — Separate session-draft preservation from file recovery

Decision: unfinished sessions preserve their own configuration, results and repairs through a small draft store, with vault revalidation on restore. All consequential artifact writes use one ApplyChangesService, initially rename-only.

Why: early unfinished-work preservation must not imply that a PDF write completed or can be replayed. This supersedes the historical decision to defer session persistence indefinitely; sophisticated file-operation recovery remains evidence-gated.

### 2026-10-07 — Correct migration and freeze consequential execution scope

Decision: malformed legacy destinations fall back to the safe current-folder default, while valid legacy filename/destination preferences migrate where unambiguous. Apply consumes a detached frozen invocation plan; mutable session state is not execution scope. Metadata configuration intent may precede writer capability without claiming writes.

Why: these human corrections approve the overall redesign while removing obsolete malformed-state authority and establishing the exact mutation seam. The detailed Slice 1 plan resolves persistence/data ownership without implementing recovery or binary writing.

### 2026-10-07 — Separate canonical authorship from output formatting

Decision: preserve complete ordered provider authorship and available person/literal/institution structure independently of derived filename/metadata representations. The factory uses first family name + conditional et al., parenthesized year and title; valid legacy user templates remain exact preferences.

Why: raw first-full/all-full fields are inadequate as a domain and cannot justify surname guessing, internal truncation or treating current lossy provider results as complete. Slice 1 establishes types/formatter boundaries; lossless provider ingestion is required before Slice 3 identification.
