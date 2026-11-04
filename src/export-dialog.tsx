import { useRef, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Modal } from './components';
import type { NdaRecord } from './core';
import { buildAgreementWorkbook, downloadAgreementWorkbook, type ExportFilter, type ExportScope } from './exporter';

export function ExportDialog({ allRecords, filteredRecords, filters, unavailable, onClose }: {
  allRecords: NdaRecord[]; filteredRecords: NdaRecord[]; filters: ExportFilter[];
  unavailable: boolean; onClose: () => void;
}) {
  const [scope, setScope] = useState<ExportScope>('filtered');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const selected = scope === 'all' ? allRecords : filteredRecords;
  const submit = async () => {
    if (inFlight.current || unavailable || !selected.length) return;
    inFlight.current = true;
    setExporting(true);
    setError('');
    const exportedAt = new Date();
    const records = selected.map(record => ({ ...record, fields: { ...record.fields } }));
    const selectedFilters = filters.map(filter => ({ ...filter }));
    let complete = false;
    try {
      const bytes = await buildAgreementWorkbook(records, { scope, filters: selectedFilters, exportedAt });
      downloadAgreementWorkbook(bytes, scope, exportedAt);
      complete = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Excel file could not be created. Please try again.');
    } finally {
      inFlight.current = false;
      setExporting(false);
    }
    if (complete) onClose();
  };
  return <Modal title="Export Excel" onClose={() => { if (!inFlight.current) onClose(); }}>
    <div className="dialog-body export-dialog-body">
      <p className="dialog-intro">Download the original 26 columns with expiry dates and remaining days calculated for today in Malaysia time.</p>
      <fieldset className="export-scope-options" disabled={exporting}>
        <legend>Choose records to export</legend>
        <label className={scope === 'filtered' ? 'selected' : ''}><input type="radio" name="export-scope" value="filtered" checked={scope === 'filtered'} onChange={() => setScope('filtered')}/><span><strong>Current filtered results <span>{filteredRecords.length}</span></strong><small>All matching agreements across every page.</small></span></label>
        <label className={scope === 'all' ? 'selected' : ''}><input type="radio" name="export-scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')}/><span><strong>All agreements <span>{allRecords.length}</span></strong><small>Include all Pending and Resolved records.</small></span></label>
      </fieldset>
      {scope === 'filtered' && filters.length > 0 && <div className="export-filter-summary"><strong>Active filters</strong><ul>{filters.map(filter => <li key={filter.label}>{filter.label}: {filter.value}</li>)}</ul></div>}
      <p className="caption"><FileSpreadsheet size={16}/>The workbook includes a record sheet and an export information sheet. Values are a snapshot of the export date.</p>
      {!selected.length && <p className="error-text" role="status">No agreements match this export range. Choose all agreements or adjust the filters.</p>}
      {unavailable && <p className="error-text" role="alert">Export is unavailable while saving or the database connection is interrupted.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions"><span className="caption">{selected.length} agreement{selected.length === 1 ? '' : 's'}</span><button type="button" className="button secondary" disabled={exporting} onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={exporting || unavailable || !selected.length} onClick={() => void submit()}><Download size={16}/>{exporting ? 'Creating Excel…' : 'Download Excel'}</button></div>
  </Modal>;
}
