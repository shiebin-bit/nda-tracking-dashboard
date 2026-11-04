import { describe, expect, it } from 'vitest';
import {
  FFM_DISCLOSER,
  contractValuesFromTracking,
  contractValuesToTracking,
  createFfmContractDefaults,
  durationText,
  englishDate,
  templateData,
  validateContractValues,
} from './contract-core';
import { createEmptyFields } from './core';

describe('contract core', () => {
  it('creates the approved FFM-first draft without sharing mutable defaults', () => {
    const first = createFfmContractDefaults();
    const second = createFfmContractDefaults();
    expect(first).toMatchObject({
      discloser: FFM_DISCLOSER,
      recipient: { name: '', registrationNumber: '', address: '' },
      purpose: '', agreementDate: null, duration: 3, uom: 'Years', pic: '', department: '',
    });
    first.discloser.name = 'Changed';
    expect(second.discloser.name).toBe('FFM BERHAD');
  });

  it('maps signatories, witnesses and legacy email columns without leaking contract-only contacts', () => {
    const fields = {
      ...createEmptyFields(),
      Discloser: 'Alpha', 'Discloser Reg No': 'A-1', 'Discloser Address': 'Alpha address',
      'Name of Discloser': 'Alpha signer', 'Designation of Discloser': 'Director',
      'Presence of Discloser Name': 'Alpha witness', 'Presence of Discloser Designation': 'Manager',
      'Email Discloser': 'alpha@example.test', Recipient: 'Beta', 'Recipient Reg No': 'B-2',
      'Recipient Address': 'Beta address', 'Name of Recipient': 'Beta signer',
      'Designation of Recipient': 'Director', 'Presence of Recipient Name': 'Beta witness',
      'Presence of Recipient Designation3': 'Manager', 'Email Recipient': 'beta@example.test',
      Purpose: 'Evaluation', 'Date of Agreement': '2026-10-22', Duration: 1.5, PIC: 'Lee', Department: 'Legal',
    };
    const base = createFfmContractDefaults();
    base.discloser.contact.name = 'Contract-only contact';
    const values = contractValuesFromTracking(fields, base);
    expect(values.discloser).toMatchObject({
      signatory: { name: 'Alpha signer', designation: 'Director' },
      witness: { name: 'Alpha witness', designation: 'Manager' },
      contact: { name: 'Contract-only contact', email: 'alpha@example.test' },
    });
    const mapped = contractValuesToTracking(values);
    expect(mapped).not.toHaveProperty('Discloser Contact Name');
    expect(mapped).toMatchObject({
      'Name of Discloser': 'Alpha signer',
      'Presence of Discloser Name': 'Alpha witness',
      'Email Discloser': 'alpha@example.test',
      Duration: 1.5,
    });
  });

  it('allows optional people and date for export while requiring legal party data, purpose and duration', () => {
    const values = createFfmContractDefaults();
    values.recipient = {
      name: 'Client Sdn. Bhd.', registrationNumber: '202601000001', address: 'Kuala Lumpur',
      signatory: { name: '', designation: '' }, witness: { name: '', designation: '' },
      contact: { name: '', designation: '', address: '', email: '' },
    };
    values.purpose = 'A legitimate Her Yi project';
    expect(validateContractValues(values, 'export').errors).toEqual([]);
    values.duration = 0;
    expect(validateContractValues(values, 'export').errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'duration' }),
    ]));
  });

  it('formats English date and integer or decimal year duration for the template', () => {
    expect(englishDate('2026-10-22')).toBe('22 October 2026');
    expect(durationText(3)).toBe('Three (3) years');
    expect(durationText(1)).toBe('One (1) year');
    expect(durationText(1.5)).toBe('One Point Five (1.5) years');
    const values = createFfmContractDefaults();
    values.agreementDate = '2026-10-22';
    expect(templateData(values)).toMatchObject({
      discloser_name: 'FFM BERHAD', agreement_date: '22 October 2026', duration_text: 'Three (3) years',
    });
    expect(Object.keys(templateData(values))).toHaveLength(25);
  });
});
