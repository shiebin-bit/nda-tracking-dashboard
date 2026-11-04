import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseWorkbook } from '../src/importer.js';
import { createPool, migrate } from './db.js';
import { PgNdaStore } from './store.js';

const { values } = parseArgs({ options: { file: { type:'string' }, 'accept-warnings': { type:'boolean', default:false } } });
if (!values.file) throw new Error('Usage: npm run db:import-xlsx -- --file /tmp/nda.xlsx --accept-warnings');
const pool=createPool();
try{
  await migrate(pool); const store=new PgNdaStore(pool); const current=await store.state();
  if(current.snapshot.records.length||current.snapshot.history.length)throw new Error('Initial Excel import requires an empty database.');
  const buffer=await readFile(values.file); const data=buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength) as ArrayBuffer;
  const parsed=await parseWorkbook(data,[]);
  if(parsed.sheetName!=='NDA')throw new Error(`Expected worksheet NDA, found ${parsed.sheetName}.`);
  if(parsed.rows.length!==11)throw new Error(`Expected exactly 11 Excel rows, found ${parsed.rows.length}.`);
  const errors=parsed.rows.flatMap(row=>row.errors.map(error=>`Row ${row.index}: ${error}`));
  if(errors.length)throw new Error(`Excel import has errors:\n${errors.join('\n')}`);
  const warnings=parsed.rows.flatMap(row=>row.warnings.map(warning=>`Row ${row.index}: ${warning}`));
  if(warnings.length&&!values['accept-warnings'])throw new Error(`Excel import has warnings; review them, then pass --accept-warnings:\n${warnings.join('\n')}`);
  const result=await store.importRows({rows:parsed.rows.map(row=>row.fields)},true);
  if(result.snapshot.records.length!==11)throw new Error('Import did not persist all 11 records.');
  console.log(`Imported ${result.snapshot.records.length} NDA records from worksheet ${parsed.sheetName}.`);
}finally{await pool.end();}
