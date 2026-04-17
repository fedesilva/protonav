import { getIdentifierAtPosition, getLine, readIdentifierBackward, splitTopLevelCommaSeparated } from "./shared";
import { MemberAccess, MemberNavigationTranslator, SourceDocument } from "./types";

interface PythonFunctionContext {
  indent: number;
  signatureText: string;
  startLine: number;
}

export const pythonMemberNavigationTranslator: MemberNavigationTranslator = {
  languageId: "python",
  detectMemberAccess(document, position) {
    const line = getLine(document, position.line);
    const identifier = getIdentifierAtPosition(line, position.character);
    if (!identifier) {
      return undefined;
    }

    const dotIndex = identifier.start - 1;
    if (dotIndex < 0 || line[dotIndex] !== ".") {
      return undefined;
    }

    const receiver = readIdentifierBackward(line, dotIndex - 1);
    if (!receiver) {
      return undefined;
    }

    if (!/^[a-z_][a-z0-9_]*$/.test(identifier.text)) {
      return undefined;
    }

    if (nextPythonTokenIsCall(line, identifier.end)) {
      return undefined;
    }

    return {
      receiverText: receiver.text,
      memberText: identifier.text,
      syntax: "python-attribute",
      line: position.line,
      startChar: identifier.start,
      endChar: identifier.end
    };
  },
  inferReceiverTypeTokens(document, position, access) {
    const context = findPythonFunctionContext(document, position.line);
    const localMatches = findLocalPythonTypeTokens(document, access, context);
    if (localMatches.length > 0) {
      return localMatches;
    }

    if (!context) {
      return [];
    }

    const parameterMatch = findPythonTypeForName(extractPythonParamsText(context.signatureText), access.receiverText);
    return parameterMatch ? [parameterMatch] : [];
  },
  normalizeFieldCandidates(access) {
    return [access.memberText];
  }
};

function findLocalPythonTypeTokens(
  document: SourceDocument,
  access: MemberAccess,
  context: PythonFunctionContext | undefined
): string[] {
  const receiverPattern = escapeRegExp(access.receiverText);
  const annotationPattern = new RegExp(
    String.raw`^\s*${receiverPattern}\s*:\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*(?:=\s*.+)?$`
  );
  const constructorPattern = new RegExp(
    String.raw`^\s*${receiverPattern}\s*=\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*\(`
  );

  const startLine = context ? context.startLine + 1 : 0;
  let skippedNestedIndent: number | undefined;

  for (let lineIndex = access.line; lineIndex >= startLine; lineIndex -= 1) {
    const sourceLine = getLine(document, lineIndex);
    const line = lineIndex === access.line ? sourceLine.slice(0, access.startChar) : sourceLine;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = leadingIndent(line);

    if (skippedNestedIndent !== undefined) {
      if (indent > skippedNestedIndent) {
        continue;
      }
      skippedNestedIndent = undefined;
    }

    if (context && /^\s*(?:def|class)\b/.test(line) && indent > context.indent) {
      skippedNestedIndent = indent;
      continue;
    }

    const annotationMatch = annotationPattern.exec(line);
    if (annotationMatch) {
      return [annotationMatch[1]];
    }

    const constructorMatch = constructorPattern.exec(line);
    if (constructorMatch) {
      return [constructorMatch[1]];
    }
  }

  return [];
}

function findPythonFunctionContext(document: SourceDocument, targetLine: number): PythonFunctionContext | undefined {
  const currentIndent = leadingIndent(getLine(document, targetLine));

  for (let lineIndex = targetLine; lineIndex >= 0; lineIndex -= 1) {
    const line = getLine(document, lineIndex);
    if (!/^\s*def\b/.test(line)) {
      continue;
    }

    const indent = leadingIndent(line);
    if (indent > currentIndent) {
      continue;
    }

    return {
      indent,
      startLine: lineIndex,
      signatureText: collectPythonSignature(document, lineIndex)
    };
  }

  return undefined;
}

function collectPythonSignature(document: SourceDocument, startLine: number): string {
  const parts: string[] = [];
  let parenDepth = 0;

  for (let lineIndex = startLine; lineIndex < document.lines.length; lineIndex += 1) {
    const line = stripPythonComment(getLine(document, lineIndex)).trim();
    parts.push(line);

    for (const char of line) {
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")" && parenDepth > 0) {
        parenDepth -= 1;
      }
    }

    if (line.includes(":") && parenDepth === 0) {
      break;
    }
  }

  return parts.join(" ");
}

function extractPythonParamsText(signatureText: string): string {
  const openIndex = signatureText.indexOf("(");
  if (openIndex < 0) {
    return "";
  }

  const closeIndex = findMatchingParen(signatureText, openIndex);
  if (closeIndex < 0) {
    return "";
  }

  return signatureText.slice(openIndex + 1, closeIndex);
}

function findPythonTypeForName(paramsText: string, receiverName: string): string | undefined {
  for (const entry of splitTopLevelCommaSeparated(paramsText)) {
    const trimmed = entry.trim().replace(/^\*{1,2}/, "");
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_\.]*)(?:\s*=.*)?$/.exec(trimmed);
    if (!match || match[1] !== receiverName) {
      continue;
    }

    return match[2];
  }

  return undefined;
}

function nextPythonTokenIsCall(line: string, index: number): boolean {
  for (let cursor = index; cursor < line.length; cursor += 1) {
    if (/\s/.test(line[cursor])) {
      continue;
    }
    return line[cursor] === "(";
  }

  return false;
}

function leadingIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

function stripPythonComment(line: string): string {
  const commentIndex = line.indexOf("#");
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
