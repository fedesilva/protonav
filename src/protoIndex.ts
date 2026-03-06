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

type PendingChangeKind = "upsert" | "delete";

export class ProtoIndex implements vscode.Disposable {
  private config: ProtoNavConfig;
  private readonly documentsByUri = new Map<string, ParsedProtoDocument>();
  private readonly symbolsById = new Map<string, IndexedProtoSymbol>();
  private readonly symbolsByShort = new Map<string, IndexedProtoSymbol[]>();
  private readonly symbolsByFq = new Map<string, IndexedProtoSymbol[]>();
  private roots: vscode.Uri[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly pendingChanges = new Map<string, PendingChangeKind>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(config: ProtoNavConfig, private readonly logger: ProtoNavLogger) {
    this.config = config;
  }

  getConfig(): ProtoNavConfig {
    return this.config;
  }

  async initialize(): Promise<void> {
    await this.rebuild();
  }

  async applyConfig(nextConfig: ProtoNavConfig): Promise<void> {
    this.config = nextConfig;
    await this.rebuild();
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

  findDefinitions(token: string, limit = 50): IndexedProtoSymbol[] {
    const normalized = normalizeToken(token);
    if (!normalized) {
      return [];
    }

    const lowered = normalized.toLowerCase();
    const exactFq = this.symbolsByFq.get(normalized) ?? [];
    const exactShort = this.symbolsByShort.get(normalized) ?? [];

    const source = exactFq.length > 0 || exactShort.length > 0 ? [...exactFq, ...exactShort] : this.getAllSymbols();

    const ranked = source
      .map((entry) => ({ entry, score: scoreDefinitionToken(entry, normalized, lowered) }))
      .filter((row) => row.score > 0)
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
  }

  private getAllSymbols(): IndexedProtoSymbol[] {
    return [...this.symbolsById.values()];
  }

  private async rebuild(): Promise<void> {
    this.logger.info("Rebuilding proto index");

    this.roots = await this.resolveIndexRoots();
    this.resetIndex();
    this.refreshWatchers();

    if (this.roots.length === 0) {
      this.logger.warn("No index roots resolved; proto index is empty");
      return;
    }

    const files = await this.discoverProtoFiles(this.roots, this.config.maxIndexFiles);
    if (files.length === this.config.maxIndexFiles) {
      this.logger.warn(`Reached maxIndexFiles limit (${this.config.maxIndexFiles}).`);
    }

    const batchSize = 64;
    for (let index = 0; index < files.length; index += batchSize) {
      const batch = files.slice(index, index + batchSize);
      await Promise.all(batch.map(async (uri) => this.indexFile(uri)));
    }

    this.logger.info(`Indexed ${files.length} proto files with ${this.symbolsById.size} symbols.`);
  }

  private resetIndex(): void {
    this.documentsByUri.clear();
    this.symbolsById.clear();
    this.symbolsByShort.clear();
    this.symbolsByFq.clear();
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

  private async indexFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parseProto(uri.fsPath, text);
      this.upsertDocument(uri, parsed);
    } catch (error) {
      this.removeFile(uri);
      this.logger.warn(`Failed to index ${uri.fsPath}: ${toErrorMessage(error)}`);
    }
  }

  private upsertDocument(uri: vscode.Uri, parsed: ParsedProtoDocument): void {
    this.removeFile(uri);

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
  }

  private removeFile(uri: vscode.Uri): void {
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

  let score = 0;

  if (fqName === token) {
    score = 1000;
  } else if (shortName === token) {
    score = 940;
  } else if (fqLower === tokenLower) {
    score = 900;
  } else if (shortLower === tokenLower) {
    score = 860;
  } else if (fqLower.endsWith(`.${tokenLower}`)) {
    score = 810;
  } else if (token.includes(".") && fqLower.includes(tokenLower)) {
    score = 700;
  }

  return score + typePriorityBoost(entry.symbol.type);
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
    default:
      return 0;
  }
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

function normalizeToken(token: string): string {
  return token.replace(/^[^A-Za-z_]+|[^A-Za-z0-9_.]+$/g, "").trim();
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
