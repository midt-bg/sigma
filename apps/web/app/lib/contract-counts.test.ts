import { describe, expect, it } from 'vitest';
import { contractCountNote, listedContracts } from './contract-counts';

// A profile's „Брой договори" counts the summed contracts; its contracts list also has the framework
// agreements (a ceiling, never summed) and the contracts with no value. The note reconciles the two.
describe('listedContracts / contractCountNote', () => {
  it('is silent when every listed contract is summed', () => {
    const c = { contracts: 12, missingValue: 0, frameworkAgreements: 0 };
    expect(listedContracts(c)).toBe(12);
    expect(contractCountNote(c)).toBeUndefined();
  });

  it('names the framework agreements the count leaves out', () => {
    const c = { contracts: 40, missingValue: 0, frameworkAgreements: 4 };
    expect(listedContracts(c)).toBe(44);
    expect(contractCountNote(c)).toBe('със стойност; в списъка са 44 — и 4 рамкови споразумения');
  });

  it('uses the singular for one agreement', () => {
    expect(contractCountNote({ contracts: 5, missingValue: 0, frameworkAgreements: 1 })).toBe(
      'със стойност; в списъка са 6 — и 1 рамково споразумение',
    );
  });

  it('names the contracts without a value, alone or beside the agreements', () => {
    expect(contractCountNote({ contracts: 5, missingValue: 2, frameworkAgreements: 0 })).toBe(
      'със стойност; в списъка са 7 — и 2 без стойност',
    );
    expect(contractCountNote({ contracts: 5, missingValue: 2, frameworkAgreements: 3 })).toBe(
      'със стойност; в списъка са 10 — и 3 рамкови споразумения и 2 без стойност',
    );
  });
});
