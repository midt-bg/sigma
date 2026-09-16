// The Trade Register's roles in words (ADR-0039): the full name a table and a sentence use, and the short one
// written on an edge of the tie graph.
import type { CompanyTieEdge, RegistryRoleKind } from '@sigma/api-contract';

export const ROLE_LABEL: Record<RegistryRoleKind, string> = {
  manager: 'управител',
  representative: 'представител',
  chair: 'председател',
  board_of_directors: 'член на съвета на директорите',
  management_board: 'член на управителния съвет',
  governing_body: 'член на органа на управление',
  board_of_trustees: 'член на настоятелството',
  supervisory_board: 'член на надзорния съвет',
  controlling_board: 'член на контролния съвет',
  verification_commission: 'член на проверителната комисия',
  partner: 'съдружник',
  sole_owner: 'едноличен собственик на капитала',
  trader: 'едноличен търговец',
  procurator: 'прокурист',
  branch_manager: 'управител на клон',
  liquidator: 'ликвидатор',
  trustee: 'синдик',
  beneficial_owner: 'действителен собственик',
};

const ROLE_SHORT: Record<RegistryRoleKind, string> = {
  ...ROLE_LABEL,
  board_of_directors: 'СД',
  management_board: 'УС',
  supervisory_board: 'НС',
  controlling_board: 'КС',
  governing_body: 'орган на управление',
  board_of_trustees: 'настоятелство',
  verification_commission: 'проверителна комисия',
  sole_owner: 'едноличен собственик',
  trader: 'ЕТ',
};

/** „a", „a и b", „a, b и c". */
export function joinWords(words: string[]): string {
  if (words.length < 2) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} и ${words[words.length - 1]}`;
}

type RoleTie = Pick<CompanyTieEdge, 'roles' | 'current'>;

/** A role tie in words: „управител и съдружник", „бивш управител". */
export function roleSentence(e: RoleTie): string {
  const words = joinWords((e.roles ?? []).map((r) => ROLE_LABEL[r]));
  return e.current === false ? `бивш ${words}` : words;
}

/** A role tie as written on its edge: short, and no more than two roles before a count. */
export function roleEdgeText(e: RoleTie): string {
  const short = (e.roles ?? []).map((r) => ROLE_SHORT[r]);
  const words =
    short.length > 2 ? `${short.slice(0, 2).join(', ')} +${short.length - 2}` : joinWords(short);
  return e.current === false ? `бивш ${words}` : words;
}
