import { getIdentifierAtPosition, getLine, nextNonWhitespace, readIdentifierBackward, splitTopLevelCommaSeparated, toSnakeCase } from "./shared";
import { MemberAccess, MemberNavigationTranslator, SourceDocument } from "./types";

const GO_HELPER_MEMBERS = new Set([
  "Descriptor",
  "ProtoMessage",
  "ProtoReflect",
  "Reset",
  "String"
]);

interface GoFunctionContext {
  bodyDepth: number;
  bodyStartLine: number;
  signatureText: string;
  startLine: number;
}

export const goMemberNavigationTranslator: MemberNavigationTranslator = {
  languageId: "go",
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

    const nextChar = nextNonWhitespace(line, identifier.end);
    if (nextChar === "(") {
      if (!/^Get[A-Z]/.test(identifier.text) || isGoHelperMember(identifier.text)) {
        return undefined;
      }

      return {
        receiverText: receiver.text,
        memberText: identifier.text,
        syntax: "go-getter",
        line: position.line,
        startChar: identifier.start,
        endChar: identifier.end
      };
    }

    if (!/^[A-Z]/.test(identifier.text) || isGoHelperMember(identifier.text)) {
      return undefined;
    }

    return {
      receiverText: receiver.text,
      memberText: identifier.text,
      syntax: "go-field",
      line: position.line,
      startChar: identifier.start,
      endChar: identifier.end
    };
  },
  inferReceiverTypeTokens(document, position, access) {
    const context = findGoFunctionContext(document, position.line);
    const localMatches = findLocalGoTypeTokens(document, access, context?.bodyStartLine ?? 0);
    if (localMatches.length > 0) {
      return localMatches;
    }

    if (!context) {
      return [];
    }

    const receiverMatches = findGoTypeForName(extractGoReceiverText(context.signatureText), access.receiverText);
    if (receiverMatches) {
      return [receiverMatches];
    }

    const parameterMatches = findGoTypeForName(extractGoParamsText(context.signatureText), access.receiverText);
    return parameterMatches ? [parameterMatches] : [];
  },
  normalizeFieldCandidates(access) {
    if (access.syntax === "go-getter") {
      const getterTarget = access.memberText.slice(3);
      const normalized = toSnakeCase(getterTarget);
      return normalized ? [normalized] : [];
    }

    const normalized = toSnakeCase(access.memberText);
    return normalized ? [normalized] : [];
  }
};

function findLocalGoTypeTokens(document: SourceDocument, access: MemberAccess, startLine: number): string[] {
  const receiverPattern = escapeRegExp(access.receiverText);
  const assignmentPattern = new RegExp(
    String.raw`^\s*${receiverPattern}\s*(?::=|=)\s*&?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\{`
  );
  const varTypePattern = new RegExp(String.raw`^\s*var\s+${receiverPattern}\s+(.+?)(?:\s*=\s*.+)?$`);
  const varAssignmentPattern = new RegExp(
    String.raw`^\s*var\s+${receiverPattern}\s*=\s*&?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\{`
  );

  for (let lineIndex = access.line; lineIndex >= startLine; lineIndex -= 1) {
    const sourceLine = getLine(document, lineIndex);
    const line = lineIndex === access.line ? sourceLine.slice(0, access.startChar) : sourceLine;

    const assignmentMatch = assignmentPattern.exec(line);
    if (assignmentMatch) {
      const normalized = normalizeGoTypeToken(assignmentMatch[1]);
      if (normalized) {
        return [normalized];
      }
    }

    const varAssignmentMatch = varAssignmentPattern.exec(line);
    if (varAssignmentMatch) {
      const normalized = normalizeGoTypeToken(varAssignmentMatch[1]);
      if (normalized) {
        return [normalized];
      }
    }

    const varTypeMatch = varTypePattern.exec(line);
    if (varTypeMatch) {
      const normalized = normalizeGoTypeToken(varTypeMatch[1]);
      if (normalized) {
        return [normalized];
      }
    }
  }

  return [];
}

function findGoFunctionContext(document: SourceDocument, targetLine: number): GoFunctionContext | undefined {
  const stack: GoFunctionContext[] = [];
  let braceDepth = 0;
  let pendingFunction: { startLine: number; signatureLines: string[] } | undefined;

  for (let lineIndex = 0; lineIndex <= targetLine; lineIndex += 1) {
    const line = stripGoLineComment(getLine(document, lineIndex));

    if (!pendingFunction && /^\s*func\b/.test(line)) {
      pendingFunction = {
        startLine: lineIndex,
        signatureLines: [line]
      };
    } else if (pendingFunction && lineIndex > pendingFunction.startLine) {
      pendingFunction.signatureLines.push(line);
    }

    for (const char of line) {
      if (char === "{") {
        braceDepth += 1;
        if (pendingFunction) {
          stack.push({
            startLine: pendingFunction.startLine,
            bodyStartLine: lineIndex,
            signatureText: pendingFunction.signatureLines.join(" "),
            bodyDepth: braceDepth
          });
          pendingFunction = undefined;
        }
      } else if (char === "}") {
        if (stack.length > 0 && braceDepth === stack[stack.length - 1].bodyDepth) {
          stack.pop();
        }
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }

  return stack.at(-1);
}

function extractGoReceiverText(signatureText: string): string {
  const funcIndex = signatureText.indexOf("func");
  if (funcIndex < 0) {
    return "";
  }

  let cursor = funcIndex + 4;
  while (cursor < signatureText.length && /\s/.test(signatureText[cursor])) {
    cursor += 1;
  }

  if (signatureText[cursor] !== "(") {
    return "";
  }

  const receiverEnd = findMatchingParen(signatureText, cursor);
  if (receiverEnd < 0) {
    return "";
  }

  const afterReceiver = skipWhitespace(signatureText, receiverEnd + 1);
  if (afterReceiver >= signatureText.length || !/[A-Za-z_]/.test(signatureText[afterReceiver])) {
    return "";
  }

  return signatureText.slice(cursor + 1, receiverEnd);
}

function extractGoParamsText(signatureText: string): string {
  const funcIndex = signatureText.indexOf("func");
  if (funcIndex < 0) {
    return "";
  }

  let cursor = funcIndex + 4;
  while (cursor < signatureText.length && /\s/.test(signatureText[cursor])) {
    cursor += 1;
  }

  if (signatureText[cursor] === "(") {
    const possibleReceiverEnd = findMatchingParen(signatureText, cursor);
    if (possibleReceiverEnd < 0) {
      return "";
    }

    const afterGroup = skipWhitespace(signatureText, possibleReceiverEnd + 1);
    if (afterGroup < signatureText.length && /[A-Za-z_]/.test(signatureText[afterGroup])) {
      cursor = afterGroup;
    }
  }

  while (cursor < signatureText.length && signatureText[cursor] !== "(") {
    cursor += 1;
  }

  if (cursor >= signatureText.length) {
    return "";
  }

  const paramsEnd = findMatchingParen(signatureText, cursor);
  if (paramsEnd < 0) {
    return "";
  }

  return signatureText.slice(cursor + 1, paramsEnd);
}

function findGoTypeForName(sectionText: string, receiverName: string): string | undefined {
  for (const entry of splitTopLevelCommaSeparated(sectionText)) {
    const match = /^(.+?)\s+(.+)$/.exec(entry.trim());
    if (!match) {
      continue;
    }

    const names = match[1]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!names.includes(receiverName)) {
      continue;
    }

    return normalizeGoTypeToken(match[2]);
  }

  return undefined;
}

function normalizeGoTypeToken(typeToken: string): string | undefined {
  let normalized = typeToken.replace(/\s+/g, "");
  normalized = normalized.replace(/^\.\.\./, "");
  normalized = normalized.replace(/^\*+/, "");
  normalized = normalized.replace(/^\((.*)\)$/, "$1");

  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(normalized)) {
    return undefined;
  }

  const shortName = normalized.slice(normalized.lastIndexOf(".") + 1);
  if (!/^[A-Z]/.test(shortName)) {
    return undefined;
  }

  return normalized;
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

function skipWhitespace(text: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function stripGoLineComment(line: string): string {
  const commentIndex = line.indexOf("//");
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function isGoHelperMember(memberName: string): boolean {
  return GO_HELPER_MEMBERS.has(memberName) || memberName.startsWith("XXX_");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
