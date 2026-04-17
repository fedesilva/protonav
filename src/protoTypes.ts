export type ProtoSymbolType = "message" | "enum" | "service" | "rpc";

export interface TextRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface ParsedProtoSymbol {
  id: string;
  parentId?: string;
  name: string;
  shortName: string;
  fqName: string;
  type: ProtoSymbolType;
  packageName: string;
  scopePath: string[];
  containerName?: string;
  range: TextRange;
  selectionRange: TextRange;
}

export interface ParsedProtoDocument {
  filePath: string;
  packageName: string;
  imports: string[];
  symbols: ParsedProtoSymbol[];
}
