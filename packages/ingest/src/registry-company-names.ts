import type { RegistryDeed, RegistryField } from './registry';

const FORMS: Record<string, string> = {
  'Дружество с ограничена отговорност': 'ООД',
  'Еднолично дружество с ограничена отговорност': 'ЕООД',
  'Акционерно дружество': 'АД',
  'Еднолично акционерно дружество': 'ЕАД',
  'Едноличен търговец': 'ЕТ',
  'Събирателно дружество': 'СД',
  'Командитно дружество': 'КД',
  'Командитно дружество с акции': 'КДА',
};
export interface RegistryCompanyName {
  name: string;
  legalForm: string;
  from: string;
  until: string | null;
  subUic: string;
  nameEntry: string;
  formEntry: string;
}
const value = (f: RegistryField, key: string): string => {
  const v = f.value as Record<string, unknown> | null;
  return f.operation === 'Add' && typeof v?.[key] === 'string' ? v[key].trim() : '';
};

/** Only name/form pairs that actually coexisted in the main partida. No cross-product of history. */
export function companyNamesFromDeed(partida: RegistryDeed): RegistryCompanyName[] {
  const result: RegistryCompanyName[] = [];
  for (const sub of partida.deed.subDeeds) {
    if (sub.subUicType !== 'MainCircumstances') continue;
    const entries = new Map<string, RegistryField[]>();
    let invalid = false;
    for (const f of sub.fields) {
      if (!['00020', '00030'].includes(f.fieldIdent)) continue;
      if (!f.entryNumber || !/^\d{4}-\d{2}-\d{2}T/.test(f.entryDate)) {
        invalid = true;
        break;
      }
      const key = `${f.entryDate}|${f.entryNumber}`;
      entries.set(key, [...(entries.get(key) ?? []), f]);
    }
    if (invalid) continue;
    // Conflicting observations for one field/entry cannot establish a name history.
    if ([...entries.values()].some((fs) => new Set(fs.map((f) => f.fieldIdent)).size !== fs.length))
      continue;
    let name: RegistryField | undefined, form: RegistryField | undefined;
    let previous: RegistryCompanyName | undefined;
    for (const [, fields] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      const at = fields[0]!.entryDate;
      if (previous) previous.until = at;
      previous = undefined;
      for (const f of fields) {
        if (f.fieldIdent === '00020') name = f;
        else form = f;
      }
      const n = name ? value(name, '$text') : '';
      const legalForm = form ? FORMS[value(form, 'Text')] : undefined;
      if (!n || !legalForm) continue;
      previous = {
        name: n,
        legalForm,
        from: at,
        until: null,
        subUic: sub.subUic,
        nameEntry: name!.entryNumber,
        formEntry: form!.entryNumber,
      };
      result.push(previous);
    }
  }
  return result;
}
