import {COLUMNS,createEmptyFields} from './core';
import {contractValuesFromTracking,emptyContractParty,validateContractValues} from './contract-core';
import {readExcelField,unwrapExcelCell} from './importer';
import type {ContractValues,ImportPreflightRow} from './contract-types';

export const CONTRACT_EXTRA_HEADERS=['Discloser Contact Name','Discloser Contact Designation','Discloser Contact Address','Recipient Contact Name','Recipient Contact Designation','Recipient Contact Address'];
export async function parseContractWorkbook(buffer:ArrayBuffer):Promise<ImportPreflightRow[]>{
  const module=await import('exceljs');const {Workbook}=module.default??module;
  const workbook=new Workbook();await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet=workbook.getWorksheet('NDA')??workbook.worksheets.find(s=>s.actualRowCount>0);
  if(!sheet)throw new Error('The workbook has no records.');
  let headerIndex=0;sheet.eachRow((row,index)=>{if(!headerIndex&&Array.isArray(row.values)&&row.values.some(v=>unwrapExcelCell(v).value!==null))headerIndex=index;});
  if(!headerIndex)throw new Error('The workbook has no headers.');
  const headers=new Map<string,number>();sheet.getRow(headerIndex).eachCell((cell,index)=>{
    const header=String(unwrapExcelCell(cell.value).value??'').replace(/^\uFEFF/,'').trim();if(!header)return;
    if(![...COLUMNS,...CONTRACT_EXTRA_HEADERS].includes(header))throw new Error(`Unknown header "${header}".`);
    if(headers.has(header))throw new Error(`Duplicate header "${header}".`);headers.set(header,index);
  });
  if(!headers.has('Recipient'))throw new Error('The Recipient header is required. Use the original NDA Excel columns.');
  const rows:ImportPreflightRow[]=[];
  sheet.eachRow((row,index)=>{
    if(index<=headerIndex||!Array.isArray(row.values)||!row.values.some(v=>unwrapExcelCell(v).value!==null))return;
    const fields=createEmptyFields();const errors:{field:string;message:string}[]=[];const warnings:{field:string;message:string}[]=[];
    for(const field of COLUMNS){const column=headers.get(field);if(!column)continue;const cell=readExcelField(row.getCell(column).value,field,!!workbook.properties.date1904);fields[field]=cell.value;if(cell.error)errors.push({field,message:cell.error});if(cell.warning)warnings.push({field,message:cell.warning});}
    fields['Expired on']=null;fields['Remaining Days']=null;
    if(fields.UOM&&String(fields.UOM).trim().toLowerCase()!=='years')errors.push({field:'UOM',message:'Unit must be years.'});
    // Imported rows keep their own party data; no sample people are filled into blank cells.
    const values=contractValuesFromTracking(fields,{discloser:emptyContractParty(),recipient:emptyContractParty(),purpose:'',agreementDate:null,duration:null,uom:'Years',pic:'',department:''} as ContractValues);
    for(const side of ['discloser','recipient'] as const){const prefix=side==='discloser'?'Discloser':'Recipient';for(const [label,key] of [['Name','name'],['Designation','designation'],['Address','address']] as const){const column=headers.get(`${prefix} Contact ${label}`);if(column){const result=unwrapExcelCell(row.getCell(column).value);values[side].contact[key]=String(result.value??'').trim();if(result.error)errors.push({field:`${prefix} Contact ${label}`,message:result.error});}}}
    const validation=validateContractValues(values,'draft');errors.push(...validation.errors);warnings.push(...validation.warnings);
    const ready=validateContractValues(values,'export');warnings.push(...ready.errors.map(issue=>({...issue,message:`Before generation: ${issue.message}`})));
    rows.push({rowNumber:index,values:validation.values,errors,warnings});
  });
  if(!rows.length)throw new Error('The workbook contains no data rows.');
  if(rows.length>1000)throw new Error('Import up to 1,000 drafts at a time. Generation batches are limited to 100.');
  return rows;
}
