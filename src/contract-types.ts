export type ContractUnit = 'Years';

export interface ContractPerson {
  name: string;
  designation: string;
}

export interface ContractContact extends ContractPerson {
  address: string;
  email: string;
}

export interface ContractParty {
  name: string;
  registrationNumber: string;
  address: string;
  signatory: ContractPerson;
  witness: ContractPerson;
  contact: ContractContact;
}

export interface ContractValues {
  discloser: ContractParty;
  recipient: ContractParty;
  purpose: string;
  agreementDate: string | null;
  duration: number | null;
  uom: ContractUnit;
  pic: string;
  department: string;
}

export type ContractStatus = 'draft' | 'signed';
export type DocumentType = 'nda' | 'eoi';
export type TemplateFormat = 'docx' | 'pdf';

export interface TemplateFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  required: boolean;
  source: string | null;
  appearance?: {
    fontWeight: 'normal' | 'bold';
  };
}

export interface PdfFieldPlacement {
  field: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  font?: 'times' | 'helvetica' | 'courier';
  align: 'left' | 'center' | 'right';
}

export interface TemplateRegion {
  id: string;
  kind: 'paragraph' | 'table-cell';
  text: string;
  readOnly: boolean;
  structureEditable?: boolean;
  structureReason?: string;
  rowId?: string;
  cellIndex?: number;
}

export interface WordTableRow {
  id: string;
  tableId: string;
  regionIds: string[];
  cellCount: number;
  readOnly: boolean;
  reason?: string;
  isHeader?: boolean;
}

export type WordStructureOperation =
  | { id: string; type: 'insert-paragraph'; anchorId: string; position: 'before' | 'after'; text: string }
  | { id: string; type: 'delete-paragraph'; targetId: string }
  | { id: string; type: 'insert-table-row'; anchorRowId: string; position: 'before' | 'after'; cells: string[] }
  | { id: string; type: 'delete-table-row'; targetRowId: string };

export interface TemplateEditorSnapshot {
  format: TemplateFormat;
  fields: TemplateFieldDefinition[];
  regions?: TemplateRegion[];
  wordStructure?: { rows: WordTableRow[] };
  wordOperations?: WordStructureOperation[];
  placements?: PdfFieldPlacement[];
  pages?: { page: number; width: number; height: number; rotation: number }[];
  warnings?: string[];
}

export interface Contract {
  id: string;
  reference: string;
  version: number;
  status: ContractStatus;
  documentType: DocumentType;
  supplierId: string | null;
  projectId: string | null;
  templateFamilyId: string | null;
  customValues: Record<string, string>;
  values: ContractValues;
  linkedNdaId: string | null;
  linkedNdaHistoricalId: string | null;
  signedVersionId: string | null;
  currentSignedFileId: string | null;
  signedFileCount: number;
  signedEoiMissing: boolean;
  createdAt: string;
  updatedAt: string;
  signedAt: string | null;
}

export interface ContractListItem extends Contract {
  latestGeneration: {
    id: string;
    jobId: string | null;
    ordinal: number;
    complete: boolean;
    matchesDraft: boolean;
  } | null;
}

export interface SignedFileSummary {
  id: string;
  contractId: string;
  ordinal: number;
  sourceVersionId: string;
  originalFileName: string;
  contentType: 'application/pdf';
  sizeBytes: number;
  checksum: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ContractTemplate {
  id: string;
  key: string;
  version: string;
  name: string;
  fileName: string;
  checksum: string;
  active: boolean;
  familyId: string | null;
  documentType: DocumentType;
  format: TemplateFormat;
  fieldSchema: TemplateFieldDefinition[];
  editorSnapshot: TemplateEditorSnapshot | null;
  createdAt: string;
}

export interface TemplateFamily {
  id: string;
  key: string;
  name: string;
  documentType: DocumentType;
  format: TemplateFormat;
  active: boolean;
  publishedTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDraft {
  id: string;
  familyId: string;
  version: number;
  name: string;
  fileName: string;
  format: TemplateFormat;
  documentType: DocumentType;
  editorSnapshot: TemplateEditorSnapshot;
  checksum: string;
  sourceSizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractValidationIssue {
  field: string;
  message: string;
}

export interface ContractVersion {
  id: string;
  contractId: string;
  ordinal: number;
  templateId: string;
  templateKey: string;
  templateVersion: string;
  templateChecksum: string;
  templateFormat: TemplateFormat;
  values: ContractValues;
  customValues: Record<string, string>;
  supplierId: string | null;
  projectId: string | null;
  templateFamilyId: string | null;
  docxArtifactId: string | null;
  pdfArtifactId: string | null;
  complete: boolean;
  createdAt: string;
}

export type DocumentJobStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed';
export type DocumentJobItemStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed';

export interface DocumentJobItem {
  id: string;
  contractId: string;
  status: DocumentJobItemStatus;
  attempts: number;
  versionId: string | null;
  docxArtifactId: string | null;
  pdfArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DocumentJob {
  id: string;
  status: DocumentJobStatus;
  itemCount: number;
  completedCount: number;
  partialCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  items: DocumentJobItem[];
}

export interface DocumentArtifact {
  id: string;
  contractId: string;
  versionId: string | null;
  kind: 'docx' | 'pdf';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
}

export interface ContractActivity {
  id: string;
  contractId: string;
  type: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ContractDetails extends Contract {
  versions: ContractVersion[];
  signedFiles: SignedFileSummary[];
  activity: ContractActivity[];
}

export interface ImportPreflightRow {
  rowNumber: number;
  values: ContractValues | null;
  errors: ContractValidationIssue[];
  warnings: ContractValidationIssue[];
}
