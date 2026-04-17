import { ParsedProtoDocument, ParsedProtoSymbol, ProtoSymbolType } from "./protoTypes";

interface BlockCandidate {
  type: "message" | "enum" | "service";
  name: string;
  line: number;
  nameStartChar: number;
  selectionEndChar: number;
  openBraceSearchStart: number;
}

interface OpenBlock {
  openDepth: number;
  symbol: ParsedProtoSymbol;
}

const MESSAGE_RE = /^(\s*message\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const ENUM_RE = /^(\s*enum\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const SERVICE_RE = /^(\s*service\s+)([A-Za-z_][A-Za-z0-9_]*)\b/;
const RPC_RE = /^(\s*rpc\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PACKAGE_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/;
const IMPORT_RE = /^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/;

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
        openBlocks,
        line: lineIndex,
        nameStartChar: rpcMatch[1].length,
        selectionEndChar: rpcMatch[1].length + rpcMatch[2].length,
        symbolCounter: symbolCounter + 1,
        parentId: serviceBlock?.symbol.id
      });

      symbolCounter += 1;
      symbol.range.endLine = lineIndex;
      symbol.range.endChar = rpcMatch[1].length + rpcMatch[2].length;
      symbols.push(symbol);
      pendingRpc = symbol;
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
          openBlocks.push({ openDepth: braceDepth, symbol: pendingRpc });
          pendingRpc = undefined;
          continue;
        }

        if (pendingBlock && isMatchingOpenBrace(pendingBlock, lineIndex, charIndex)) {
          const symbol = buildSymbol({
            filePath,
            type: pendingBlock.type,
            name: pendingBlock.name,
            packageName,
            openBlocks,
            line: pendingBlock.line,
            nameStartChar: pendingBlock.nameStartChar,
            selectionEndChar: pendingBlock.selectionEndChar,
            symbolCounter: symbolCounter + 1,
            parentId: openBlocks.at(-1)?.symbol.id
          });

          symbolCounter += 1;
          openBlocks.push({ openDepth: braceDepth, symbol });
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
    block.symbol.range.endLine = finalLineIndex;
    block.symbol.range.endChar = finalLine.length;
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
  return openBlocks.some((block) => block.symbol.type === "service");
}

function getInnermostService(openBlocks: OpenBlock[]): OpenBlock | undefined {
  for (let index = openBlocks.length - 1; index >= 0; index -= 1) {
    const block = openBlocks[index];
    if (block.symbol.type === "service") {
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

    block.symbol.range.endLine = line;
    block.symbol.range.endChar = char;
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

  return undefined;
}

function toBlockCandidate(
  type: "message" | "enum" | "service",
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

function buildSymbol(input: {
  filePath: string;
  type: ProtoSymbolType;
  name: string;
  packageName: string;
  openBlocks: OpenBlock[];
  line: number;
  nameStartChar: number;
  selectionEndChar: number;
  symbolCounter: number;
  parentId?: string;
}): ParsedProtoSymbol {
  const scopePath = input.openBlocks.map((block) => block.symbol.name);
  const nameParts = input.packageName ? [input.packageName, ...scopePath, input.name] : [...scopePath, input.name];

  return {
    id: `${input.filePath}#${input.symbolCounter}`,
    parentId: input.parentId,
    name: input.name,
    shortName: input.name,
    fqName: nameParts.join("."),
    type: input.type,
    packageName: input.packageName,
    scopePath,
    containerName: scopePath.length > 0 ? scopePath[scopePath.length - 1] : input.packageName || undefined,
    range: {
      startLine: input.line,
      startChar: firstNonWhitespace(input.nameStartChar),
      endLine: input.line,
      endChar: input.selectionEndChar
    },
    selectionRange: {
      startLine: input.line,
      startChar: input.nameStartChar,
      endLine: input.line,
      endChar: input.selectionEndChar
    }
  };
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
