# PDF Intake documentation

This directory contains durable project truth.

## Current documents

- [`architecture.md`](architecture.md) — current Slice 1 implementation, approved target interaction/domain decisions, safety boundaries and lightweight decision log.
- [`roadmap.md`](roadmap.md) — planned product/engineering directions, deferred work and explicit non-goals.
- [Overall implementation plan](../.codex/architecture/implementation-plan.md) — approved redesign slices, prerequisites, acceptance boundaries and deferrals.
- [Slice 1 execution plan](../.codex/plans/slice-1-session-model-setup-shell.md) — implementation progress and actual verification evidence for the completed foundation.

The behavioral source for the redesign is [Interaction Contract v0.1.2](../.codex/architecture/PDF_Intake_Interaction_Contract_v0.1.2.md), with later human decisions captured in the architecture document. Visual references do not override that behavior.

## Agent-local execution state

Implementation continuity and active work plans live under `.codex/`:

- `.codex/CONTINUITY.md`
- `.codex/CONTINUITY_TEMPLATE.md`
- `.codex/PLANS.md`
- `.codex/plans/`

Those files help agents continue work but are not canonical architecture.

## Documentation rule

When implementation changes an approved product, interaction, architecture or safety contract, update `architecture.md`.

When a newly discovered issue or desired improvement is not yet implemented, put it in `roadmap.md` rather than presenting it as current behavior.
