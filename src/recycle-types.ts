import type { Contract } from './contract-types.js';
import type { NdaRecord } from './core.js';

export interface RecycledMetadata {
  deletedAt: string;
  deletedBy: string;
}

export type RecycledNdaRecord = NdaRecord & RecycledMetadata;
export type RecycledContract = Contract & RecycledMetadata;

export interface RecycleBin {
  records: RecycledNdaRecord[];
  contracts: RecycledContract[];
}
