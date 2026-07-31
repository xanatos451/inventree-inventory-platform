# AI Assistant MVP for Supplier Capture Mapping

This document defines a safe, incremental MVP for an AI assistant that helps classify, map, and match captured supplier data. The assistant is advisory only. It does not write inventory changes directly.

## Goals

- Improve mapping speed and consistency for `part`, `supplier`, `manufacturer`, and `stock` fields.
- Improve consistency when importing similar items from different suppliers.
- Identify likely existing parts for operator review (no automatic merges in MVP).
- Recommend which fields should become structured parameters vs free-form notes.

## Non-Goals (MVP)

- No autonomous create/update/delete inventory writes.
- No automatic part merges.
- No model fine-tuning or custom model training.
- No silent background changes to mapping profiles.

## Safety and Control Model

- AI outputs are suggestions with evidence and confidence.
- Operator must explicitly accept suggestions.
- Deterministic validators remain the source of truth.
- All accepted/rejected suggestions are logged for traceability.

## End-to-End Flow

1. Capture is submitted and opened in workspace.
2. Deterministic normalizer computes canonical attributes from mapped/raw data.
3. Candidate generator queries likely matching existing parts.
4. AI ranks and explains candidates and suggests mappings.
5. Operator accepts/rejects suggestions.
6. Accepted suggestions can be saved into a mapping profile.
7. Existing plan/create endpoints run unchanged with current guardrails.

## Data Contracts

### 1) Normalized Item Contract (input to candidate + AI)

```json
{
  "capture_id": 42,
  "row_index": 7,
  "source": "fastenal",
  "raw": {
    "Product": "Socket Head Cap Screw",
    "Description": "M6 x 1.0 x 25mm Alloy Steel"
  },
  "mapped": {
    "part.ipn": "",
    "part.name": "Socket Head Cap Screw",
    "supplier.sku": "FAS-M6-01"
  },
  "canonical": {
    "type": "socket-head-cap-screw",
    "thread": "m6x1.0",
    "length_mm": 25.0,
    "drive": "hex-socket",
    "material": "alloy-steel",
    "finish": "black-oxide",
    "fingerprint": "socket-head-cap-screw|m6x1.0|25.0|hex-socket|alloy-steel|black-oxide"
  }
}
```

### 2) Candidate Match Contract

```json
{
  "capture_id": 42,
  "row_index": 7,
  "candidates": [
    {
      "part_id": 123,
      "part_name": "M6 x 25 Socket Head Cap Screw",
      "part_ipn": "SCR-M6-25-SHCS",
      "evidence": {
        "exact": ["canonical.type", "canonical.thread", "canonical.length_mm"],
        "fuzzy": ["description_similarity"],
        "conflicts": ["finish"]
      },
      "score": 0.91
    }
  ]
}
```

### 3) AI Suggestion Contract

```json
{
  "capture_id": 42,
  "row_index": 7,
  "mapping_suggestions": {
    "part.name": {
      "source": "template",
      "value": "{Product}",
      "confidence": 0.88,
      "reason": "Product title is stable across rows."
    },
    "parameter.Thread": {
      "source": "regex",
      "value": "M6 x 1.0",
      "confidence": 0.93,
      "reason": "Thread pattern appears in 97% of similar rows."
    }
  },
  "notes_vs_parameters": {
    "parameter_candidates": ["Thread", "Length", "Material", "Drive", "Finish"],
    "notes_candidates": ["Marketing copy", "shipping copy", "bundle text"]
  },
  "match_suggestions": [
    {
      "part_id": 123,
      "confidence": 0.91,
      "reason": "Canonical fingerprint exact on 5 of 6 attributes."
    }
  ]
}
```

## Confidence Policy

- High (`>= 0.90`): preselect candidate in UI, still requires user confirmation.
- Medium (`0.70 - 0.89`): show suggestion with warning badge.
- Low (`< 0.70`): no match recommendation; show as possible related item only.

## Scoring Rubric (MVP)

Use a weighted hybrid score:

- Canonical fingerprint overlap: 0.45
- Exact normalized attribute matches (thread, length, drive, material): 0.30
- Text similarity (`name` + `description`): 0.15
- Supplier/manufacturer identifiers (if present): 0.10

Apply penalties:

- Strong conflict on core geometry attributes: `-0.35`
- Unit conversion uncertainty not resolved: `-0.15`

## Suggested API Additions (Plugin)

- `POST /captures/{id}/ai/normalize/`
  - Returns normalized item contracts for selected rows.
- `POST /captures/{id}/ai/candidates/`
  - Returns deterministic top candidate parts per row.
- `POST /captures/{id}/ai/suggest/`
  - Returns AI mapping + notes/parameter + match suggestions.
- `POST /captures/{id}/ai/decisions/`
  - Persists accept/reject actions with rationale and timestamp.

All routes require auth and must respect capture ownership scope.

## Workspace UI Additions

Add an "AI Suggestions" panel in capture workspace:

- Row-scoped mapping suggestions with accept/reject.
- "Notes vs Parameters" recommendation list.
- "Likely Existing Parts" ranked list with confidence and evidence.
- "Apply accepted suggestions" action that modifies in-memory rules only.
- "Save accepted as profile" action to persist mapping rules.

## Observability and Audit

Store decision telemetry for each suggestion:

- suggestion id
- row index
- suggested target/value
- confidence
- user action: accepted/rejected/edited
- final value
- timestamp

This data is used for later evaluation and optional fine-tuning decisions.

## Rollout Plan

### Phase 1: Deterministic Foundation

- Implement canonical normalizer helpers for fasteners and common hardware.
- Implement deterministic candidate retrieval/scoring.
- Add UI view for candidates and explainability.

Success criteria:

- `>= 95%` candidate generation completeness for rows with enough attributes.
- p95 response time under 1 second for candidate retrieval on 100-row selection.

### Phase 2: AI Suggestion Layer

- Add advisory AI mapping and notes/parameter recommendations.
- Add confidence and evidence outputs.

Success criteria:

- `>= 70%` suggestion acceptance rate on high-confidence recommendations.
- zero unreviewed writes attributable to AI.

### Phase 3: Consistency Improvements

- Add cross-source consistency checks for canonical fingerprints.
- Add policy prompts for naming conventions.

Success criteria:

- measurable reduction in duplicate near-identical parts.
- measurable reduction in inconsistent parameter naming.

## Risks and Mitigations

- Hallucinated mappings:
  - Mitigation: strict schema output, deterministic validators, user confirmation.
- False positive matches:
  - Mitigation: confidence thresholds and conflict penalties.
- Prompt drift:
  - Mitigation: versioned prompt templates and regression tests.
- Performance on large captures:
  - Mitigation: batch row selection and async job mode for suggestions.

## Future (Post-MVP)

- Optional learning from accepted decisions (policy constrained).
- Domain packs for specific commodity classes (fasteners, electrical, bearings).
- Cross-capture semantic memory for preferred canonical forms.