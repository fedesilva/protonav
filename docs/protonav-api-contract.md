# ProtoNav API Contract (MVP)

## 1) Index Model

```ts
interface SymbolRecord {
  id: string;                    // stable per file + declaration
  name: string;                  // symbol short name (e.g. "Invoice")
  shortName: string;             // same as name in MVP
  fqName: string;                // package + scopes + name (e.g. "billing.v1.Invoice")
  type: "message" | "enum" | "service" | "rpc";
  packageName: string;
  scopePath: string[];           // parent symbols in order
  containerName?: string;        // nearest parent or package
  parentId?: string;             // parent symbol id for tree construction
  range: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
  selectionRange: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
}
```

## 2) Ranking Rules

Definition/token match score (higher first):

1. Exact fully-qualified name
2. Exact short name
3. Case-insensitive exact fully-qualified name
4. Case-insensitive exact short name
5. Suffix FQN match (e.g. `...Invoice` for token `Invoice`)
6. Dot-token substring fallback for namespaced tokens

Type priority boost:

1. `message`
2. `enum`
3. `service`
4. `rpc`

This enforces "prefer proto message when available" for ambiguous symbols.
When context is a `.proto` file, direct-imported proto files receive an additional ranking boost.

Workspace symbol search score order:

1. Exact FQN
2. Exact short name
3. Case-insensitive exact matches
4. FQN suffix match
5. Short-name prefix match
6. FQN contains query

## 3) Extension Settings Schema

```json
{
  "protonav.preferProtoDefinitions": true,
  "protonav.maxIndexFiles": 20000,
  "protonav.excludeGlobs": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/bazel-*/**"
  ],
  "protonav.focusFolder": "",
  "protonav.logLevel": "warn"
}
```

`protonav.focusFolder` behavior:

- Empty string: index all workspace folders.
- Relative path (e.g. `services/payments/proto`): index only that subfolder in each workspace folder where it exists.
- Absolute path: must be inside one workspace folder and must exist as a directory.
- If invalid/unresolvable: index is intentionally empty (no fallback full scan), and a warning is logged.

## 4) Runtime Interfaces

- Workspace symbols: `WorkspaceSymbolProvider` surfaces proto symbols.
- Document symbols: `DocumentSymbolProvider` for `protobuf` documents.
- Cross-language definitions: `DefinitionProvider` for `scheme: file`; returns proto matches when token resolution succeeds.
- Command: `protonav.findProtoSymbol` opens a searchable quick pick and jumps to the selected symbol.
- Command: `protonav.rebuildIndex` forces a full rebuild.
- Status bar indicator: shows indexing state and file/symbol counts; click triggers rebuild.

## 5) Indexing Lifecycle

- Full build on activation and relevant config changes.
- Incremental updates through `FileSystemWatcher` (`create`, `change`, `delete`).
- Debounced update flush to avoid high-frequency reparsing.
- Respect `maxIndexFiles` cap and `excludeGlobs` filtering.
- Import graph is rebuilt from `import` statements and used to prefer definitions from directly imported proto files.
