# changelog.d/ — per-PR changelog fragments

Every PR that touches a gated path (by default `src/`, `schema/`, or the
version file — see this repo's README for the exact set your project
configured) must add exactly one new fragment here: `changelog.d/<TICKET>.md`.
One file per PR means two concurrent PRs never touch the same line of the
same file — nothing to rebase away, no discarded approvals. Do **not** append
to a shared `## [Unreleased]` section instead; that reintroduces the exact
conflict this scheme exists to remove.

The release workflow collates every fragment present on the base branch at
merge time, computes the version from their declared bump levels, writes it
into the version file and a dated `## [x.y.z] - YYYY-MM-DD` heading in
`CHANGELOG.md`, and deletes the fragments it consumed. **Do not** bump the
version file or add a dated CHANGELOG heading yourself — the release gate
rejects both.

## Format

```
bump: minor

### Added
- a thing this PR adds

### Fixed
- a bug this PR fixes
```

- First line: `bump: major` / `bump: minor` / `bump: patch` — see
  `CHANGELOG.md`'s `## Versioning` section for what each level means.
- Followed by `### <Section>` blocks (`BREAKING`, `Added`, `Changed`,
  `Fixed`, `Removed`) with `- ` bullets.
- A `### BREAKING` section requires `bump: major`, and `bump: major` requires
  a `### BREAKING` section — the gate checks both directions.
- If your project configured `surface-patterns` and your PR adds or removes
  a match, the gate requires at least `bump: minor` (added) or `bump: major`
  (removed).
- If a file under `schema/` changed, declare at least `bump: minor`.

A PR with no gated changes needs no fragment.
