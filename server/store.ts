import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from './db.js';
import {
  fingerprint,
  type Fields,
  type HistoryEvent,
  type NdaRecord,
  type RestoreArchiveSummary,
  type Settings,
  type Snapshot,
  type StateEnvelope,
} from '../src/core.js';
import {
  assertExpectedVersion,
  assertFieldsShape,
  assertRevision,
  canonicalFields,
  changesBetween,
  isPlainObject,
  nextNumber,
  normalizeSettings,
  normalizeSnapshot,
  settingsChanges,
  validateNewFields,
  validateUpdatedFields,
} from './domain.js';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './db.js';
import type { RecycledNdaRecord } from '../src/recycle-types.js';

type Workspace = { revision: string; settings: Settings; initialized_at: string | Date; next_number: string };

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function workspace(client: Pool | PoolClient, lock = false): Promise<Workspace> {
  const result = await client.query<Workspace>(
    `SELECT CAST(revision AS TEXT) revision, settings, initialized_at, CAST(next_number AS TEXT) next_number FROM workspace WHERE id=1`,
  );
  if (!result.rows[0]) throw new Error('Database workspace is not initialized.');
  return result.rows[0];
}

async function snapshot(client: Pool | PoolClient, current?: Workspace): Promise<StateEnvelope> {
  const ws = current ?? await workspace(client);
  const [recordsResult, historyResult] = await Promise.all([
    client.query(`SELECT n.id, n.reference_code, n.version, n.source, n.created_at, n.updated_at, n.renewed_from_id, n.fields,
      n.supplier_id, s.supplier_code
      FROM nda_record n LEFT JOIN supplier s ON s.id=n.supplier_id
      WHERE n.deleted_at IS NULL ORDER BY n.position ASC`),
    client.query(`SELECT h.id, h.nda_id, h.type, h.timestamp, h.actor, h.summary, h.changes
      FROM history_event h
      WHERE h.nda_id IS NULL OR EXISTS (
        SELECT 1 FROM nda_record n WHERE n.id=h.nda_id AND n.deleted_at IS NULL
      )
      ORDER BY h.position ASC`),
  ]);
  const records: NdaRecord[] = recordsResult.rows.map((row) => ({
    id: row.id, reference: row.reference_code, fields: row.fields, version: row.version, source: row.source,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.renewed_from_id ? { renewedFromId: row.renewed_from_id } : {}),
    supplierId: row.supplier_id ?? null, supplierCode: row.supplier_code ?? null,
  }));
  const history: HistoryEvent[] = historyResult.rows.map((row) => ({
    id: row.id, ...(row.nda_id ? { ndaId: row.nda_id } : {}), type: row.type,
    timestamp: iso(row.timestamp), actor: row.actor, summary: row.summary, changes: row.changes,
  }));
  return {
    revision: ws.revision,
    snapshot: {
      schemaVersion: 1, records, history,
      settings: normalizeSettings(ws.settings, true), initializedAt: iso(ws.initialized_at),
    },
  };
}

async function bump(client: PoolClient): Promise<Workspace> {
  const result = await client.query<Workspace>(`UPDATE workspace SET revision=revision+1 WHERE id=1
    RETURNING CAST(revision AS TEXT) revision, settings, initialized_at, CAST(next_number AS TEXT) next_number`);
  return result.rows[0];
}

async function positions(client: PoolClient): Promise<{ record: number; history: number }> {
  const result = await client.query(`SELECT
    CAST(COALESCE((SELECT max(position) FROM nda_record),0) AS TEXT) record,
    CAST(COALESCE((SELECT max(position) FROM history_event),0) AS TEXT) history`);
  return { record: Number(result.rows[0].record) + 1, history: Number(result.rows[0].history) + 1 };
}

async function insertHistory(client: PoolClient, event: Omit<HistoryEvent, 'id'> & { id?: string }, position: number): Promise<void> {
  await client.query(`INSERT INTO history_event(id,position,nda_id,type,timestamp,actor,summary,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [event.id ?? randomUUID(), position, event.ndaId ?? null,
    event.type, event.timestamp, event.actor, event.summary, JSON.stringify(event.changes)]);
}

type StoredRecord = NdaRecord & { deletedAt: string | null; deletedBy: string | null };

async function findRecord(client: PoolClient, id: string, allowRecycled = false): Promise<StoredRecord> {
  const result = await client.query(`SELECT n.id,n.reference_code,n.version,n.source,n.created_at,n.updated_at,n.renewed_from_id,n.fields,
      n.supplier_id,s.supplier_code,n.deleted_at,n.deleted_by
    FROM nda_record n LEFT JOIN supplier s ON s.id=n.supplier_id WHERE n.id=$1`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound('NDA record was not found.');
  if (row.deleted_at && !allowRecycled) throw conflict('This NDA record is in the Recycle Bin.', 'record_recycled');
  return { id: row.id, reference: row.reference_code, version: row.version, source: row.source, createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at), fields: row.fields,
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null, deletedBy: row.deleted_by ?? null,
    supplierId: row.supplier_id ?? null, supplierCode: row.supplier_code ?? null,
    ...(row.renewed_from_id ? { renewedFromId: row.renewed_from_id } : {}) };
}

function assertRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw badRequest('requestId must be a UUID.');
  }
  return value.toLowerCase();
}

type RecycleAction = 'recycled' | 'restored';

async function replayRecycleRequest(
  client: PoolClient,
  requestId: string,
  recordId: string,
  action: RecycleAction,
  expectedVersion: number,
): Promise<boolean> {
  const result = await client.query(`SELECT nda_id,type,actor,summary,changes
    FROM history_event WHERE id=$1`, [requestId]);
  const row = result.rows[0];
  if (!row) return false;
  const expectedSummary = action === 'recycled'
    ? 'Moved NDA record to Recycle Bin.' : 'Restored NDA record from Recycle Bin.';
  const changes = Array.isArray(row.changes) ? row.changes as Record<string, unknown>[] : [];
  const bin = changes.find((change) => change.field === 'Recycle bin');
  const version = changes.find((change) => change.field === 'Version');
  const identical = row.nda_id === recordId && row.type === action && row.actor === 'Local user'
    && row.summary === expectedSummary && changes.length === 2
    && bin?.before === (action === 'recycled' ? false : true)
    && bin?.after === (action === 'recycled' ? true : false)
    && version?.before === expectedVersion && version?.after === expectedVersion + 1;
  if (!identical) throw conflict('requestId was already used for another request.', 'request_id_conflict');
  return true;
}

function checkVersion(record: NdaRecord, expected: unknown): void {
  const version = assertExpectedVersion(expected);
  if (record.version !== version) throw conflict('This NDA was changed by another session. Reload and try again.', 'version_conflict');
}

export class PgNdaStore {
  constructor(
    private readonly pool: Pool,
    private readonly validateAutomaticSettings?: (settings: Settings) => Promise<void>,
  ) {}

  async state(): Promise<StateEnvelope> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await snapshot(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recycledRecords(): Promise<RecycledNdaRecord[]> {
    const result = await this.pool.query(`SELECT n.id,n.reference_code,n.version,n.source,n.created_at,n.updated_at,
      n.renewed_from_id,n.fields,n.supplier_id,s.supplier_code,n.deleted_at,n.deleted_by
      FROM nda_record n LEFT JOIN supplier s ON s.id=n.supplier_id
      WHERE n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC,n.id`);
    return result.rows.map((row) => ({
      id: row.id, reference: row.reference_code, version: row.version, source: row.source, fields: row.fields,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by,
      ...(row.renewed_from_id ? { renewedFromId: row.renewed_from_id } : {}),
      supplierId: row.supplier_id ?? null, supplierCode: row.supplier_code ?? null,
    }));
  }

  async recycle(id: string, input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const requestId = assertRequestId(input.requestId);
    const expectedVersion = assertExpectedVersion(input.expectedVersion);
    return withTransaction(this.pool, async (client) => {
      const ws = await workspace(client, true);
      if (await replayRecycleRequest(client, requestId, id, 'recycled', expectedVersion)) return snapshot(client, ws);
      const record = await findRecord(client, id);
      checkVersion(record, expectedVersion);
      const activeChild = await client.query(
        'SELECT id FROM nda_record WHERE renewed_from_id=$1 AND deleted_at IS NULL LIMIT 1', [id],
      );
      if (activeChild.rows[0]) throw conflict('Recycle the active renewal before its parent.', 'record_has_active_renewal');
      const now = new Date().toISOString();
      await client.query(`UPDATE nda_record SET version=version+1,updated_at=$2,deleted_at=$2,deleted_by='Local user'
        WHERE id=$1`, [id, now]);
      const pos = await positions(client);
      await insertHistory(client, {
        id: requestId, ndaId: id, type: 'recycled', timestamp: now, actor: 'Local user',
        summary: 'Moved NDA record to Recycle Bin.',
        changes: [{ field: 'Recycle bin', before: false, after: true },
          { field: 'Version', before: expectedVersion, after: expectedVersion + 1 }],
      }, pos.history);
      return snapshot(client, await bump(client));
    });
  }

  async restoreRecycled(id: string, input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const requestId = assertRequestId(input.requestId);
    const expectedVersion = assertExpectedVersion(input.expectedVersion);
    return withTransaction(this.pool, async (client) => {
      const ws = await workspace(client, true);
      if (await replayRecycleRequest(client, requestId, id, 'restored', expectedVersion)) return snapshot(client, ws);
      const record = await findRecord(client, id, true);
      if (!record.deletedAt) throw conflict('This NDA record is not in the Recycle Bin.', 'not_in_recycle_bin');
      checkVersion(record, expectedVersion);
      if (record.renewedFromId) {
        const parent = await client.query('SELECT deleted_at FROM nda_record WHERE id=$1', [record.renewedFromId]);
        if (!parent.rows[0] || parent.rows[0].deleted_at) {
          throw conflict('Restore the renewal parent first.', 'renewal_parent_recycled');
        }
      }
      const now = new Date().toISOString();
      await client.query(`UPDATE nda_record SET version=version+1,updated_at=$2,deleted_at=NULL,deleted_by=NULL
        WHERE id=$1`, [id, now]);
      const pos = await positions(client);
      await insertHistory(client, {
        id: requestId, ndaId: id, type: 'restored', timestamp: now, actor: 'Local user',
        summary: 'Restored NDA record from Recycle Bin.',
        changes: [{ field: 'Recycle bin', before: true, after: false },
          { field: 'Version', before: expectedVersion, after: expectedVersion + 1 }],
      }, pos.history);
      return snapshot(client, await bump(client));
    });
  }

  async listArchives():Promise<RestoreArchiveSummary[]>{
    const result=await this.pool.query(`SELECT id,created_at,
      json_array_length(preimage->'records') records,
      json_array_length(preimage->'history') history
      FROM restore_archive ORDER BY created_at DESC,id DESC LIMIT 50`);
    return result.rows.map(row=>({id:row.id,createdAt:iso(row.created_at),records:row.records,history:row.history}));
  }

  async create(input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const requestedFields = input.fields;
    assertFieldsShape(requestedFields);
    return withTransaction(this.pool, async (client) => {
      const ws = await workspace(client, true);
      const fields = canonicalFields(requestedFields);
      fields['No.'] = Number(ws.next_number);
      validateNewFields(fields, 'form');
      const now = new Date().toISOString(); const id = randomUUID(); const pos = await positions(client);
      await client.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
        VALUES($1,$2,1,'manual',$3,$3,$4,$5)`, [id,pos.record,now,JSON.stringify(fields),fingerprint(fields)]);
      await client.query('UPDATE workspace SET next_number=next_number+1 WHERE id=1');
      await insertHistory(client, { ndaId:id,type:'created',timestamp:now,actor:'Local user',summary:'Created NDA record.',changes:changesBetween(null,fields) }, pos.history);
      return snapshot(client, await bump(client));
    });
  }

  async update(id: string, input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const requestedFields = input.fields;
    assertFieldsShape(requestedFields);
    return withTransaction(this.pool, async (client) => {
      await workspace(client, true);
      const record = await findRecord(client,id); checkVersion(record,input.expectedVersion);
      const fields = canonicalFields(requestedFields, record.fields); fields['No.'] = record.fields['No.'];
      validateUpdatedFields(fields,record.fields);
      const changes = changesBetween(record.fields,fields);
      if (!changes.length) return snapshot(client);
      const now = new Date().toISOString();
      await client.query(`UPDATE nda_record SET version=version+1,updated_at=$2,fields=$3,fingerprint=$4 WHERE id=$1`,
        [id,now,JSON.stringify(fields),fingerprint(fields)]);
      const pos = await positions(client);
      await insertHistory(client,{ndaId:id,type:'updated',timestamp:now,actor:'Local user',summary:'Updated NDA record.',changes},pos.history);
      return snapshot(client,await bump(client));
    });
  }

  async addFollowUpNote(id: string, input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
      throw badRequest('requestId must be a UUID.');
    }
    if (typeof input.text !== 'string' || input.text.includes('\0')) {
      throw badRequest('Follow-up note text must be text without NUL characters.');
    }
    const text = input.text.trim();
    if (text.length < 1 || text.length > 2_000) {
      throw badRequest('Follow-up note text must contain 1 to 2000 characters.');
    }
    const requestId = input.requestId.toLowerCase();
    const expectedVersion = assertExpectedVersion(input.expectedVersion);
    const changes = [{ field: 'Follow-up note', before: null, after: text }];
    return withTransaction(this.pool, async (client) => {
      const ws = await workspace(client, true);
      const replay = await client.query(`SELECT nda_id,type,actor,summary,changes
        FROM history_event WHERE id=$1`, [requestId]);
      if (replay.rows[0]) {
        const row = replay.rows[0];
        const replayChange = Array.isArray(row.changes) ? row.changes[0] as Record<string, unknown> | undefined : undefined;
        const identical = row.nda_id === id && row.type === 'follow-up-added' && row.actor === 'Local user'
          && row.summary === 'Added follow-up note.' && row.changes.length === 1
          && replayChange?.field === 'Follow-up note' && replayChange.before === null && replayChange.after === text;
        if (!identical) throw conflict('requestId was already used for another request.', 'request_id_conflict');
        return snapshot(client, ws);
      }
      const record = await findRecord(client, id);
      checkVersion(record, expectedVersion);
      const now = new Date().toISOString();
      const pos = await positions(client);
      await client.query('UPDATE nda_record SET version=version+1,updated_at=$2 WHERE id=$1', [id, now]);
      await insertHistory(client, {
        id: requestId, ndaId: id, type: 'follow-up-added', timestamp: now, actor: 'Local user',
        summary: 'Added follow-up note.', changes,
      }, pos.history);
      return snapshot(client, await bump(client));
    });
  }

  async renew(id: string, input: unknown): Promise<StateEnvelope> {
    if (!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const requestedFields = input.fields;
    assertFieldsShape(requestedFields);
    return withTransaction(this.pool, async (client) => {
      const ws=await workspace(client,true); const old=await findRecord(client,id); checkVersion(old,input.expectedVersion);
      const fresh=canonicalFields(requestedFields); fresh.Status='Pending'; fresh['No.']=Number(ws.next_number); validateNewFields(fresh,'form');
      const resolved=canonicalFields(old.fields); resolved.Status='Resolved';
      const now=new Date().toISOString(); const newId=randomUUID(); const pos=await positions(client);
      await client.query(`UPDATE nda_record SET version=version+1,updated_at=$2,fields=$3,fingerprint=$4 WHERE id=$1`,[id,now,JSON.stringify(resolved),fingerprint(resolved)]);
      await client.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,renewed_from_id,supplier_id,fields,fingerprint)
        VALUES($1,$2,1,'renewal',$3,$3,$4,$5,$6,$7)`,[newId,pos.record,now,id,old.supplierId??null,JSON.stringify(fresh),fingerprint(fresh)]);
      await client.query('UPDATE workspace SET next_number=next_number+1 WHERE id=1');
      await insertHistory(client,{ndaId:id,type:'resolved-for-renewal',timestamp:now,actor:'Local user',summary:'Resolved original NDA during renewal.',changes:changesBetween(old.fields,resolved)},pos.history);
      await insertHistory(client,{ndaId:newId,type:'renewed',timestamp:now,actor:'Local user',summary:'Created renewed NDA.',changes:changesBetween(null,fresh)},pos.history+1);
      return snapshot(client,await bump(client));
    });
  }

  async importRows(input: unknown, initial=false): Promise<StateEnvelope> {
    if (!isPlainObject(input) || !Array.isArray(input.rows)) throw badRequest('rows must be an array.');
    const rows=input.rows.map((value) => { assertFieldsShape(value); const fields=canonicalFields(value); validateNewFields(fields,'import'); return fields; });
    return withTransaction(this.pool,async(client)=>{
      const ws=await workspace(client,true);
      if(initial){
        const counts=await client.query(`SELECT (SELECT count(*) FROM nda_record) records,(SELECT count(*) FROM history_event) history`);
        if(counts.rows[0].records!==0||counts.rows[0].history!==0||ws.revision!=='0')throw conflict('Initial Excel import requires an unchanged empty database.','initial_import_not_empty');
        const marks=new Set(rows.map(fingerprint));
        const pending=rows.filter(row=>row.Status==='Pending').length; const resolved=rows.filter(row=>row.Status==='Resolved').length;
        const duplicateFive=rows.filter(row=>row['No.']===5).length; const missingDate=rows.filter(row=>!row['Date of Agreement']).length;
        if(rows.length!==11||marks.size!==11||pending!==6||resolved!==5||duplicateFive!==2||missingDate!==1){
          throw badRequest('Initial Excel import does not match the confirmed 11-row source profile.','initial_import_profile_mismatch');
        }
      }
      const existing=await client.query<{fingerprint:string}>('SELECT fingerprint FROM nda_record'); const seen=new Set(existing.rows.map(r=>r.fingerprint));
      let next=Number(ws.next_number); let inserted=0; const now=new Date().toISOString(); const pos=await positions(client);
      for(const fields of rows){ const mark=fingerprint(fields); if(seen.has(mark)) continue; seen.add(mark);
        const supplied=fields['No.']; if(typeof supplied!=='number'||!Number.isSafeInteger(supplied)||supplied<1) fields['No.']=next;
        next=Math.max(next,Number(fields['No.'])+1); const id=randomUUID();
        await client.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
          VALUES($1,$2,1,'excel',$3,$3,$4,$5)`,[id,pos.record+inserted,now,JSON.stringify(fields),mark]);
        await insertHistory(client,{ndaId:id,type:initial?'initial-excel-import':'imported',timestamp:now,actor:initial?'System':'Local user',summary:initial?'Imported original Excel NDA record.':'Imported NDA record.',changes:changesBetween(null,fields)},pos.history+inserted);
        inserted++;
      }
      if(!inserted) return snapshot(client,ws);
      if(initial&&inserted!==11)throw conflict('Initial Excel import could not insert all 11 unique records.','initial_import_incomplete');
      await client.query('UPDATE workspace SET next_number=$1 WHERE id=1',[next]);
      return snapshot(client,await bump(client));
    });
  }

  async updateSettings(input: unknown): Promise<StateEnvelope> {
    if(!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const expected=assertRevision(input.expectedRevision); const settings=normalizeSettings(input.settings);
    if(settings.automaticRemindersEnabled===true){
      if(!this.validateAutomaticSettings) throw badRequest('Automatic reminder validation is unavailable.','email_not_available');
      await this.validateAutomaticSettings(settings);
    }
    return withTransaction(this.pool,async(client)=>{ const ws=await workspace(client,true);
      if(ws.revision!==expected) throw conflict('Settings changed in another session. Reload and try again.','revision_conflict');
      const before=normalizeSettings(ws.settings,true); const changes=settingsChanges(before,settings); if(!changes.length)return snapshot(client,ws);
      const now=new Date().toISOString(); const pos=await positions(client);
      await client.query('UPDATE workspace SET settings=$1 WHERE id=1',[JSON.stringify(settings)]);
      await insertHistory(client,{type:'settings-updated',timestamp:now,actor:'Local user',summary:'Updated reminder settings.',changes},pos.history);
      return snapshot(client,await bump(client)); });
  }

  async linkSupplier(id:string,input:unknown):Promise<StateEnvelope>{
    if(!isPlainObject(input))throw badRequest('Request body must be an object.');
    const expected=assertExpectedVersion(input.expectedVersion);
    const supplierId=input.supplierId===null?null:typeof input.supplierId==='string'?input.supplierId.trim():undefined;
    if(supplierId===undefined||(supplierId!==null&&(!supplierId||supplierId.includes('\0'))))throw badRequest('supplierId must be a non-empty ID or null.');
    return withTransaction(this.pool,async client=>{
      await workspace(client,true);const record=await findRecord(client,id);checkVersion(record,expected);
      let supplierCode:string|null=null;
      if(supplierId){const supplier=await client.query('SELECT supplier_code FROM supplier WHERE id=$1 AND deleted_at IS NULL',[supplierId]);
        if(!supplier.rows[0])throw notFound('Supplier was not found.');supplierCode=supplier.rows[0].supplier_code;}
      if((record.supplierId??null)===supplierId)return snapshot(client);
      const related=await client.query(`SELECT id FROM contract
        WHERE linked_nda_id=$1 AND deleted_at IS NULL AND supplier_id IS DISTINCT FROM $2
        ORDER BY id`,[id,supplierId]);
      if(related.rows.length){
        const error=conflict('This agreement has related documents. Assign the full group from Suppliers so they keep the same Supplier ID.','related_items_required');
        error.details={agreementIds:[],documentIds:related.rows.map(row=>row.id)};
        throw error;
      }
      const now=new Date().toISOString();
      await client.query('UPDATE nda_record SET supplier_id=$2,version=version+1,updated_at=$3 WHERE id=$1',[id,supplierId,now]);
      const pos=await positions(client);
      await insertHistory(client,{ndaId:id,type:'supplier-linked',timestamp:now,actor:'Local user',summary:supplierId?'Linked NDA record to supplier.':'Removed supplier link from NDA record.',
        changes:[{field:'Supplier ID',before:record.supplierCode??null,after:supplierCode},{field:'Version',before:expected,after:expected+1}]},pos.history);
      return snapshot(client,await bump(client));
    });
  }

  async restore(input: unknown): Promise<StateEnvelope> {
    if(!isPlainObject(input)) throw badRequest('Request body must be an object.');
    return this.replace(assertRevision(input.expectedRevision),normalizeSnapshot(input.snapshot));
  }

  async restoreArchive(id:string,input:unknown):Promise<StateEnvelope>{
    if(!isPlainObject(input)) throw badRequest('Request body must be an object.');
    const result=await this.pool.query<{preimage:unknown}>('SELECT preimage FROM restore_archive WHERE id=$1',[id]);
    if(!result.rows[0])throw notFound('Restore archive was not found.');
    return this.replace(assertRevision(input.expectedRevision),normalizeSnapshot(result.rows[0].preimage));
  }

  private async replace(expected:string,restored:Snapshot):Promise<StateEnvelope>{
    return withTransaction(this.pool,async(client)=>{ const ws=await workspace(client,true);
      if(ws.revision!==expected)throw conflict('Data changed in another session. Reload and try again.','revision_conflict');
      const recycled=await client.query('SELECT id FROM nda_record WHERE deleted_at IS NOT NULL LIMIT 1');
      if(recycled.rows[0])throw conflict('Restore all recycled NDA records before restoring a backup.','recycle_bin_not_empty');
      const preimage=(await snapshot(client,ws)).snapshot; const archiveId=randomUUID(); const now=new Date().toISOString();
      await client.query('INSERT INTO restore_archive(id,created_at,restored_revision,preimage) VALUES($1,$2,$3,$4)',[archiveId,now,ws.revision,JSON.stringify(preimage)]);
      const existingReferences = new Map<string,string>((await client.query('SELECT id,reference_code FROM nda_record')).rows
        .map(row => [row.id as string,row.reference_code as string]));
      await client.query('DELETE FROM history_event'); await client.query('DELETE FROM nda_record');
      let missingSupplierLinks=0;
      for(let i=0;i<restored.records.length;i++){const r=restored.records[i];let supplierId:string|null=null;
        if(r.supplierId||r.supplierCode){const supplier=await client.query(`SELECT id FROM supplier WHERE deleted_at IS NULL AND
          (id=$1 OR ($2<>'' AND lower(supplier_code)=lower($2))) ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END LIMIT 1`,[r.supplierId??'',r.supplierCode??'']);
          supplierId=supplier.rows[0]?.id??null;if(!supplierId)missingSupplierLinks++;}
        await client.query(`INSERT INTO nda_record(id,reference_code,position,version,source,created_at,updated_at,renewed_from_id,supplier_id,fields,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[r.id,existingReferences.get(r.id)??null,i+1,r.version,r.source,r.createdAt,r.updatedAt,r.renewedFromId??null,supplierId,JSON.stringify(r.fields),fingerprint(r.fields)]);}
      for(let i=0;i<restored.history.length;i++){const h=restored.history[i];await client.query(`INSERT INTO history_event(id,position,nda_id,type,timestamp,actor,summary,changes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[h.id,i+1,h.ndaId??null,h.type,h.timestamp,h.actor,h.summary,JSON.stringify(h.changes)]);}
      const next=nextNumber(restored.records);
      const restoredSettings={...restored.settings,automaticRemindersEnabled:false};
      await client.query('UPDATE workspace SET settings=$1,initialized_at=$2,next_number=$3 WHERE id=1',[JSON.stringify(restoredSettings),restored.initializedAt,next]);
      await insertHistory(client,{type:'backup-restored',timestamp:now,actor:'Local user',summary:'Restored backup snapshot.',changes:[]},restored.history.length+1);
      if(missingSupplierLinks)await insertHistory(client,{type:'supplier-links-missing',timestamp:now,actor:'System',summary:`${missingSupplierLinks} restored supplier link${missingSupplierLinks===1?'':'s'} could not be matched.`,changes:[]},restored.history.length+2);
      const result=await snapshot(client,await bump(client)); return {...result,archiveId};
    });
  }
}
