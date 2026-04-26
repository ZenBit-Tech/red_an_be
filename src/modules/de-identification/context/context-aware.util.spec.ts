import { contextAwareAnonymize, PhiType } from './context-aware.util';

describe('contextAwareAnonymize', () => {
  it('should keep Gender field value as non-PHI', () => {
    const text = 'Gender: Female';
    const femaleStart = text.indexOf('Female');

    const anonymized = contextAwareAnonymize(text, [
      {
        type: PhiType.NAME,
        value: 'Female',
        start: femaleStart,
        end: femaleStart + 'Female'.length,
      },
    ]);

    expect(anonymized).toBe('Gender: Female');
  });

  it('should fully redact address including apartment/unit suffix', () => {
    const text = 'Address: 567 Maple Ave, Apt 3B';
    const addressValue = '567 Maple Ave, Apt 3B';
    const addressStart = text.indexOf(addressValue);

    const anonymized = contextAwareAnonymize(text, [
      {
        type: PhiType.ADDRESS,
        value: addressValue,
        start: addressStart,
        end: addressStart + addressValue.length,
      },
    ]);

    expect(anonymized).toBe('Address: [ADDRESS]');
  });

  it('should not mix gender and address segments when a raw span crosses field boundary', () => {
    const text = 'Gender: Female Address: 567 Maple Ave, Apt 3B';
    const femaleStart = text.indexOf('Female');
    const addressMarkerStart = text.indexOf('Address:');
    const addressValue = '567 Maple Ave, Apt 3B';
    const addressStart = text.indexOf(addressValue);

    const anonymized = contextAwareAnonymize(text, [
      {
        // Simulates an over-extended detector span that starts at "Female"
        // and incorrectly swallows part of the Address field.
        type: PhiType.NAME,
        value: text.slice(femaleStart, addressStart + '567 Maple Ave'.length),
        start: femaleStart,
        end: addressStart + '567 Maple Ave'.length,
      },
      {
        type: PhiType.ADDRESS,
        value: addressValue,
        start: addressStart,
        end: addressStart + addressValue.length,
      },
    ]);

    expect(addressMarkerStart).toBeGreaterThan(femaleStart);
    expect(anonymized).toBe('Gender: Female Address: [ADDRESS]');
  });
});
