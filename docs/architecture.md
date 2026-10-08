# PDF Intake architecture

Status: implemented baseline plus approved redesign decisions (redesign not implemented)  
Last updated: 2026-10-07

PDF Intake is a small Obsidian plugin for normalizing the bibliographic envelope of existing PDFs.

The target input is a PDF whose document content is already useful/correct but whose filename and/or bibliographic metadata are poor.

The target output is the same document content with a clean, trustworthy bibliographic envelope.

The sections describing the current system record the existing checkout. The [redesign contract and architectural seams](#redesign-contract-and-architectural-seams) below define the target, superseding the folder-driven interaction when implementation begins. The [overall implementation plan](implementation-plan.md) defines delivery slices; it does not authorize their implementation.

## Product boundary

PDF Intake is responsible for:

- identifying bibliographic works from existing PDFs;
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

## Current system shape

```text
Configured intake folder
        ↓
recursive PDF scan
        ↓
PDF.js text extraction from first pages
        ↓
identifier extraction / manual DOI or ISBN
        ↓
shared bibliographic resolver
   ├─ Crossref
   └─ Open Library
        ↓
resolved bibliographic record
        ↓
filename + final-path planning
        ↓
durable PDF Intake workspace preview
        ↓
explicit Process action
        ↓
final conflict recheck
        ↓
single Obsidian Vault.rename()
```

PDF bytes are currently read-only.

## Main components

### Workspace view

PDF Intake is exposed as a custom Obsidian `ItemView` with view type:

`pdf-intake-view`

The view is the main working surface. Its Obsidian display name is `PDF Intake`.

The registered command is `Open PDF Intake` (command ID `open-pdf-intake`).

Running the command:

1. find an existing PDF Intake leaf if one exists;
2. reveal/focus it;
3. load it if Obsidian has deferred the custom view;
4. refresh its view of the configured intake folder;
5. create a new leaf only if no PDF Intake view exists.

The workflow deliberately avoids a blocking batch modal because intake work may require switching to PDFs, browser research or other Obsidian tabs and then returning.

### Intake scanning

The plugin scans the configured intake folder recursively for PDFs.

Safety rules:

- an invalid/missing intake folder returns no files;
- there is no fallback to scanning the whole vault;
- when processed-folder mode is `another` and the configured processed folder exists as a proper descendant of intake, that processed subtree is excluded;
- an invalid processed folder is not excluded from scanning, but it blocks processing;
- a processed folder outside intake does not affect scanning;
- processed folder equal to intake does not exclude the entire tree.

The filesystem is authoritative. Persistent per-session checkbox/input restoration is not currently part of the architecture.

### PDF text extraction

PDF.js 4.10.38 is currently used to extract text from the first three pages for identifier discovery.

The build copies the matching `pdf.worker.mjs` into the plugin directory. On first extraction, PDF Intake reads that asset through the vault adapter, creates a Blob-backed module Worker, and assigns that Worker to the bundled PDF.js instance through `GlobalWorkerOptions.workerPort`. Plugin enable/load does not construct a Worker. The Worker is terminated and its Blob URL revoked when the plugin unloads.

The worker handler and PDF.js configuration must stay isolated from renderer globals. PDF Intake must not publish or modify `globalThis.pdfjsWorker` or `window.pdfjsWorker`; enabling it must not alter Obsidian's built-in PDF viewer. The official worker bundle may use its own worker-scope global inside the dedicated Worker.

Extraction:

- reads the PDF through Obsidian's Vault API;
- processes only the three-page window currently requested by the resolver;
- disables unnecessary auto-fetch/stream behavior;
- destroys the PDF document in `finally` after extraction.

PDF.js is a read/parser dependency here, not the future metadata-write library.

### Bibliographic resolver

Automatic and manual resolution share the same resolver path.

Current supported provider behavior:

- DOI → Crossref
- ISBN → Open Library

The resolver must not invent missing bibliographic metadata.

A manual DOI/ISBN can be supplied for unresolved/error entries and retried without leaving the workspace.

Known limitation: some real PDFs visibly contain a DOI that current extraction/detection does not find. This is a resolver/extraction quality issue, not expected behavior.

### Resolved bibliographic record

The resolver returns a typed bibliographic result that can include:

- title;
- authors;
- first author;
- publication year;
- DOI;
- ISBN;
- journal;
- publisher;
- provider/source;
- resolution status/error.

This resolved record is the source for downstream normalization.

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

The current formatter projects first full author / all full authors from strings. The approved [canonical/derived authorship contract](#canonical-authorship-and-derived-output-representations) replaces this as the target domain abstraction while preserving valid legacy user templates.

### Folder configuration

Settings currently define:

- intake folder;
- processed-file destination mode:
    - keep beside each source PDF in its current folder within the intake tree;
    - move to another configured existing vault folder;
- rename template.

Folder fields accept vault-relative paths and offer suggestions from existing vault folders. Arbitrary typed paths can remain invalid; validation blocks scanning for an invalid intake folder and blocks processing for an invalid processed folder.

Configured folders must already exist. The plugin must not silently create a hierarchy because of a typo.

Known UX issue: the processed-folder setting can visually resemble a preselected/default path while simultaneously being invalid. The setting UI needs to make unset/invalid state unambiguous.

### Planning and conflicts

For every resolved entry, planning computes the intended final path before mutation.

The view shows the current path and intended final path.

Conflict handling:

- existing vault destination conflicts are detected during planning;
- collisions among multiple planned outputs are also detected;
- destination existence is rechecked immediately before mutation;
- conflicting entries are not processed.

### Processing

Current processing mutates only the vault path.

When processed-folder mode is set to keep files in intake, each PDF stays in its current parent folder (which may be a nested folder under the intake root):

```text
Inbox/original.pdf
→ Inbox/Normalized Name.pdf
```

When processing to a separate folder:

```text
Inbox/original.pdf
→ Sources/Processed/Normalized Name.pdf
```

Both rename and move are represented as one final `Vault.rename(file, finalPath)` call rather than two separate mutations.

An entry is marked `processed` only after `Vault.rename()` succeeds.

Unexpected failures become explicit error state.

### Current intake states

The current model includes states equivalent to:

- unprocessed;
- resolving;
- ready;
- unresolved;
- conflict;
- error;
- processed;
- unchanged / already at destination.

The exact meaning of `unchanged` will need revision when embedded metadata normalization ships: a correctly named file can still have incorrect internal PDF metadata and therefore still require processing.

## Current implementation interaction contracts

### Open / focus

Running the PDF Intake command must reveal the existing PDF Intake tab if present rather than silently doing nothing or creating duplicates.

The current ribbon action uses the same open/reveal method as the command.

### Resolution

Resolution is explicit and read-only.

Unresolved items may accept a manual DOI or ISBN and retry through the shared resolver.

Resolver progress/system feedback should become more informative, but must remain truthful about which provider or fallback is being attempted.

### Mutation

Mutation is never triggered solely by discovery or resolution.

Before mutation the user must be able to see the intended final destination.

Unresolved, error and conflict items remain untouched.

### Refresh

Explicit open/focus and explicit Refresh should reconcile the view with current filesystem truth.

Persistent view-session state is deferred. The plugin should not create a session database merely to preserve checkbox state unless real use demonstrates a need.

## Redesign contract and architectural seams

These are durable target decisions, not claims about shipped behavior. Behavioral authority is [Interaction Contract v0.1.2](../.codex/architecture/PDF_Intake_Interaction_Contract_v0.1.2.md), with the human's 2026-10-07 additions recorded here taking precedence where they differ. Visual concepts are design references, not executable specifications.

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

### Current provider authorship evidence and delivery dependency

This audit concerns the actual mappings in `src/lookup.ts`, `src/resolver.ts` and `src/types.ts`; it is not certification of every field the remote providers can return.

| Area                | Current observed support / loss                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public result types | `LookupResult.authors?: string[]`; `BibliographicMetadata.authors: string[]` and `firstAuthor?: string`. No structured person/institution/literal union, source position or completeness.                                                                                                                                                                                   |
| Crossref            | Reads an ordered `message.author` array with given/family fields, immediately flattens each to given + family or the available field, and filters empty entries. No count cap, but given/family structure is lost and a missing early entry can shift first authorship. No institutional-name path is read by the current parser; unsupported author entries can disappear. |
| Open Library        | Follows edition author references in their original order, but only `authorRefs.slice(0, 5)`. Takes each author record's `name` string, does not read structured names or explicit institutional classification, and silently skips failed/unusable names. Therefore lists may be truncated/incomplete and later names can shift into first position.                       |
| Resolver            | Sets `firstAuthor` to the first surviving string, adding no reliable canonical structure or completeness evidence. Existing tests mainly assert ordinary full-name strings; they do not prove lossless authorship.                                                                                                                                                          |

Slice 1 introduces canonical types, a pure authorship derivation boundary, parameterized filename format and truthful synthetic fixtures. Existing provider DTOs remain narrowly identified ingress compatibility data; their strings must not be relabeled complete canonical authorship or reverse-parsed into names. The empty Slice 1 shell performs no real identification.

Before Slice 3 routes real identification into the new session model, provider adapters must preserve available structured names, every ordered reference/position, explicit literals and retrieval failures without the five-author cap. Preserve the whole canonical sequence independently of the chosen filename representation; if a bounded lookup policy is necessary, retain unresolved references and explicit incompleteness rather than deleting authors. Verify actual provider response fields/fixtures before mapping institutional or additional structured fields. This narrow ingestion prerequisite is separate from adding providers or general resolver heuristics.

### Vault selection and current-file binding

One vault-scoped chooser begins at the active vault root, preserves folder hierarchy, permits multiple PDF selections and repeated addition, and cannot navigate outside/above that vault. Selection marks within that transient chooser are compatible with the contract; permanent inclusion checkboxes on session cards are not.

Addition references an existing PDF, with no copy/import/move or folder scan that implicitly adds files. Repeated selection of the same current file must not create duplicate session objects. Revalidation reconciles already admitted files, never expands membership. Missing/changed sources are surfaced locally and cannot be silently substituted by a different file at the old path. Source-reference reconciliation is a modest validation responsibility; it does not promise durable cross-device file identity. Drag/drop and external-file import remain deferred.

### Identification, planning and presentation are distinct

Keep the shared resolver and its PDF.js read boundary. A small session coordinator schedules unresolved work on Begin review and additions to an already working session; reopening setup or focusing the view does not retry failures or restart all successful work. An unsuccessful automatic attempt becomes a local Needs you case, with explicit local retry through the same resolver.

Identification state/evidence, user repairs, plan validity and apply outcome must be distinguishable. A resolved bibliographic record is not automatically an applicable transformation. Missing required naming data, invalid destinations, source invalidation and conflicts are separately explainable blockers; changing Output must not erase successful identification. At the surface, local failures/blockers can appear as Needs you, with shared configuration problems explained in setup/context.

Ready means a current, valid preview with changes supported by the current implementation, not merely a provider response. Ready counts and Apply scope derive from the same plans. A filename/path no-op is not a normalization success or a Ready mutation; later metadata/sidecar changes must be considered independently. Applied outcomes are shown truthfully and excluded from another Apply; unresolved objects remain available. Exact completion/new-session UX remains a slice-level design question.

The coordinator owns asynchronous results independently of the DOM. Removed/replaced session items and superseded repair attempts cannot receive late results. Configuration changes invalidate affected previews; source changes invalidate evidence dependent on the old source. Render updates must preserve focus/input and stable card positions. A bounded identification queue may initially be serial; it must not lock unrelated repair and already Ready work for the duration of every provider call.

The planner derives previews from session configuration and the effective bibliographic record, checks vault destinations and collisions across the working set, and stays independent of file writes. Applying a reviewed set freezes that invocation's scope so new asynchronous results do not join it silently. If a relevant plan changes after preview, it must be shown again rather than applied under an obsolete preview.

### One consequential mutation boundary

**ApplyChangesService** is the domain boundary for all final PDF path/binary and optional artifact writes. UI, cards, inspectors and setup components may request Apply but must not call `Vault.rename()`, binary writes or companion/cover writes directly. The existing `processEntry()` is a useful simple execution kernel, not yet a complete boundary: the view currently owns batch selection, validation, replanning and execution state.

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
