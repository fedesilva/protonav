import * as vscode from "vscode";
import { ParsedProtoDocument } from "./protoTypes";
import { symbolKindForType } from "./symbolKind";

export function buildDocumentSymbols(parsed: ParsedProtoDocument): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  const nodesById = new Map<string, vscode.DocumentSymbol>();

  const sorted = [...parsed.symbols].sort((left, right) => {
    if (left.range.startLine !== right.range.startLine) {
      return left.range.startLine - right.range.startLine;
    }
    return left.range.startChar - right.range.startChar;
  });

  for (const symbol of sorted) {
    const node = new vscode.DocumentSymbol(
      symbol.name,
      symbol.fqName,
      symbolKindForType(symbol.type),
      new vscode.Range(
        symbol.range.startLine,
        symbol.range.startChar,
        symbol.range.endLine,
        symbol.range.endChar
      ),
      new vscode.Range(
        symbol.selectionRange.startLine,
        symbol.selectionRange.startChar,
        symbol.selectionRange.endLine,
        symbol.selectionRange.endChar
      )
    );

    nodesById.set(symbol.id, node);

    if (symbol.parentId) {
      const parent = nodesById.get(symbol.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }

    roots.push(node);
  }

  return roots;
}
