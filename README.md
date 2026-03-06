# ProtoNav

ProtoNav is a VS Code extension that indexes `.proto` symbols and makes them easy to find from any file.

## Features

- Indexes `message`, `enum`, `service`, and `rpc` symbols from `.proto` files.
- Adds indexed proto symbols to workspace symbol lookup.
- Provides a `ProtoNav: Find Proto Symbol` command with fast fuzzy lookup.
- Provides a `ProtoNav: Rebuild Index` command and status bar indicator (`ProtoNav files/symbols`).
- Adds cross-language definition lookup that prefers proto matches when available.
- Supports indexing only a target folder via `protonav.focusFolder`.

## Settings

- `protonav.preferProtoDefinitions` (boolean, default `true`)
- `protonav.maxIndexFiles` (number, default `20000`)
- `protonav.excludeGlobs` (string[], default excludes common build/vendor folders)
- `protonav.focusFolder` (string, default `""`)
- `protonav.logLevel` (`error` | `warn` | `info` | `debug`, default `warn`)

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch the Extension Development Host.

## Packaging And Install

```bash
./scripts/build-vsix.sh
./scripts/install-vsix.sh
```

`install-vsix.sh` calls `build-vsix.sh` first.

## Versioning

- Version source of truth is `VERSION` (`MAJOR.MINOR.PATCH`).
- Keep `VERSION` and `package.json` in sync.
