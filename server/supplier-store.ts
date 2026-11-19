import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Project, ProjectStatus, Supplier, SupplierAssignmentInput, SupplierAssignmentItem, SupplierAssignmentResult, SupplierDetails } from '../src/supplier-types.js';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './db.js';
import { isPlainObject } from './domain.js';
import { assertExpectedVersion } from './domain.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.includes('\0')) throw badRequest(`${label} must be text without NUL characters.`);
  const normalized = value.normalize('NFC').trim();
  if (required && !normalized) throw badRequest(`${label} is required.`);
  if (normalized.length > maximum) throw badRequest(`${label} must contain at most ${maximum} characters.`);
  return normalized;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return text(value, label, maximum);
}

function iso(value: string|Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

function supplierInput(value: unknown) {
  if (!isPlainObject(value)) throw badRequest('Request body must be an object.');
  const contact = isPlainObject(value.contact) ? value.contact : {};
  const email = text(contact.email ?? '', 'Contact email', 500);
  if (email && !EMAIL_PATTERN.test(email)) throw badRequest('Contact email must be a valid email address.');
  return {
    supplierCode: text(value.supplierCode, 'Supplier ID', 100, true),
    companyName: text(value.companyName, 'Company name', 500, true),
    registrationNumber: text(value.registrationNumber ?? '', 'Registration number', 500),
    address: text(value.address ?? '', 'Address', 10_000),
    contact: {
      name: text(contact.name ?? '', 'Contact name', 500),
      designation: text(contact.designation ?? '', 'Contact designation', 500),
      address: text(contact.address ?? '', 'Contact address', 10_000),
      email,
    },
  };
}

function projectInput(value: unknown) {
  if (!isPlainObject(value)) throw badRequest('Request body must be an object.');
  const status = value.status ?? 'active';
  if (status !== 'active' && status !== 'archived') throw badRequest('Project status must be active or archived.');
  return {
    projectCode: nullableText(value.projectCode, 'Project code', 100),
    name: text(value.name, 'Project name', 500, true),
    description: text(value.description ?? '', 'Project description', 10_000),
    status: status as ProjectStatus,
  };
}

function mapSupplier(row: Record<string, any>): Supplier {
  return { id:row.id, supplierCode:row.supplier_code, companyName:row.company_name,
    registrationNumber:row.registration_number, address:row.address,
    contact:{name:row.contact_name,designation:row.contact_designation,address:row.contact_address,email:row.contact_email},
    version:row.version,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at) };
}

function mapProject(row: Record<string, any>): Project {
  return { id:row.id,projectCode:row.project_code,name:row.name,description:row.description,status:row.status,
    version:row.version,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at) };
}

function assignmentItems(value: unknown, label: string): SupplierAssignmentItem[] {
  if (!Array.isArray(value)) throw badRequest(`${label} must be an array.`);
  if (value.length > 100) throw badRequest(`${label} can contain at most 100 items.`);
  const seen = new Set<string>();
  return value.map((entry,index) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.includes('\0') || entry.id.length > 200) {
      throw badRequest(`${label} item ${index + 1} has an invalid ID.`);
    }
    const id = entry.id.trim();
    if (seen.has(id)) throw badRequest(`${label} contains duplicate ID ${id}.`);
    seen.add(id);
    return {id,expectedVersion:assertExpectedVersion(entry.expectedVersion)};
  });
}

function assignmentInput(value: unknown): SupplierAssignmentInput {
  if (!isPlainObject(value)) throw badRequest('Request body must be an object.');
  const agreements=assignmentItems(value.agreements,'agreements');
  const documents=assignmentItems(value.documents,'documents');
  if (!agreements.length && !documents.length) throw badRequest('Select at least one agreement or document.');
  return {agreements,documents};
}

function uniqueError(error: unknown, label: string): never {
  if (typeof error === 'object' && error && (error as {code?:string}).code === '23505') {
    throw conflict(`${label} is already in use.`, 'duplicate_code');
  }
  throw error;
}

async function requireSupplier(client: PoolClient, id: string, lock = false): Promise<Record<string, any>> {
  const result=await client.query(`SELECT * FROM supplier WHERE id=$1 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[id]);
  if(!result.rows[0]) throw notFound('Supplier was not found.');
  return result.rows[0];
}

async function supplierDetails(client: PoolClient, id:string): Promise<SupplierDetails> {
  const base=mapSupplier(await requireSupplier(client,id));
  const agreements=await client.query(`SELECT id,reference_code,version,fields->>'Recipient' recipient,fields->>'Status' status
    FROM nda_record WHERE supplier_id=$1 AND deleted_at IS NULL ORDER BY position`,[id]);
  const documents=await client.query(`SELECT id,reference_code,version,COALESCE(document_type,'nda') document_type,
      values->'recipient'->>'name' recipient,linked_nda_id,project_id,status,updated_at
    FROM contract WHERE supplier_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id`,[id]);
  return {...base,
    agreements:agreements.rows.map(row=>({id:row.id,reference:row.reference_code,version:row.version,recipient:row.recipient??'',status:row.status??''})),
    documents:documents.rows.map(row=>({id:row.id,reference:row.reference_code,version:row.version,documentType:row.document_type,
      recipient:row.recipient??'',linkedNdaId:row.linked_nda_id??null,projectId:row.project_id??null,status:row.status,updatedAt:iso(row.updated_at)}))};
}

export class PgSupplierStore {
  constructor(private readonly pool: Pool) {}

  async listSuppliers(): Promise<Supplier[]> {
    const result=await this.pool.query('SELECT * FROM supplier WHERE deleted_at IS NULL ORDER BY lower(company_name),lower(supplier_code),id');
    return result.rows.map(mapSupplier);
  }

  async supplier(id:string): Promise<SupplierDetails> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await supplierDetails(client,id);
      await client.query('COMMIT');
      return result;
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }


  async assignItems(id:string,input:unknown): Promise<SupplierAssignmentResult> {
    const value=assignmentInput(input);
    return withTransaction(this.pool,async client=>{
      // Check existence before taking resource locks, then lock the row after all
      // contract/register locks have been acquired in their canonical order.
      await requireSupplier(client,id);
      const agreementVersions=new Map(value.agreements.map(item=>[item.id,item.expectedVersion]));
      const documentVersions=new Map(value.documents.map(item=>[item.id,item.expectedVersion]));
      const documentIds=[...documentVersions.keys()].sort();
      const agreementIds=[...agreementVersions.keys()].sort();

      // Keep the same lock order as contract confirmation (workspace -> contract -> NDA).
      // This prevents an assignment and a simultaneous signature confirmation from
      // deadlocking while still serializing the register revision/history positions.
      let revision=(await client.query<{revision:string}>(agreementIds.length
        ? 'SELECT revision::text FROM workspace WHERE id=1 FOR UPDATE'
        : 'SELECT revision::text FROM workspace WHERE id=1')).rows[0].revision;
      const lockedDocuments=documentIds.length||agreementIds.length ? (await client.query(`SELECT * FROM contract
        WHERE id::text=ANY($1::text[]) OR (linked_nda_id::text=ANY($2::text[]) AND deleted_at IS NULL)
        ORDER BY id FOR UPDATE`,[documentIds,agreementIds])).rows : [];
      const documents=lockedDocuments.filter(row=>documentVersions.has(row.id));
      if(documents.length!==documentIds.length)throw notFound('One or more selected documents were not found.');
      for(const row of documents){
        if(row.deleted_at)throw conflict('A selected document is in the Recycle Bin.','document_recycled');
        // A response-lost retry may carry the previous version after this exact
        // assignment already committed. If the desired supplier is already set,
        // accepting it as a no-op is safe and avoids another version increment.
        if(row.version!==documentVersions.get(row.id)&&row.supplier_id!==id)throw conflict('A selected document changed in another session. Reload and try again.','version_conflict');
      }

      const relatedAgreementIds=[...new Set([...agreementIds,...documents.flatMap(row=>row.linked_nda_id?[row.linked_nda_id]:[])])].sort();
      const lockedAgreements=relatedAgreementIds.length ? (await client.query(`SELECT n.*,
          (SELECT supplier_code FROM supplier current_supplier WHERE current_supplier.id=n.supplier_id) supplier_code
        FROM nda_record n WHERE n.id::text=ANY($1::text[]) ORDER BY n.id FOR UPDATE`,[relatedAgreementIds])).rows : [];
      const agreements=lockedAgreements.filter(row=>agreementVersions.has(row.id));
      if(agreements.length!==agreementIds.length)throw notFound('One or more selected agreements were not found.');
      for(const row of agreements){
        if(row.deleted_at)throw conflict('A selected agreement is in the Recycle Bin.','record_recycled');
        if(row.version!==agreementVersions.get(row.id)&&row.supplier_id!==id)throw conflict('A selected agreement changed in another session. Reload and try again.','version_conflict');
      }

      const missingAgreementIds=documents.flatMap(row=>{
        if(!row.linked_nda_id||agreementVersions.has(row.linked_nda_id))return [];
        const related=lockedAgreements.find(candidate=>candidate.id===row.linked_nda_id);
        return related&&!related.deleted_at&&related.supplier_id!==id?[related.id]:[];
      });
      const missingDocuments=lockedDocuments.filter(row=>row.linked_nda_id&&agreementVersions.has(row.linked_nda_id)
        &&!row.deleted_at&&row.supplier_id!==id&&!documentVersions.has(row.id));
      if(missingAgreementIds.length||missingDocuments.length){
        const error=conflict('Include every active related agreement and document that would otherwise remain assigned to another supplier.','related_items_required');
        error.details={
          agreementIds:[...new Set(missingAgreementIds)].sort(),
          documentIds:[...new Set(missingDocuments.map(row=>row.id))].sort(),
        };
        throw error;
      }

      // The supplier is locked after the associated resources so other supplier-only
      // edits cannot create a lock-order cycle with contract/register operations.
      const target=await requireSupplier(client,id,true);

      const now=new Date().toISOString();let agreementsChanged=0;let documentsChanged=0;
      let historyPosition=agreementIds.length ? Number((await client.query('SELECT COALESCE(max(position),0)::text position FROM history_event')).rows[0].position)+1 : 0;
      for(const row of agreements){
        if(row.supplier_id===id)continue;
        await client.query('UPDATE nda_record SET supplier_id=$2,version=version+1,updated_at=$3 WHERE id=$1',[row.id,id,now]);
        await client.query(`INSERT INTO history_event(id,position,nda_id,type,timestamp,actor,summary,changes)
          VALUES($1,$2,$3,'supplier-linked',$4,'Local user','Assigned NDA record to supplier.',$5::jsonb)`,
        [randomUUID(),historyPosition++,row.id,now,JSON.stringify([
          {field:'Supplier ID',before:row.supplier_code??null,after:target.supplier_code},
          {field:'Version',before:row.version,after:row.version+1},
        ])]);agreementsChanged++;
      }
      for(const row of documents){
        if(row.supplier_id===id)continue;
        await client.query('UPDATE contract SET supplier_id=$2,version=version+1,updated_at=$3 WHERE id=$1',[row.id,id,now]);
        await client.query(`INSERT INTO contract_activity(id,contract_id,type,actor,details,created_at)
          VALUES($1,$2,'supplier-assigned','Local user',$3::jsonb,$4)`,
        [randomUUID(),row.id,JSON.stringify({beforeSupplierId:row.supplier_id??null,supplierId:id,supplierCode:target.supplier_code}),now]);documentsChanged++;
      }
      if(agreementsChanged)revision=(await client.query<{revision:string}>('UPDATE workspace SET revision=revision+1 WHERE id=1 RETURNING revision::text')).rows[0].revision;
      return {supplier:await supplierDetails(client,id),revision,agreementsChanged,documentsChanged};
    });
  }

  async createSupplier(input:unknown): Promise<Supplier> {
    const value=supplierInput(input); const now=new Date().toISOString(); const id=randomUUID();
    try { const result=await this.pool.query(`INSERT INTO supplier(id,supplier_code,company_name,registration_number,address,
      contact_name,contact_designation,contact_address,contact_email,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,[id,value.supplierCode,value.companyName,value.registrationNumber,
      value.address,value.contact.name,value.contact.designation,value.contact.address,value.contact.email,now]); return mapSupplier(result.rows[0]); }
    catch(error){ uniqueError(error,'Supplier ID'); }
  }

  async updateSupplier(id:string,input:unknown): Promise<Supplier> {
    if(!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const expected=assertExpectedVersion(input.expectedVersion); const value=supplierInput(input); const now=new Date().toISOString();
    try { return await withTransaction(this.pool,async client=>{const current=await requireSupplier(client,id,true);
      if(current.version!==expected)throw conflict('This supplier was changed by another session. Reload and try again.','version_conflict');
      const result=await client.query(`UPDATE supplier SET supplier_code=$2,company_name=$3,registration_number=$4,address=$5,
        contact_name=$6,contact_designation=$7,contact_address=$8,contact_email=$9,version=version+1,updated_at=$10 WHERE id=$1 RETURNING *`,
      [id,value.supplierCode,value.companyName,value.registrationNumber,value.address,value.contact.name,value.contact.designation,value.contact.address,value.contact.email,now]);
      return mapSupplier(result.rows[0]);}); } catch(error){ uniqueError(error,'Supplier ID'); }
  }

  async listProjects(): Promise<Project[]> {
    const result=await this.pool.query('SELECT * FROM project WHERE deleted_at IS NULL ORDER BY status,lower(name),id');
    return result.rows.map(mapProject);
  }

  async createProject(input:unknown): Promise<Project> {
    const value=projectInput(input);const id=randomUUID();const now=new Date().toISOString();
    try {const result=await this.pool.query(`INSERT INTO project(id,project_code,name,description,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,[id,value.projectCode,value.name,value.description,value.status,now]);return mapProject(result.rows[0]);}
    catch(error){uniqueError(error,'Project code');}
  }

  async updateProject(id:string,input:unknown): Promise<Project> {
    if(!isPlainObject(input))throw badRequest('Request body must be an object.');
    const expected=assertExpectedVersion(input.expectedVersion);const value=projectInput(input);const now=new Date().toISOString();
    try{return await withTransaction(this.pool,async client=>{const current=await client.query('SELECT * FROM project WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
      if(!current.rows[0])throw notFound('Project was not found.');
      if(current.rows[0].version!==expected)throw conflict('This project was changed by another session. Reload and try again.','version_conflict');
      const result=await client.query(`UPDATE project SET project_code=$2,name=$3,description=$4,status=$5,version=version+1,updated_at=$6
        WHERE id=$1 RETURNING *`,[id,value.projectCode,value.name,value.description,value.status,now]);return mapProject(result.rows[0]);});}
    catch(error){uniqueError(error,'Project code');}
  }
}
