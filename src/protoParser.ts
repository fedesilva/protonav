import { ParsedProtoDocument, ParsedProtoSymbol, ProtoSymbolType } from "./protoTypes";

interface BlockCandidate {
  type: "message" | "enum" | "service" | "oneof";
  name: string;
  line: number;
  nameStartChar: number;
  selectionEndChar: number;
  openBraceSearchStart: number;
}

interface FieldCandidate {
  line: number;
  rangeStartChar: number;
  rangeEndChar: number;
  selectionStartChar: number;
  selectionEndChar: number;
  name: string;
}

interface OpenBlock {
  type: "message" | "enum" | "service" | "rpc" | "oneof";
  openDepth: number;
  symbol?: ParsedProtoSymbol;
}

const MESSAGE_RE = /^(\s*message\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const ENUM_RE = /^(\s*enum\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const SERVICE_RE = /^(\s*service\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const ONEOF_RE = /^(\s*oneof\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const RPC_RE = /^(\s*rpc\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PACKAGE_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/;
const IMPORT_RE = /^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/;
const FIELD_RE =
  /^\s*(?:(?:optional|required|repeated)\s+)?(?:map\s*<[^>]+>|\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:0|[1-9][0-9]*)\b[^;{]*;/;

export function parseProto(filePath: string, rawText: string): ParsedProtoDocument {
  const text = stripBlockComments(rawText);
  const lines = text.split(/\r?\n/);

  let packageName = "";
  const imports: string[] = [];
  const symbols: ParsedProtoSymbol[] = [];
  const openBlocks: OpenBlock[] = [];

  let braceDepth = 0;
  let pendingBlock: BlockCandidate | undefined;
  let pendingRpc: ParsedProtoSymbol | undefined;
  let symbolCounter = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const originalLine = lines[lineIndex];
    const line = stripInlineComment(originalLine);

    const packageMatch = PACKAGE_RE.exec(line);
    if (packageMatch) {
      packageName = packageMatch[1];
    }

    const importMatch = IMPORT_RE.exec(line);
    if (importMatch) {
      imports.push(importMatch[1]);
    }

    const newBlock = matchBlockDeclaration(line, lineIndex);
    if (newBlock) {
      pendingBlock = newBlock;
    }

    const rpcMatch = RPC_RE.exec(line);
    if (rpcMatch && isInsideService(openBlocks)) {
      const serviceBlock = getInnermostService(openBlocks);
      const symbol = buildSymbol({
        filePath,
        type: "rpc",
        name: rpcMatch[2],
        packageName,
        scopePath: getScopePath(openBlocks),
        line: lineIndex,
        rangeStartChar: rpcMatch[1].length,
        nameStartChar: rpcMatch[1].length,
        selectionEndChar: rpcMatch[1].length + rpcMatch[2].length,
        symbolCounter: symbolCounter + 1,
        parentId: serviceBlock?.symbol?.id
      });

      symbolCounter += 1;
      symbol.range.endLine = lineIndex;
      symbol.range.endChar = rpcMatch[1].length + rpcMatch[2].length;
      symbols.push(symbol);
      pendingRpc = symbol;
    }

    const fieldCandidate = matchFieldDeclaration(line, lineIndex);
    if (fieldCandidate && isInsideFieldContainer(openBlocks)) {
      const messageBlock = getInnermostMessage(openBlocks);
      const messageSymbol = messageBlock?.symbol;

      if (messageSymbol) {
        const symbol = buildSymbol({
          filePath,
          type: "field",
          name: fieldCandidate.name,
          packageName,
          scopePath: getMessageScopePath(openBlocks),
          line: lineIndex,
          rangeStartChar: fieldCandidate.rangeStartChar,
          nameStartChar: fieldCandidate.selectionStartChar,
          selectionEndChar: fieldCandidate.selectionEndChar,
          symbolCounter: symbolCounter + 1,
          parentId: messageSymbol.id,
          ownerFqName: messageSymbol.fqName,
          rangeEndChar: fieldCandidate.rangeEndChar
        });

        symbolCounter += 1;
        symbols.push(symbol);
      }
    }

    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex];

      if (pendingRpc && char === ";") {
        pendingRpc.range.endLine = lineIndex;
        pendingRpc.range.endChar = charIndex + 1;
        pendingRpc = undefined;
        continue;
      }

      if (char === "{") {
        braceDepth += 1;

        if (pendingRpc) {
          openBlocks.push({ type: "rpc", openDepth: braceDepth, symbol: pendingRpc });
          pendingRpc = undefined;
          continue;
        }

        if (pendingBlock && isMatchingOpenBrace(pendingBlock, lineIndex, charIndex)) {
          if (pendingBlock.type === "oneof") {
            openBlocks.push({ type: "oneof", openDepth: braceDepth });
            pendingBlock = undefined;
            continue;
          }

          const symbol = buildSymbol({
            filePath,
            type: pendingBlock.type,
            name: pendingBlock.name,
            packageName,
            scopePath: getScopePath(openBlocks),
            line: pendingBlock.line,
            rangeStartChar: pendingBlock.nameStartChar,
            nameStartChar: pendingBlock.nameStartChar,
            selectionEndChar: pendingBlock.selectionEndChar,
            symbolCounter: symbolCounter + 1,
            parentId: openBlocks.at(-1)?.symbol?.id
          });

          symbolCounter += 1;
          openBlocks.push({ type: pendingBlock.type, openDepth: braceDepth, symbol });
          symbols.push(symbol);
          pendingBlock = undefined;
        }
      } else if (char === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        closeBlocksToDepth(openBlocks, braceDepth, lineIndex, charIndex + 1);
      }
    }

    if (pendingBlock && lineIndex > pendingBlock.line + 1 && line.trim().length > 0 && !line.includes("{")) {
      pendingBlock = undefined;
    }
  }

  const finalLineIndex = Math.max(0, lines.length - 1);
  const finalLine = lines[finalLineIndex] ?? "";
  if (pendingRpc) {
    pendingRpc.range.endLine = finalLineIndex;
    pendingRpc.range.endChar = finalLine.length;
  }
  while (openBlocks.length > 0) {
    const block = openBlocks.pop();
    if (!block) {
      break;
    }
    if (block.symbol) {
      block.symbol.range.endLine = finalLineIndex;
      block.symbol.range.endChar = finalLine.length;
    }
  }

  symbols.sort((left, right) => {
    if (left.range.startLine !== right.range.startLine) {
      return left.range.startLine - right.range.startLine;
    }
    if (left.range.startChar !== right.range.startChar) {
      return left.range.startChar - right.range.startChar;
    }
    return left.fqName.localeCompare(right.fqName);
  });

  return {
    filePath,
    packageName,
    imports,
    symbols
  };
}

function isInsideService(openBlocks: OpenBlock[]): boolean {
  return openBlocks.some((block) => block.symbol?.type === "service");
}

function isInsideFieldContainer(openBlocks: OpenBlock[]): boolean {
  if (!getInnermostMessage(openBlocks)) {
    return false;
  }

  for (let index = openBlocks.length - 1; index >= 0; index -= 1) {
    const block = openBlocks[index];
    if (block.type === "enum" || block.type === "service" || block.type === "rpc") {
      return false;
    }
    if (block.type === "message" || block.type === "oneof") {
      return true;
    }
  }

  return false;
}

function getInnermostService(openBlocks: OpenBlock[]): OpenBlock | undefined {
  for (let index = openBlocks.length - 1; index >= 0; index -= 1) {
    const block = openBlocks[index];
    if (block.symbol?.type === "service") {
      return block;
    }
  }
  return undefined;
}

function getInnermostMessage(openBlocks: OpenBlock[]): OpenBlock | undefined {
  for (let index = openBlocks.length - 1; index >= 0; index -= 1) {
    const block = openBlocks[index];
    if (block.symbol?.type === "message") {
      return block;
    }
  }
  return undefined;
}

function closeBlocksToDepth(openBlocks: OpenBlock[], depth: number, line: number, char: number): void {
  while (openBlocks.length > 0 && depth < openBlocks[openBlocks.length - 1].openDepth) {
    const block = openBlocks.pop();
    if (!block) {
      return;
    }

    if (block.symbol) {
      block.symbol.range.endLine = line;
      block.symbol.range.endChar = char;
    }
  }
}

function isMatchingOpenBrace(block: BlockCandidate, currentLine: number, currentChar: number): boolean {
  if (currentLine < block.line) {
    return false;
  }

  if (currentLine > block.line) {
    return true;
  }

  return currentChar >= block.openBraceSearchStart;
}

function matchBlockDeclaration(line: string, lineIndex: number): BlockCandidate | undefined {
  const messageMatch = MESSAGE_RE.exec(line);
  if (messageMatch) {
    return toBlockCandidate("message", messageMatch, line, lineIndex);
  }

  const enumMatch = ENUM_RE.exec(line);
  if (enumMatch) {
    return toBlockCandidate("enum", enumMatch, line, lineIndex);
  }

  const serviceMatch = SERVICE_RE.exec(line);
  if (serviceMatch) {
    return toBlockCandidate("service", serviceMatch, line, lineIndex);
  }

  const oneofMatch = ONEOF_RE.exec(line);
  if (oneofMatch) {
    return toBlockCandidate("oneof", oneofMatch, line, lineIndex);
  }

  return undefined;
}

function toBlockCandidate(
  type: "message" | "enum" | "service" | "oneof",
  match: RegExpExecArray,
  line: string,
  lineIndex: number
): BlockCandidate {
  const name = match[2];
  const nameStartChar = match[1].length;
  const selectionEndChar = nameStartChar + name.length;
  const openBraceSearchStart = line.indexOf("{", selectionEndChar);

  return {
    type,
    name,
    line: lineIndex,
    nameStartChar,
    selectionEndChar,
    openBraceSearchStart: openBraceSearchStart >= 0 ? openBraceSearchStart : 0
  };
}

function matchFieldDeclaration(line: string, lineIndex: number): FieldCandidate | undefined {
  const match = FIELD_RE.exec(line);
  if (!match) {
    return undefined;
  }

  const name = match[1];
  const fullMatch = match[0];
  const selectionStartChar = (match.index ?? 0) + fullMatch.indexOf(name);
  const rangeStartChar = line.search(/\S/);

  return {
    line: lineIndex,
    rangeStartChar: rangeStartChar >= 0 ? rangeStartChar : 0,
    rangeEndChar: (match.index ?? 0) + fullMatch.length,
    selectionStartChar,
    selectionEndChar: selectionStartChar + name.length,
    name
  };
}

function buildSymbol(input: {
  filePath: string;
  type: ProtoSymbolType;
  name: string;
  packageName: string;
  scopePath: string[];
  line: number;
  rangeStartChar: number;
  nameStartChar: number;
  selectionEndChar: number;
  symbolCounter: number;
  parentId?: string;
  ownerFqName?: string;
  rangeEndChar?: number;
}): ParsedProtoSymbol {
  const nameParts = input.packageName ? [input.packageName, ...input.scopePath, input.name] : [...input.scopePath, input.name];

  return {
    id: `${input.filePath}#${input.symbolCounter}`,
    parentId: input.parentId,
    name: input.name,
    shortName: input.name,
    fqName: nameParts.join("."),
    type: input.type,
    packageName: input.packageName,
    scopePath: input.scopePath,
    ownerFqName: input.ownerFqName,
    containerName: input.scopePath.length > 0 ? input.scopePath[input.scopePath.length - 1] : input.packageName || undefined,
    range: {
      startLine: input.line,
      startChar: firstNonWhitespace(input.rangeStartChar),
      endLine: input.line,
      endChar: input.rangeEndChar ?? input.selectionEndChar
    },
    selectionRange: {
      startLine: input.line,
      startChar: input.nameStartChar,
      endLine: input.line,
      endChar: input.selectionEndChar
    }
  };
}

function getScopePath(openBlocks: OpenBlock[]): string[] {
  return openBlocks.flatMap((block) => (block.symbol ? [block.symbol.name] : []));
}

function getMessageScopePath(openBlocks: OpenBlock[]): string[] {
  return openBlocks.flatMap((block) => (block.symbol?.type === "message" ? [block.symbol.name] : []));
}

function firstNonWhitespace(index: number): number {
  return Math.max(0, index);
}

function stripInlineComment(line: string): string {
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (!escaped && char === "\\") {
      escaped = true;
      continue;
    }

    if (!escaped && !inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
    } else if (!escaped && !inDoubleQuote && char === "'") {
      inSingleQuote = !inSingleQuote;
    }

    if (!inDoubleQuote && !inSingleQuote && char === "/" && nextChar === "/") {
      return line.slice(0, i);
    }

    escaped = false;
  }

  return line;
}

function stripBlockComments(text: string): string {
  let inComment = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;
  let result = "";

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inComment) {
      if (char === "*" && nextChar === "/") {
        inComment = false;
        result += "  ";
        i += 1;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (!escaped && char === "\\") {
      escaped = true;
      result += char;
      continue;
    }

    if (!escaped && !inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
    } else if (!escaped && !inDoubleQuote && char === "'") {
      inSingleQuote = !inSingleQuote;
    }

    if (!inDoubleQuote && !inSingleQuote && char === "/" && nextChar === "*") {
      inComment = true;
      result += "  ";
      i += 1;
      escaped = false;
      continue;
    }

    result += char;
    escaped = false;
  }

  return result;
}
