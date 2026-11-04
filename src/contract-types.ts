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

export interface Contract {
  id: string;
  version: number;
  status: ContractStatus;
  values: ContractValues;
  linkedNdaId: string | null;
  linkedNdaHistoricalId: string | null;
  signedVersionId: string | null;
  currentSignedFileId: string | null;
  signedFileCount: number;
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
  createdAt: string;
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
  values: ContractValues;
  docxArtifactId: string;
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
