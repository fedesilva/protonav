import { goMemberNavigationTranslator } from "./goTranslator";
import { pythonMemberNavigationTranslator } from "./pythonTranslator";
import { MemberNavigationTranslator } from "./types";

const TRANSLATORS = new Map<string, MemberNavigationTranslator>([
  [goMemberNavigationTranslator.languageId, goMemberNavigationTranslator],
  [pythonMemberNavigationTranslator.languageId, pythonMemberNavigationTranslator]
]);

export function getMemberNavigationTranslator(languageId: string): MemberNavigationTranslator | undefined {
  return TRANSLATORS.get(languageId);
}
