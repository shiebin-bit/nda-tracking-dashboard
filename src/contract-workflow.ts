import type {Contract, ContractValues, ContractVersion, DocumentJob} from './contract-types';
import {normalizeContractValues,normalizeCustomValues} from './contract-core';

export function generationMatchesDraft(version:Pick<ContractVersion,'values'|'customValues'|'supplierId'|'projectId'|'templateFamilyId'>,draft:Pick<Contract,'values'|'customValues'|'supplierId'|'projectId'|'templateFamilyId'>):boolean {
  const custom=(values:Record<string,string>)=>JSON.stringify(Object.entries(normalizeCustomValues(values)).sort(([a],[b])=>a.localeCompare(b)));
  return JSON.stringify(normalizeContractValues(version.values))===JSON.stringify(normalizeContractValues(draft.values))
    && custom(version.customValues)===custom(draft.customValues)
    && version.projectId===draft.projectId
    && version.templateFamilyId===draft.templateFamilyId;
}

export type ContractStage = 'draft' | 'generating' | 'pdf-incomplete' | 'awaiting-copy' | 'awaiting-confirmation' | 'signed' | 'signed-missing-file';
export type ContractNextAction = 'generate' | 'view-job' | 'upload' | 'confirm' | 'view';
export interface GenerationSummary {id:string; ordinal:number; complete:boolean; matchesDraft:boolean}
export interface ContractProgress {
  stage: ContractStage;
  label: string;
  hint: string;
  action: ContractNextAction;
  actionLabel: string;
  step: number;
  tone: 'gray' | 'amber' | 'green' | 'teal';
}

export const contractStages: {value:ContractStage; label:string}[] = [
  {value:'draft', label:'Draft'},
  {value:'generating', label:'Generating'},
  {value:'pdf-incomplete', label:'PDF incomplete'},
  {value:'awaiting-copy', label:'Awaiting signed copy'},
  {value:'awaiting-confirmation', label:'Awaiting confirmation'},
  {value:'signed', label:'Signed'},
  {value:'signed-missing-file', label:'Signed · File missing'},
];

export function getContractProgress(
  contract: (Pick<Contract,'status'|'currentSignedFileId'|'linkedNdaId'|'linkedNdaHistoricalId'> & Partial<Pick<Contract,'documentType'>>) | null,
  generation: GenerationSummary | null,
  generating = false,
): ContractProgress {
  if (contract?.status === 'signed') {
    if (!contract.currentSignedFileId) return {stage:'signed-missing-file',label:'Signed · File missing',hint:'Upload the final PDF to complete the file record. Existing tracking stays unchanged.',action:'upload',actionLabel:'Upload signed copy',step:2,tone:'amber'};
    return {stage:'signed',label:'Signed',hint:contract.documentType==='eoi'?'Signed EOI saved. No expiry tracking or reminder was created.':contract.linkedNdaId?'Signed copy saved and tracking linked. Manage the agreement status in Input.':contract.linkedNdaHistoricalId?'Signed copy saved. The original tracking record is unavailable or in the recycle bin.':'Signed copy saved. No tracking record is linked.',action:'view',actionLabel:'View signed copy',step:4,tone:'green'};
  }
  if (contract?.currentSignedFileId) return {stage:'awaiting-confirmation',label:'Awaiting confirmation',hint:contract.documentType==='eoi'?'Review the uploaded EOI PDF, then confirm the signature.':'Review the uploaded PDF, agreement date and PIC, then confirm the signature.',action:'confirm',actionLabel:'Review & confirm signed',step:3,tone:'teal'};
  if (generating) return {stage:'generating',label:'Generating',hint:'Word and PDF generation is running. Follow its progress below.',action:'view-job',actionLabel:'View generation progress',step:1,tone:'gray'};
  if (!generation) return {stage:'draft',label:'Draft',hint:contract?.documentType==='eoi'?'Select a supplier and project, complete the required template fields, then generate the EOI.':'Complete the company details, Purpose and Duration, then generate the agreement.',action:'generate',actionLabel:'Generate Word & PDF',step:0,tone:'gray'};
  if (!generation.matchesDraft) return {stage:'draft',label:'Draft · Changes to generate',hint:'The draft differs from the latest generated version. Generate again to include these changes.',action:'generate',actionLabel:'Generate updated files',step:0,tone:'amber'};
  if (!generation.complete) return {stage:'pdf-incomplete',label:'PDF incomplete',hint:'The Word file is saved. Open the generation job and retry PDF conversion.',action:'view-job',actionLabel:'Review generation',step:1,tone:'amber'};
  return {stage:'awaiting-copy',label:'Awaiting signed copy',hint:`Version ${generation.ordinal} is ready. Download it for signing, then upload the complete signed PDF.`,action:'upload',actionLabel:'Upload signed copy',step:2,tone:'teal'};
}

export function runningContractJob(jobs:DocumentJob[], contractId:string): DocumentJob | undefined {
  return jobs.find(job => ['queued','running'].includes(job.status) && job.items.some(item => item.contractId === contractId && ['queued','running'].includes(item.status)));
}

export function matchesContractFilters(
  contract: Pick<Contract,'status'|'values'> & {reference?:string},
  progress: ContractProgress,
  filters: {search:string; status:string; stage:string; pic:string},
): boolean {
  const {values} = contract;
  return (filters.status === 'all' || contract.status === filters.status)
    && (filters.stage === 'all' || progress.stage === filters.stage)
    && (filters.pic === 'all' || (filters.pic === 'unassigned' ? !values.pic.trim() : values.pic.trim() === filters.pic.slice(4)))
    && `${contract.reference??''} ${values.recipient.name} ${values.discloser.name} ${values.pic} ${values.purpose}`.toLowerCase().includes(filters.search.trim().toLowerCase());
}

export const contractFieldId = (path:string) => `contract-${path.replaceAll('.','-')}`;
export const generationRequired = (path:string) => ['purpose','duration','discloser.name','discloser.registrationNumber','discloser.address','recipient.name','recipient.registrationNumber','recipient.address'].includes(path);

export function contractFieldLabel(path:string): string {
  const agreement: Partial<Record<keyof ContractValues,string>> = {purpose:'Purpose',duration:'Duration',agreementDate:'Agreement date',pic:'PIC',department:'Department'};
  if (agreement[path as keyof ContractValues]) return agreement[path as keyof ContractValues]!;
  const [side,...parts] = path.split('.');
  const labels: Record<string,string> = {name:'company name',registrationNumber:'registration number',address:'company address','contact.name':'contact name','contact.designation':'contact designation','contact.address':'contact address','contact.email':'contact email','signatory.name':'signatory name','signatory.designation':'signatory designation','witness.name':'witness name','witness.designation':'witness designation'};
  return `${side === 'recipient' ? 'Recipient' : 'Discloser'} ${labels[parts.join('.')] ?? parts.join(' ')}`;
}
