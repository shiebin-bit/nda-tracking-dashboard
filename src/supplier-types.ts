export interface SupplierContact {
  name: string;
  designation: string;
  address: string;
  email: string;
}

export interface Supplier {
  id: string;
  supplierCode: string;
  companyName: string;
  registrationNumber: string;
  address: string;
  contact: SupplierContact;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  projectCode: string | null;
  name: string;
  description: string;
  status: ProjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierDetails extends Supplier {
  agreements: { id: string; reference: string; version: number; recipient: string; status: string }[];
  documents: { id: string; reference: string; version: number; documentType: 'nda'|'eoi'; recipient: string; linkedNdaId: string|null; projectId: string|null; status: 'draft'|'signed'; updatedAt: string }[];
}

export interface SupplierAssignmentItem {
  id: string;
  expectedVersion: number;
}

export interface SupplierAssignmentInput {
  agreements: SupplierAssignmentItem[];
  documents: SupplierAssignmentItem[];
}

export interface SupplierAssignmentResult {
  supplier: SupplierDetails;
  revision: string;
  agreementsChanged: number;
  documentsChanged: number;
}
