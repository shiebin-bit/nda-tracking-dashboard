import {describe,expect,it} from 'vitest';
import {createFfmContractDefaults} from './contract-core';
import {contractFieldLabel,generationRequired,getContractProgress,matchesContractFilters,runningContractJob} from './contract-workflow';
import type {Contract,DocumentJob} from './contract-types';

const draft={status:'draft',currentSignedFileId:null,linkedNdaId:null,linkedNdaHistoricalId:null} as const;
const generation={id:'version',ordinal:2,complete:true,matchesDraft:true};

describe('contract workflow guidance',()=>{
  it('moves through draft, generating, ready for signing, uploaded and confirmed without claiming active reminders',()=>{
    expect(getContractProgress(null,null).stage).toBe('draft');
    expect(getContractProgress(draft,null,true).stage).toBe('generating');
    expect(getContractProgress(draft,generation).stage).toBe('awaiting-copy');
    expect(getContractProgress({...draft,currentSignedFileId:'signed-file'},generation).action).toBe('confirm');
    const signed=getContractProgress({...draft,status:'signed',currentSignedFileId:'signed-file',linkedNdaId:'resolved-record'},generation);
    expect(signed.stage).toBe('signed');
    expect(signed.hint).toContain('tracking linked');
    expect(signed.hint).not.toContain('active');
  });
  it('recommends regeneration for changed drafts and recovery for incomplete PDFs',()=>{
    expect(getContractProgress(draft,{...generation,matchesDraft:false}).action).toBe('generate');
    expect(getContractProgress(draft,{...generation,complete:false}).stage).toBe('pdf-incomplete');
    expect(getContractProgress(draft,{...generation,complete:false,matchesDraft:false}).stage).toBe('draft');
  });
  it('keeps an uploaded signed snapshot available even if a newer draft has changes or a job is running',()=>{
    expect(getContractProgress({...draft,currentSignedFileId:'signed-file'},{...generation,matchesDraft:false},true).stage).toBe('awaiting-confirmation');
  });
  it('handles legacy missing files and unavailable tracking links separately',()=>{
    const missing=getContractProgress({...draft,status:'signed',linkedNdaId:'record'},generation);
    expect(missing.stage).toBe('signed-missing-file');
    expect(missing.action).toBe('upload');
    expect(missing.hint).toContain('unchanged');
    expect(getContractProgress({...draft,status:'signed',currentSignedFileId:'file',linkedNdaHistoricalId:'missing'},generation).hint).toContain('unavailable');
  });
  it('combines status, stage, PIC and case-insensitive search without treating literal PIC names as filter commands',()=>{
    const c={status:'draft',values:{...createFfmContractDefaults(),pic:'all',purpose:'Review Products'}} as Contract;
    const progress=getContractProgress(draft,generation);
    const filters={status:'draft',stage:'awaiting-copy',pic:'pic:all',search:'  PRODUCTS  '};
    expect(matchesContractFilters(c,progress,filters)).toBe(true);
    expect(matchesContractFilters(c,progress,{...filters,pic:'unassigned'})).toBe(false);
    expect(matchesContractFilters(c,progress,{...filters,status:'signed'})).toBe(false);
    expect(matchesContractFilters(c,progress,{...filters,stage:'draft'})).toBe(false);
    expect(matchesContractFilters({...c,values:{...c.values,pic:' '}},progress,{...filters,pic:'unassigned'})).toBe(true);
  });
  it('only marks contracts with queued or running job items as generating',()=>{
    const job={status:'running',items:[{contractId:'one',status:'complete'},{contractId:'two',status:'running'}]} as DocumentJob;
    expect(runningContractJob([job],'one')).toBeUndefined();
    expect(runningContractJob([job],'two')).toBe(job);
    expect(runningContractJob([{...job,status:'complete'}],'two')).toBeUndefined();
  });
  it('shows human-readable roles and only requires generation fields',()=>{
    expect(contractFieldLabel('recipient.contact.email')).toBe('Recipient contact email');
    expect(contractFieldLabel('discloser.registrationNumber')).toBe('Discloser registration number');
    expect(generationRequired('recipient.name')).toBe(true);
    expect(generationRequired('agreementDate')).toBe(false);
    expect(generationRequired('pic')).toBe(false);
  });
});
