import * as path from "node:path";
import * as vscode from "vscode";
import { ProtoNavConfig } from "./config";
import { ProtoNavLogger } from "./logging";
import { parseProto } from "./protoParser";
import { ParsedProtoDocument, ParsedProtoSymbol, TextRange } from "./protoTypes";
import { symbolKindForType } from "./symbolKind";

export interface IndexedProtoSymbol {
  uri: vscode.Uri;
  symbol: ParsedProtoSymbol;
  kind: vscode.SymbolKind;
}

export interface ProtoIndexStatus {
  isIndexing: boolean;
  indexedFiles: number;
  indexedSymbols: number;
  rootCount: number;
  focusFolder: string;
  lastIndexedAt?: number;
  lastDurationMs?: number;
  lastWarning?: string;
}

type PendingChangeKind = "upsert" | "delete";

export class ProtoIndex implements vscode.Disposable {
  private config: ProtoNavConfig;
  private readonly documentsByUri = new Map<string, ParsedProtoDocument>();
  private readonly symbolsById = new Map<string, IndexedProtoSymbol>();
  private readonly symbolsByShort = new Map<string, IndexedProtoSymbol[]>();
  private readonly symbolsByFq = new Map<string, IndexedProtoSymbol[]>();
  private readonly resolvedImportsByUri = new Map<string, Set<string>>();
  private readonly importersByUri = new Map<string, Set<string>>();
  private roots: vscode.Uri[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly pendingChanges = new Map<string, PendingChangeKind>();
  private flushTimer: NodeJS.Timeout | undefined;
  private rebuildInFlight: Promise<void> | undefined;

  private readonly statusEmitter = new vscode.EventEmitter<ProtoIndexStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  private status: ProtoIndexStatus;

  constructor(config: ProtoNavConfig, private readonly logger: ProtoNavLogger) {
    this.config = config;
    this.status = {
      isIndexing: false,
      indexedFiles: 0,
      indexedSymbols: 0,
      rootCount: 0,
      focusFolder: config.focusFolder
    };
  }

  getConfig(): ProtoNavConfig {
    return this.config;
  }

  getStatus(): ProtoIndexStatus {
    return { ...this.status };
  }

  async initialize(): Promise<void> {
    await this.rebuildNow();
  }

  async applyConfig(nextConfig: ProtoNavConfig): Promise<void> {
    this.config = nextConfig;
    this.setStatus({ focusFolder: nextConfig.focusFolder });
    await this.rebuildNow();
  }

  rebuildNow(): Promise<void> {
    if (this.rebuildInFlight) {
      return this.rebuildInFlight;
    }

    this.rebuildInFlight = this.rebuild().finally(() => {
      this.rebuildInFlight = undefined;
    });

    return this.rebuildInFlight;
  }

  searchSymbols(query: string, limit = 300): IndexedProtoSymbol[] {
    const normalized = normalizeToken(query).toLowerCase();

    if (!normalized) {
      return this.getAllSymbols()
        .sort((left, right) => left.symbol.fqName.localeCompare(right.symbol.fqName))
        .slice(0, limit);
    }

    const ranked = this.getAllSymbols()
      .map((entry) => ({ entry, score: scoreWorkspaceQuery(entry, normalized) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.entry.symbol.fqName.localeCompare(right.entry.symbol.fqName);
      })
      .slice(0, limit)
      .map((row) => row.entry);

    return ranked;
  }

  findDefinitions(token: string, contextUri?: vscode.Uri, limit = 10): IndexedProtoSymbol[] {
    const normalized = normalizeToken(token);
    if (!normalized) {
      return [];
    }

    const candidates = buildDefinitionTokenCandidates(normalized);
    const primaryExactFq = this.symbolsByFq.get(candidates[0]) ?? [];
    const primaryExactShort = this.symbolsByShort.get(candidates[0]) ?? [];

    if (primaryExactFq.length === 0 && isDefinitionLookupAmbiguous(primaryExactShort)) {
      // Too ambiguous for "Go to Definition"; let language-native providers handle it.
      return [];
    }

    const exactByCandidate = candidates.flatMap((candidate) => [
      ...(this.symbolsByFq.get(candidate) ?? []),
      ...(this.symbolsByShort.get(candidate) ?? [])
    ]);
    if (exactByCandidate.length === 0) {
      return [];
    }

    const source = dedupeEntries(exactByCandidate);
    const uriContextBoosts = this.computeContextBoosts(contextUri);

    const ranked = source
      .map((entry) => {
        const baseScore = bestDefinitionScore(entry, candidates);
        if (baseScore <= 0) {
          return undefined;
        }
        const contextBoost = uriContextBoosts.get(entry.uri.toString()) ?? 0;
        return { entry, score: baseScore + contextBoost };
      })
      .filter((row): row is { entry: IndexedProtoSymbol; score: number } => row !== undefined)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.entry.symbol.fqName.localeCompare(right.entry.symbol.fqName);
      });

    const unique = new Map<string, IndexedProtoSymbol>();
    for (const row of ranked) {
      const key = `${row.entry.uri.toString()}::${row.entry.symbol.selectionRange.startLine}:${row.entry.symbol.selectionRange.startChar}`;
      if (!unique.has(key)) {
        unique.set(key, row.entry);
      }
      if (unique.size >= limit) {
        break;
      }
    }

    return [...unique.values()];
  }

  findFieldDefinitions(messageFqNames: string[], fieldCandidates: string[], limit = 10): IndexedProtoSymbol[] {
    const unique = new Map<string, IndexedProtoSymbol>();

    for (const messageFqName of [...new Set(messageFqNames)]) {
      for (const fieldCandidate of [...new Set(fieldCandidates)]) {
        const matches = this.symbolsByFq.get(`${messageFqName}.${fieldCandidate}`) ?? [];

        for (const entry of matches) {
          if (entry.symbol.type !== "field") {
            continue;
          }

          const key = `${entry.uri.toString()}::${entry.symbol.id}`;
          if (!unique.has(key)) {
            unique.set(key, entry);
          }

          if (unique.size >= limit) {
            return [...unique.values()];
          }
        }
      }
    }

    return [...unique.values()];
  }

  toLocation(entry: IndexedProtoSymbol): vscode.Location {
    return new vscode.Location(entry.uri, toRange(entry.symbol.selectionRange));
  }

  toSymbolInformation(entry: IndexedProtoSymbol): vscode.SymbolInformation {
    const location = new vscode.Location(entry.uri, toRange(entry.symbol.selectionRange));
    return new vscode.SymbolInformation(entry.symbol.name, entry.kind, entry.symbol.containerName || "", location);
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.statusEmitter.dispose();
  }

  private getAllSymbols(): IndexedProtoSymbol[] {
    return [...this.symbolsById.values()];
  }

  private async rebuild(): Promise<void> {
    this.logger.info("Rebuilding proto index");
    const startTime = Date.now();
    this.setStatus({ isIndexing: true, lastWarning: undefined });

    this.roots = await this.resolveIndexRoots();
    this.resetIndex();
    this.refreshWatchers();
    this.setStatus({ rootCount: this.roots.length });

    if (this.roots.length === 0) {
      const warning = "No index roots resolved; proto index is empty.";
      this.logger.warn(warning);
      this.setStatus({
        isIndexing: false,
        lastWarning: warning,
        lastIndexedAt: Date.now(),
        lastDurationMs: Date.now() - startTime
      });
      return;
    }

    const files = await this.discoverProtoFiles(this.roots, this.config.maxIndexFiles);
    if (files.length === this.config.maxIndexFiles) {
      const warning = `Reached maxIndexFiles limit (${this.config.maxIndexFiles}).`;
      this.logger.warn(warning);
      this.setStatus({ lastWarning: warning });
    }

    const batchSize = 64;
    for (let index = 0; index < files.length; index += batchSize) {
      const batch = files.slice(index, index + batchSize);
      await Promise.all(batch.map(async (uri) => this.indexFile(uri, false)));
    }

    this.rebuildImportGraph();
    this.emitCounts();

    const finishedAt = Date.now();
    this.setStatus({
      isIndexing: false,
      lastIndexedAt: finishedAt,
      lastDurationMs: finishedAt - startTime
    });

    this.logger.info(`Indexed ${files.length} proto files with ${this.symbolsById.size} symbols.`);
  }

  private resetIndex(): void {
    this.documentsByUri.clear();
    this.symbolsById.clear();
    this.symbolsByShort.clear();
    this.symbolsByFq.clear();
    this.resolvedImportsByUri.clear();
    this.importersByUri.clear();
    this.emitCounts();
  }

  private refreshWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];

    for (const root of this.roots) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.proto"));
      watcher.onDidCreate((uri) => this.queueChange(uri, "upsert"));
      watcher.onDidChange((uri) => this.queueChange(uri, "upsert"));
      watcher.onDidDelete((uri) => this.queueChange(uri, "delete"));
      this.watchers.push(watcher);
    }
  }

  private queueChange(uri: vscode.Uri, kind: PendingChangeKind): void {
    const key = uri.toString();
    const current = this.pendingChanges.get(key);

    if (current === "delete" && kind === "upsert") {
      this.pendingChanges.set(key, "upsert");
    } else if (kind === "delete") {
      this.pendingChanges.set(key, "delete");
    } else if (!current) {
      this.pendingChanges.set(key, kind);
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingChanges();
    }, 250);
  }

  private async flushPendingChanges(): Promise<void> {
    const updates = [...this.pendingChanges.entries()];
    this.pendingChanges.clear();

    for (const [uriString, kind] of updates) {
      const uri = vscode.Uri.parse(uriString);
      if (kind === "delete") {
        this.removeFile(uri);
      } else {
        await this.indexFile(uri);
      }
    }

    this.rebuildImportGraph();
    this.emitCounts();
  }

  private async discoverProtoFiles(roots: vscode.Uri[], maxFiles: number): Promise<vscode.Uri[]> {
    const files = new Map<string, vscode.Uri>();
    const excludePattern = combineGlobPatterns(this.config.excludeGlobs);

    for (const root of roots) {
      const remaining = maxFiles - files.size;
      if (remaining <= 0) {
        break;
      }

      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, "**/*.proto"),
        excludePattern,
        remaining
      );

      for (const uri of found) {
        files.set(uri.toString(), uri);
        if (files.size >= maxFiles) {
          break;
        }
      }
    }

    return [...files.values()];
  }

  private async indexFile(uri: vscode.Uri, emitStatus = true): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parseProto(uri.fsPath, text);
      this.upsertDocument(uri, parsed, emitStatus);
    } catch (error) {
      this.removeFile(uri, emitStatus);
      const warning = `Failed to index ${uri.fsPath}: ${toErrorMessage(error)}`;
      this.logger.warn(warning);
      this.setStatus({ lastWarning: warning });
    }
  }

  private upsertDocument(uri: vscode.Uri, parsed: ParsedProtoDocument, emitStatus: boolean): void {
    this.removeFile(uri, false);

    const uriKey = uri.toString();
    this.documentsByUri.set(uriKey, parsed);

    for (const symbol of parsed.symbols) {
      const entry: IndexedProtoSymbol = {
        uri,
        symbol,
        kind: symbolKindForType(symbol.type)
      };

      this.symbolsById.set(symbol.id, entry);
      pushToBucket(this.symbolsByShort, symbol.shortName, entry);
      pushToBucket(this.symbolsByFq, symbol.fqName, entry);
    }

    if (emitStatus) {
      this.rebuildImportGraph();
      this.emitCounts();
    }
  }

  private removeFile(uri: vscode.Uri, emitStatus = true): void {
    const uriKey = uri.toString();
    const existing = this.documentsByUri.get(uriKey);
    if (!existing) {
      return;
    }

    for (const symbol of existing.symbols) {
      this.symbolsById.delete(symbol.id);
      removeFromBucket(this.symbolsByShort, symbol.shortName, symbol.id);
      removeFromBucket(this.symbolsByFq, symbol.fqName, symbol.id);
    }

    this.documentsByUri.delete(uriKey);

    if (emitStatus) {
      this.rebuildImportGraph();
      this.emitCounts();
    }
  }

  private async resolveIndexRoots(): Promise<vscode.Uri[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return [];
    }

    const focusFolder = this.config.focusFolder;
    if (!focusFolder) {
      return workspaceFolders.map((folder) => folder.uri);
    }

    const roots: vscode.Uri[] = [];

    if (path.isAbsolute(focusFolder)) {
      const absolute = path.resolve(focusFolder);
      const candidate = vscode.Uri.file(absolute);
      const exists = await this.isDirectory(candidate);

      if (!exists) {
        this.logger.warn(`focusFolder does not exist or is not a directory: ${focusFolder}`);
        return [];
      }

      for (const folder of workspaceFolders) {
        if (isSubPath(folder.uri.fsPath, absolute)) {
          roots.push(candidate);
          break;
        }
      }

      if (roots.length === 0) {
        this.logger.warn(`focusFolder is outside workspace folders: ${focusFolder}`);
      }

      return roots;
    }

    for (const folder of workspaceFolders) {
      const candidate = vscode.Uri.joinPath(folder.uri, focusFolder);
      if (await this.isDirectory(candidate)) {
        roots.push(candidate);
      }
    }

    if (roots.length === 0) {
      this.logger.warn(`focusFolder did not resolve inside workspace folders: ${focusFolder}`);
    }

    return roots;
  }

  private async isDirectory(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }

  private computeContextBoosts(contextUri?: vscode.Uri): Map<string, number> {
    const boosts = new Map<string, number>();
    if (!contextUri) {
      return boosts;
    }

    const contextKey = contextUri.toString();

    if (this.documentsByUri.has(contextKey)) {
      boosts.set(contextKey, 120);
    }

    const imported = this.resolvedImportsByUri.get(contextKey);
    if (imported) {
      for (const importedKey of imported) {
        boosts.set(importedKey, Math.max(boosts.get(importedKey) ?? 0, 90));
      }
    }

    const importers = this.importersByUri.get(contextKey);
    if (importers) {
      for (const importerKey of importers) {
        boosts.set(importerKey, Math.max(boosts.get(importerKey) ?? 0, 35));
      }
    }

    return boosts;
  }

  private rebuildImportGraph(): void {
    this.resolvedImportsByUri.clear();
    this.importersByUri.clear();

    const specToUris = new Map<string, Set<string>>();
    const knownPaths: Array<{ uriKey: string; pathKey: string }> = [];

    for (const uriKey of this.documentsByUri.keys()) {
      const uri = vscode.Uri.parse(uriKey);
      const keys = this.computeImportLookupKeys(uri);

      for (const key of keys) {
        pushToSetMap(specToUris, key, uriKey);
        knownPaths.push({ uriKey, pathKey: key });
      }
    }

    for (const [uriKey, document] of this.documentsByUri.entries()) {
      if (document.imports.length === 0) {
        continue;
      }

      const resolved = new Set<string>();

      for (const importSpec of document.imports) {
        const normalizedSpec = normalizeImportSpec(importSpec);
        const exact = specToUris.get(normalizedSpec);
        if (exact && exact.size > 0) {
          for (const uri of exact) {
            resolved.add(uri);
          }
          continue;
        }

        for (const candidate of knownPaths) {
          if (isImportSuffixMatch(candidate.pathKey, normalizedSpec)) {
            resolved.add(candidate.uriKey);
          }
        }
      }

      if (resolved.size === 0) {
        continue;
      }

      this.resolvedImportsByUri.set(uriKey, resolved);
      for (const targetUriKey of resolved) {
        pushToSetMap(this.importersByUri, targetUriKey, uriKey);
      }
    }
  }

  private computeImportLookupKeys(uri: vscode.Uri): string[] {
    const keys = new Set<string>();
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of workspaceFolders) {
      const relativeToWorkspace = path.relative(folder.uri.fsPath, uri.fsPath);
      if (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)) {
        keys.add(normalizeImportSpec(relativeToWorkspace));
      }
    }

    for (const root of this.roots) {
      const relativeToRoot = path.relative(root.fsPath, uri.fsPath);
      if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
        keys.add(normalizeImportSpec(relativeToRoot));
      }
    }

    keys.add(path.basename(uri.fsPath));
    return [...keys];
  }

  private setStatus(update: Partial<ProtoIndexStatus>): void {
    this.status = {
      ...this.status,
      ...update
    };
    this.statusEmitter.fire(this.getStatus());
  }

  private emitCounts(): void {
    this.setStatus({
      indexedFiles: this.documentsByUri.size,
      indexedSymbols: this.symbolsById.size
    });
  }
}

function scoreWorkspaceQuery(entry: IndexedProtoSymbol, queryLower: string): number {
  const shortName = entry.symbol.shortName;
  const fqName = entry.symbol.fqName;
  const shortLower = shortName.toLowerCase();
  const fqLower = fqName.toLowerCase();

  let score = 0;

  if (fqLower === queryLower) {
    score = 1000;
  } else if (shortLower === queryLower) {
    score = 980;
  } else if (fqLower.endsWith(`.${queryLower}`)) {
    score = 860;
  } else if (shortLower.startsWith(queryLower)) {
    score = 760;
  } else if (fqLower.includes(queryLower)) {
    score = 620;
  }

  return score + typePriorityBoost(entry.symbol.type);
}

function scoreDefinitionToken(entry: IndexedProtoSymbol, token: string, tokenLower: string): number {
  const shortName = entry.symbol.shortName;
  const fqName = entry.symbol.fqName;
  const shortLower = shortName.toLowerCase();
  const fqLower = fqName.toLowerCase();
  const isField = entry.symbol.type === "field";

  let score = 0;

  if (fqName === token) {
      score = 1000;
  } else if (shortName === token) {
    score = isField ? 760 : 940;
  } else if (fqLower === tokenLower) {
    score = isField ? 960 : 900;
  } else if (shortLower === tokenLower) {
    score = isField ? 720 : 860;
  } else if (fqLower.endsWith(`.${tokenLower}`)) {
    score = isField ? 780 : 810;
  }

  if (score === 0) {
    return 0;
  }

  return score + typePriorityBoost(entry.symbol.type);
}

function bestDefinitionScore(entry: IndexedProtoSymbol, tokens: string[]): number {
  let best = 0;
  for (const token of tokens) {
    const score = scoreDefinitionToken(entry, token, token.toLowerCase());
    if (score > best) {
      best = score;
    }
  }
  return best;
}

function typePriorityBoost(type: ParsedProtoSymbol["type"]): number {
  switch (type) {
    case "message":
      return 40;
    case "enum":
      return 30;
    case "service":
      return 20;
    case "rpc":
      return 10;
    case "field":
      return 0;
    default:
      return 0;
  }
}

function isDefinitionLookupAmbiguous(entries: IndexedProtoSymbol[]): boolean {
  const nonFieldCount = entries.filter((entry) => entry.symbol.type !== "field").length;
  if (nonFieldCount > 12) {
    return true;
  }

  if (nonFieldCount > 0) {
    return false;
  }

  const fieldCount = entries.length;
  return fieldCount > 4;
}

function pushToBucket(
  buckets: Map<string, IndexedProtoSymbol[]>,
  key: string,
  value: IndexedProtoSymbol
): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.push(value);
    return;
  }

  buckets.set(key, [value]);
}

function removeFromBucket(
  buckets: Map<string, IndexedProtoSymbol[]>,
  key: string,
  symbolId: string
): void {
  const existing = buckets.get(key);
  if (!existing) {
    return;
  }

  const filtered = existing.filter((entry) => entry.symbol.id !== symbolId);
  if (filtered.length === 0) {
    buckets.delete(key);
  } else {
    buckets.set(key, filtered);
  }
}

function dedupeEntries(entries: IndexedProtoSymbol[]): IndexedProtoSymbol[] {
  const byKey = new Map<string, IndexedProtoSymbol>();
  for (const entry of entries) {
    const key = `${entry.uri.toString()}::${entry.symbol.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

function pushToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }

  map.set(key, new Set([value]));
}

function combineGlobPatterns(patterns: string[]): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  if (patterns.length === 1) {
    return patterns[0];
  }

  return `{${patterns.join(",")}}`;
}

function isSubPath(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isImportSuffixMatch(candidatePath: string, importSpec: string): boolean {
  return candidatePath === importSpec || candidatePath.endsWith(`/${importSpec}`);
}

function normalizeImportSpec(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeToken(token: string): string {
  return token.replace(/^[^A-Za-z_]+|[^A-Za-z0-9_.]+$/g, "").trim();
}

function buildDefinitionTokenCandidates(normalizedToken: string): string[] {
  const candidates = new Set<string>([normalizedToken]);
  const dotIndex = normalizedToken.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < normalizedToken.length - 1) {
    candidates.add(normalizedToken.slice(dotIndex + 1));
  }
  return [...candidates];
}

function toRange(range: TextRange): vscode.Range {
  return new vscode.Range(range.startLine, range.startChar, range.endLine, range.endChar);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
