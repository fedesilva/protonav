export interface SourcePosition {
  line: number;
  character: number;
}

export interface SourceDocument {
  languageId: string;
  text: string;
  lines: string[];
}

export interface MemberAccess {
  receiverText: string;
  memberText: string;
  syntax: "go-field" | "go-getter" | "python-attribute";
  line: number;
  startChar: number;
  endChar: number;
}

export interface MemberNavigationTranslator {
  readonly languageId: string;
  detectMemberAccess(document: SourceDocument, position: SourcePosition): MemberAccess | undefined;
  inferReceiverTypeTokens(document: SourceDocument, position: SourcePosition, access: MemberAccess): string[];
  normalizeFieldCandidates(access: MemberAccess): string[];
}

export interface ResolvedProtoMessageCandidate {
  fqName: string;
  data?: unknown;
}

export interface ResolvedProtoFieldCandidate {
  key: string;
  messageFqName: string;
  fieldName: string;
  data?: unknown;
}

export interface ProtoMemberLookup {
  findMessageTypes(typeToken: string): ResolvedProtoMessageCandidate[];
  findFields(messageFqNames: string[], fieldNames: string[]): ResolvedProtoFieldCandidate[];
}

export interface MemberNavigationResolution {
  access: MemberAccess;
  receiverTypeTokens: string[];
  fieldNameCandidates: string[];
  matches: ResolvedProtoFieldCandidate[];
}
