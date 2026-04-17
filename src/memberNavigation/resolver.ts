import { getMemberNavigationTranslator } from "./registry";
import { uniqueStrings } from "./shared";
import { MemberNavigationResolution, ProtoMemberLookup, SourceDocument, SourcePosition } from "./types";

export function resolveMemberNavigation(
  document: SourceDocument,
  position: SourcePosition,
  lookup: ProtoMemberLookup
): MemberNavigationResolution | undefined {
  const translator = getMemberNavigationTranslator(document.languageId);
  if (!translator) {
    return undefined;
  }

  const access = translator.detectMemberAccess(document, position);
  if (!access) {
    return undefined;
  }

  const receiverTypeTokens = uniqueStrings(translator.inferReceiverTypeTokens(document, position, access));
  if (receiverTypeTokens.length === 0) {
    return undefined;
  }

  const fieldNameCandidates = uniqueStrings(translator.normalizeFieldCandidates(access));
  if (fieldNameCandidates.length === 0) {
    return undefined;
  }

  const messageCandidates = dedupeByFqName(
    receiverTypeTokens.flatMap((typeToken) => lookup.findMessageTypes(typeToken))
  );
  if (messageCandidates.length === 0) {
    return undefined;
  }

  const matches = dedupeByKey(lookup.findFields(messageCandidates.map((candidate) => candidate.fqName), fieldNameCandidates));
  if (matches.length !== 1) {
    return undefined;
  }

  return {
    access,
    receiverTypeTokens,
    fieldNameCandidates,
    matches
  };
}

function dedupeByFqName<T extends { fqName: string }>(values: T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!result.has(value.fqName)) {
      result.set(value.fqName, value);
    }
  }
  return [...result.values()];
}

function dedupeByKey<T extends { key: string }>(values: T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!result.has(value.key)) {
      result.set(value.key, value);
    }
  }
  return [...result.values()];
}
