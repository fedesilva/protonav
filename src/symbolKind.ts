import * as vscode from "vscode";
import { ProtoSymbolType } from "./protoTypes";

export function symbolKindForType(type: ProtoSymbolType): vscode.SymbolKind {
  switch (type) {
    case "message":
      return vscode.SymbolKind.Class;
    case "enum":
      return vscode.SymbolKind.Enum;
    case "service":
      return vscode.SymbolKind.Interface;
    case "rpc":
      return vscode.SymbolKind.Method;
    default:
      return vscode.SymbolKind.Object;
  }
}
