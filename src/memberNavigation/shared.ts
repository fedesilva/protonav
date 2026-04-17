import { MemberAccess, SourceDocument } from "./types";

interface IdentifierSpan {
  text: string;
  start: number;
  end: number;
}

export function createSourceDocument(text: string, languageId: string): SourceDocument {
  return {
    languageId,
    text,
    lines: text.split(/\r?\n/)
  };
}

export function getLine(document: SourceDocument, line: number): string {
  return document.lines[line] ?? "";
}

export function getIdentifierAtPosition(line: string, character: number): IdentifierSpan | undefined {
  if (!line) {
    return undefined;
  }

  let index = Math.min(Math.max(character, 0), Math.max(0, line.length - 1));
  if (!isIdentifierChar(line[index])) {
    index -= 1;
  }

  if (index < 0 || !isIdentifierChar(line[index])) {
    return undefined;
  }

  let start = index;
  while (start > 0 && isIdentifierChar(line[start - 1])) {
    start -= 1;
  }

  let end = index + 1;
  while (end < line.length && isIdentifierChar(line[end])) {
    end += 1;
  }

  return {
    text: line.slice(start, end),
    start,
    end
  };
}

export function readIdentifierBackward(line: string, endIndex: number): IdentifierSpan | undefined {
  if (endIndex < 0 || endIndex >= line.length || !isIdentifierChar(line[endIndex])) {
    return undefined;
  }

  let start = endIndex;
  while (start > 0 && isIdentifierChar(line[start - 1])) {
    start -= 1;
  }

  return {
    text: line.slice(start, endIndex + 1),
    start,
    end: endIndex + 1
  };
}

export function nextNonWhitespace(line: string, index: number): string | undefined {
  for (let cursor = index; cursor < line.length; cursor += 1) {
    if (!/\s/.test(line[cursor])) {
      return line[cursor];
    }
  }

  return undefined;
}

export function splitTopLevelCommaSeparated(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of text) {
    if (char === "," && depth === 0) {
      const value = current.trim();
      if (value) {
        parts.push(value);
      }
      current = "";
      continue;
    }

    current += char;

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if ((char === ")" || char === "]" || char === "}") && depth > 0) {
      depth -= 1;
    }
  }

  const finalValue = current.trim();
  if (finalValue) {
    parts.push(finalValue);
  }

  return parts;
}

export function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

export function memberAccessKey(access: MemberAccess): string {
  return `${access.line}:${access.startChar}:${access.memberText}`;
}

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}
