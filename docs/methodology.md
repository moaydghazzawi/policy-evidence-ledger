# Public demonstration methodology

The demonstration is a small, selected corpus for showing the ledger workflow. It is not a complete account of advanced-compute policy or of every Chinese policy response.

## Selection rules

Records were included when they met all of these conditions:

- the publisher is the responsible government institution;
- the record materially documents the policy sequence, an official response, or a later change in legal status;
- a stable public citation and precise locator can be recorded;
- any English description of a Chinese-language record can be clearly labeled as descriptive rather than official.

The three U.S. rules use the official GovInfo editions. The three Chinese records use canonical MOFCOM pages. The corpus was rechecked on 2026-09-03. Later or adjacent instruments may fall outside this illustrative selection.

## Source and translation treatment

Citation metadata is verified against the official page or edition before evidence is approved. The demo is citation-only: it links to public records but does not redistribute their full files, so it reports each document hash as unavailable rather than inventing one.

Chinese titles and evidence data points are descriptive translations written for navigation and comparison. The original Chinese text controls. A translation is not entered as an exact passage. Current-status claims include an explicit as-of date and are limited to the provisions the later instrument actually changes.

## Evidence coding

Each evidence record is classified as supporting evidence or counterevidence. A record may contain either an exact passage or a researcher-entered data point; the demo uses data points and labels them as such. Every approved record has a source ID, locator type, locator, and review note.

Claims keep four elements separate:

- the proposition in plain language;
- the researcher’s interpretation;
- a confidence judgment;
- a known limitation.

`supported`, `contested`, `unclear`, and `rejected` describe the current assessment, not an automated score. The rejected overbroad-suspension claim demonstrates how a proposition and the official counterevidence against it remain visible in the research record.

## Comparisons and changes in judgment

Comparison relationships are assigned by a person. The demo distinguishes a historical adoption claim from a later current-status claim and records disagreement with an overbroad reading of the suspension. Definition revisions remain separate immutable versions, and the decision log records the reason for a revision or assessment change.

In this MVP, relationship rationales carry the definition or period detail in prose; comparisons do not yet link each side to a specific definition-version ID. Decision records preserve before/after reasoning but do not mutate the underlying claim automatically.

## Reproducibility and review

`demo/manifest.json` is the canonical public fixture used by both the Python seed and the read-only web fallback. Automated tests compare seeded records with that fixture. Export revalidates record schemas, source verification, locators, approval state, and captured-source hashes before writing a bundle.

A substantive reviewer should still open every cited official record, check the locator and translation against the original, and confirm time-sensitive legal status at the date of publication.
