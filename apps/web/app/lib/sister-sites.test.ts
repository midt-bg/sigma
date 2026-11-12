import { describe, expect, it } from 'vitest';
import { budgetUrl } from './sister-sites';

describe('budgetUrl', () => {
  it('leaves the links out while the setting is empty', () => {
    expect(budgetUrl(undefined)).toBeNull();
    expect(budgetUrl('')).toBeNull();
    expect(budgetUrl('   ')).toBeNull();
  });

  it('accepts an https address and drops the trailing slash of a bare origin', () => {
    expect(budgetUrl('https://budget.example.bg')).toBe('https://budget.example.bg');
    expect(budgetUrl(' https://budget.example.bg/ ')).toBe('https://budget.example.bg');
    expect(budgetUrl('https://example.bg/budget/')).toBe('https://example.bg/budget/');
  });

  it('refuses anything that is not a plain https address', () => {
    expect(budgetUrl('budget.example.bg')).toBeNull();
    expect(budgetUrl('http://budget.example.bg')).toBeNull();
    expect(budgetUrl('javascript:alert(1)')).toBeNull();
    expect(budgetUrl('https://user:secret@budget.example.bg')).toBeNull();
  });
});
