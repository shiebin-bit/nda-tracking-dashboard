import type { Fields } from './core.js';
import type {
  ContractParty,
  ContractValidationIssue,
  ContractValues,
} from './contract-types.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 10_000;

const emptyPerson = () => ({ name: '', designation: '' });
const emptyContact = () => ({ ...emptyPerson(), address: '', email: '' });

export function emptyContractParty(): ContractParty {
  return {
    name: '',
    registrationNumber: '',
    address: '',
    signatory: emptyPerson(),
    witness: emptyPerson(),
    contact: emptyContact(),
  };
}

export const FFM_DISCLOSER: ContractParty = {
  name: 'FFM BERHAD',
  registrationNumber: '196201000407 (4878-K)',
  address: 'PT 45125, Batu 15 ½, Sungai Pelong, 47000 Sungai Buloh, Selangor Darul Ehsan.',
  contact: {
    name: 'Liew Kok Wah',
    designation: 'Senior Manager, Group Feed Production',
    address: '2429 Mukim 1, Tingkat Perusahaan Dua Kawasan Perusahaan, 13600 Perai, Penang, Malaysia.',
    email: 'KOKWAH.LIEW@ffmb.com.my',
  },
  signatory: { name: 'Dr. Liew Kai Wah', designation: 'Group General Manager' },
  witness: { name: 'Mr. Liew Kok Wah', designation: 'Senior Manager, Group Feed Production' },
};

export function createFfmContractDefaults(): ContractValues {
  return {
    discloser: structuredClone(FFM_DISCLOSER),
    recipient: emptyContractParty(),
    purpose: '',
    agreementDate: null,
    duration: 3,
    uom: 'Years',
    pic: '',
    department: '',
  };
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

function nullableDate(value: unknown): string | null {
  const text = normalizedString(value);
  return text || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function partyFromUnknown(value: unknown): ContractParty {
  const party = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const signatory = party.signatory && typeof party.signatory === 'object' && !Array.isArray(party.signatory)
    ? party.signatory as Record<string, unknown> : {};
  const witness = party.witness && typeof party.witness === 'object' && !Array.isArray(party.witness)
    ? party.witness as Record<string, unknown> : {};
  const contact = party.contact && typeof party.contact === 'object' && !Array.isArray(party.contact)
    ? party.contact as Record<string, unknown> : {};
  return {
    name: normalizedString(party.name),
    registrationNumber: normalizedString(party.registrationNumber),
    address: normalizedString(party.address),
    signatory: { name: normalizedString(signatory.name), designation: normalizedString(signatory.designation) },
    witness: { name: normalizedString(witness.name), designation: normalizedString(witness.designation) },
    contact: {
      name: normalizedString(contact.name),
      designation: normalizedString(contact.designation),
      address: normalizedString(contact.address),
      email: normalizedString(contact.email),
    },
  };
}

export function normalizeContractValues(value: unknown): ContractValues {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    discloser: partyFromUnknown(input.discloser),
    recipient: partyFromUnknown(input.recipient),
    purpose: normalizedString(input.purpose),
    agreementDate: nullableDate(input.agreementDate),
    duration: numberOrNull(input.duration),
    uom: 'Years',
    pic: normalizedString(input.pic),
    department: normalizedString(input.department),
  };
}

function validIsoDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function visitText(values: ContractValues, visit: (path: string, value: string) => void): void {
  const visitParty = (prefix: string, party: ContractParty) => {
    visit(`${prefix}.name`, party.name);
    visit(`${prefix}.registrationNumber`, party.registrationNumber);
    visit(`${prefix}.address`, party.address);
    visit(`${prefix}.signatory.name`, party.signatory.name);
    visit(`${prefix}.signatory.designation`, party.signatory.designation);
    visit(`${prefix}.witness.name`, party.witness.name);
    visit(`${prefix}.witness.designation`, party.witness.designation);
    visit(`${prefix}.contact.name`, party.contact.name);
    visit(`${prefix}.contact.designation`, party.contact.designation);
    visit(`${prefix}.contact.address`, party.contact.address);
    visit(`${prefix}.contact.email`, party.contact.email);
  };
  visitParty('discloser', values.discloser);
  visitParty('recipient', values.recipient);
  visit('purpose', values.purpose);
  visit('pic', values.pic);
  visit('department', values.department);
}

export function validateContractValues(
  input: unknown,
  mode: 'draft' | 'export' = 'draft',
): { values: ContractValues; errors: ContractValidationIssue[]; warnings: ContractValidationIssue[] } {
  const values = normalizeContractValues(input);
  const errors: ContractValidationIssue[] = [];
  const warnings: ContractValidationIssue[] = [];
  visitText(values, (field, value) => {
    if (value.includes('\0')) errors.push({ field, message: 'Text must not contain NUL characters.' });
    if (value.length > MAX_TEXT) errors.push({ field, message: `Text must not exceed ${MAX_TEXT} characters.` });
  });
  if (values.agreementDate && !validIsoDate(values.agreementDate)) {
    errors.push({ field: 'agreementDate', message: 'Agreement date must be a valid ISO date.' });
  }
  for (const [field, email] of [
    ['discloser.contact.email', values.discloser.contact.email],
    ['recipient.contact.email', values.recipient.contact.email],
  ] as const) {
    if (email && !EMAIL_PATTERN.test(email)) errors.push({ field, message: 'Email address is invalid.' });
  }
  if (values.duration !== null && (!Number.isFinite(values.duration) || values.duration <= 0)) {
    errors.push({ field: 'duration', message: 'Duration must be a finite positive number of years.' });
  }
  if (mode === 'export') {
    for (const [field, value] of [
      ['discloser.name', values.discloser.name],
      ['discloser.registrationNumber', values.discloser.registrationNumber],
      ['discloser.address', values.discloser.address],
      ['recipient.name', values.recipient.name],
      ['recipient.registrationNumber', values.recipient.registrationNumber],
      ['recipient.address', values.recipient.address],
      ['purpose', values.purpose],
    ] as const) {
      if (!value) errors.push({ field, message: 'This field is required for document generation.' });
    }
    if (values.duration === null) {
      errors.push({ field: 'duration', message: 'Duration is required for document generation.' });
    }
  }
  return { values, errors, warnings };
}

export function contractValuesFromTracking(fields: Fields, base = createFfmContractDefaults()): ContractValues {
  const values = structuredClone(base);
  values.discloser.name = normalizedString(fields.Discloser);
  values.discloser.registrationNumber = normalizedString(fields['Discloser Reg No']);
  values.discloser.address = normalizedString(fields['Discloser Address']);
  values.discloser.signatory.name = normalizedString(fields['Name of Discloser']);
  values.discloser.signatory.designation = normalizedString(fields['Designation of Discloser']);
  values.discloser.witness.name = normalizedString(fields['Presence of Discloser Name']);
  values.discloser.witness.designation = normalizedString(fields['Presence of Discloser Designation']);
  values.discloser.contact.email = normalizedString(fields['Email Discloser']);
  values.recipient.name = normalizedString(fields.Recipient);
  values.recipient.registrationNumber = normalizedString(fields['Recipient Reg No']);
  values.recipient.address = normalizedString(fields['Recipient Address']);
  values.recipient.signatory.name = normalizedString(fields['Name of Recipient']);
  values.recipient.signatory.designation = normalizedString(fields['Designation of Recipient']);
  values.recipient.witness.name = normalizedString(fields['Presence of Recipient Name']);
  values.recipient.witness.designation = normalizedString(fields['Presence of Recipient Designation3']);
  values.recipient.contact.email = normalizedString(fields['Email Recipient']);
  values.purpose = normalizedString(fields.Purpose);
  values.agreementDate = nullableDate(fields['Date of Agreement']);
  values.duration = numberOrNull(fields.Duration);
  values.pic = normalizedString(fields.PIC);
  values.department = normalizedString(fields.Department);
  return values;
}

export function contractValuesToTracking(values: ContractValues): Fields {
  return {
    Discloser: values.discloser.name || null,
    'Discloser Reg No': values.discloser.registrationNumber || null,
    'Discloser Address': values.discloser.address || null,
    'Name of Discloser': values.discloser.signatory.name || null,
    'Designation of Discloser': values.discloser.signatory.designation || null,
    'Presence of Discloser Name': values.discloser.witness.name || null,
    'Presence of Discloser Designation': values.discloser.witness.designation || null,
    'Email Discloser': values.discloser.contact.email || null,
    Recipient: values.recipient.name || null,
    'Recipient Reg No': values.recipient.registrationNumber || null,
    'Recipient Address': values.recipient.address || null,
    'Name of Recipient': values.recipient.signatory.name || null,
    'Designation of Recipient': values.recipient.signatory.designation || null,
    'Presence of Recipient Name': values.recipient.witness.name || null,
    'Presence of Recipient Designation3': values.recipient.witness.designation || null,
    'Email Recipient': values.recipient.contact.email || null,
    Purpose: values.purpose || null,
    'Date of Agreement': values.agreementDate,
    Duration: values.duration,
    UOM: values.uom,
    PIC: values.pic || null,
    Department: values.department || null,
  };
}

const SMALL = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function integerWords(value: number): string {
  if (value < 20) return SMALL[value];
  if (value < 100) return `${TENS[Math.floor(value / 10)]}${value % 10 ? `-${SMALL[value % 10].toLowerCase()}` : ''}`;
  if (value < 1_000) return `${SMALL[Math.floor(value / 100)]} Hundred${value % 100 ? ` ${integerWords(value % 100)}` : ''}`;
  if (value < 1_000_000) return `${integerWords(Math.floor(value / 1_000))} Thousand${value % 1_000 ? ` ${integerWords(value % 1_000)}` : ''}`;
  return String(value);
}

export function durationText(duration: number | null): string {
  if (duration === null || !Number.isFinite(duration)) return '';
  const numeric = String(duration);
  const [whole, fraction] = numeric.split('.');
  const words = fraction
    ? `${integerWords(Number(whole))} Point ${[...fraction].map((digit) => SMALL[Number(digit)]).join(' ')}`
    : integerWords(Number(whole));
  return `${words} (${numeric}) ${duration === 1 ? 'year' : 'years'}`;
}

export function englishDate(value: string | null): string {
  if (!value || !validIsoDate(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

export function templateData(values: ContractValues): Record<string, string> {
  const side = (prefix: 'discloser' | 'recipient', party: ContractParty) => ({
    [`${prefix}_name`]: party.name,
    [`${prefix}_registration`]: party.registrationNumber,
    [`${prefix}_address`]: party.address,
    [`${prefix}_contact_name`]: party.contact.name,
    [`${prefix}_contact_designation`]: party.contact.designation,
    [`${prefix}_contact_address`]: party.contact.address,
    [`${prefix}_contact_email`]: party.contact.email,
    [`${prefix}_signatory_name`]: party.signatory.name,
    [`${prefix}_signatory_designation`]: party.signatory.designation,
    [`${prefix}_witness_name`]: party.witness.name,
    [`${prefix}_witness_designation`]: party.witness.designation,
  });
  return {
    ...side('discloser', values.discloser),
    ...side('recipient', values.recipient),
    purpose: values.purpose,
    agreement_date: englishDate(values.agreementDate),
    duration_text: durationText(values.duration),
  };
}
