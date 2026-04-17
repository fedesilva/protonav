# AGENTS Guidelines

## Versioning Policy

- Maintain extension version in the `VERSION` file using `MAJOR.MINOR.PATCH`.
- Keep `VERSION` and `package.json` version in sync.
- Before committing, bump version according to change type:
  - Simple changes: increment `PATCH`.
  - Feature changes/additions: increment `MINOR`.
  - `MAJOR` changes: do not change automatically. Ask for explicit confirmation first.
- Exception: if the user explicitly requests a version change, apply that requested version, commit it, and skip the automatic bump for that commit to avoid double-bumping.

## Security Policy

- Always address security warnings directly.
- Do not hide security issues by suppressing warnings.
- Build/install workflows must surface security issues and fail when security checks fail.
