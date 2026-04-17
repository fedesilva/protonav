# AGENTS Guidelines

## Versioning Policy

- Maintain extension version in the `VERSION` file using `MAJOR.MINOR.PATCH`.
- Keep `VERSION` and `package.json` version in sync.
- Only bump the extension version for commits that change the shipped extension's user-visible functionality, behavior, configuration surface, or published package contents.
- Do not bump the extension version for repo-only or tooling-only changes that do not change the shipped extension itself.
  Examples: GitHub Actions/workflow changes, release automation, docs, plans, comments, refactors with no behavior change, test-only changes, and local developer tooling/config.
- When a version bump is required, bump according to change type:
  - Bug fixes or small shipped behavior changes: increment `PATCH`.
  - New shipped features or user-facing additions: increment `MINOR`.
  - `MAJOR` changes: do not change automatically. Ask for explicit confirmation first.
- Exception: if the user explicitly requests a version change, apply that requested version, commit it, and skip the automatic bump for that commit to avoid double-bumping.

## Security Policy

- Always address security warnings directly.
- Do not hide security issues by suppressing warnings.
- Build/install workflows must surface security issues and fail when security checks fail.
