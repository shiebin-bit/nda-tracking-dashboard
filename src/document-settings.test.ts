import {describe,expect,it} from 'vitest';
import {
  formatDocumentFilename,
  parseDocumentNamingSettings,
  sanitizeDocumentFilenamePart,
} from './document-settings';

describe('document filename settings',()=>{
  it('accepts any ordered unique subset, including an empty selection',()=>{
    expect(parseDocumentNamingSettings({filenameFields:[]})).toEqual({filenameFields:[]});
    expect(parseDocumentNamingSettings({filenameFields:['project','type']})).toEqual({filenameFields:['project','type']});
    expect(()=>parseDocumentNamingSettings({filenameFields:['type','type']})).toThrow(/duplicates/);
    expect(()=>parseDocumentNamingSettings({filenameFields:['unknown']})).toThrow(/unsupported/);
  });

  it('keeps Unicode but removes Windows-unsafe paths, controls and reserved names',()=>{
    expect(sanitizeDocumentFilenamePart('  项目 / Client\u0000  ')).toBe('项目 Client');
    expect(sanitizeDocumentFilenamePart('CON')).toBe('_CON');
    expect(sanitizeDocumentFilenamePart('name... ')).toBe('name');
  });

  it('orders optional fields and always retains the reference, version and extension suffix',()=>{
    const name=formatDocumentFilename({
      type:'nda',supplier:'Supplier / Asia',project:'项目 Alpha',date:'2026-11-24',
      reference:'DOC-000123',ordinal:7,extension:'docx',
    },['project','type','supplier']);
    expect(name).toBe('项目 Alpha_NDA_Supplier Asia_DOC-000123_v7.docx');
    expect(formatDocumentFilename({type:'nda',supplier:'',project:'',date:'',reference:'DOC-1',ordinal:1,extension:'pdf'},[]))
      .toBe('DOC-1_v1.pdf');
  });

  it('limits UTF-8 filename bytes without splitting Unicode characters or its fixed suffix',()=>{
    const name=formatDocumentFilename({type:'nda',supplier:'界'.repeat(200),project:'',date:'',reference:'DOC-9',ordinal:2,extension:'pdf'},['supplier']);
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(240);
    expect(name.endsWith('_DOC-9_v2.pdf')).toBe(true);
    expect(name).not.toContain('\ufffd');
  });
});
