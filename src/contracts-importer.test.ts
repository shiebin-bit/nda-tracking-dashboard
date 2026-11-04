import {describe,expect,it} from 'vitest';
import ExcelJS from 'exceljs';
import {parseContractWorkbook} from './contracts-importer';
async function book(headers:string[],rows:unknown[][]){const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('NDA');ws.addRow(headers);for(const row of rows)ws.addRow(row);return await wb.xlsx.writeBuffer() as ArrayBuffer;}
describe('contract Excel adapter',()=>{
  it('keeps company, contact, signer and witness separate with no sample defaults',async()=>{
    const data=await book(['Recipient','Recipient Reg No','Recipient Address','Name of Recipient','Presence of Recipient Name','Recipient Contact Name','Recipient Contact Address','Email Recipient','Duration','UOM'],[['Client','R-1','Company Road','Signer','Witness','Contact','Contact Road','contact@example.com',2.5,'years']]);
    const [row]=await parseContractWorkbook(data);expect(row.errors).toEqual([]);expect(row.values?.recipient).toMatchObject({name:'Client',address:'Company Road',signatory:{name:'Signer'},witness:{name:'Witness'},contact:{name:'Contact',address:'Contact Road',email:'contact@example.com'}});expect(row.values?.discloser.name).toBe('');expect(row.values?.duration).toBe(2.5);
  });
  it('allows partial drafts but warns about missing export details',async()=>{const [row]=await parseContractWorkbook(await book(['Recipient'],[['Draft client']]));expect(row.errors).toEqual([]);expect(row.values?.agreementDate).toBeNull();expect(row.warnings.some(w=>w.message.includes('Before generation'))).toBe(true);});
  it('rejects unsupported units instead of silently changing the contract term',async()=>{const [row]=await parseContractWorkbook(await book(['Recipient','UOM'],[['Client','months']]));expect(row.errors.some(e=>e.field==='UOM')).toBe(true);});
  it('does not evaluate formulas and reports impossible dates',async()=>{const [row]=await parseContractWorkbook(await book(['Recipient','Purpose','Date of Agreement'],[['Client',{formula:'1+1'},'31/02/2026']]));expect(row.errors.some(e=>e.field==='Date of Agreement')).toBe(true);expect(row.values?.purpose).toBe('');expect(row.warnings.some(w=>w.message.includes('not evaluated'))).toBe(true);});
  it('rejects ambiguous or unknown headers',async()=>{await expect(parseContractWorkbook(await book(['Recipient','Recipient'],[['A','B']]))).rejects.toThrow('Duplicate header');await expect(parseContractWorkbook(await book(['Recipient','Unknown'],[['A','B']]))).rejects.toThrow('Unknown header');});
});
