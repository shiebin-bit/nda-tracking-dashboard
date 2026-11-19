import {Check} from 'lucide-react';
import {Badge} from './components';
import type {ContractProgress as Progress} from './contract-workflow';
import type {DocumentType} from './contract-types';

export function ContractProgress({progress,documentType='nda',busy,disabled,onNext}:{progress:Progress;documentType?:DocumentType;busy:boolean;disabled?:boolean;onNext:()=>void}) {
  const steps=['Draft details','Generate files','Upload signed copy',documentType==='eoi'?'Confirm signed':'Confirm & link tracking'];
  return <section className="contract-workflow" aria-label="Contract progress">
    <div className="contract-workflow-next"><div><Badge tone={progress.tone}>{progress.label}</Badge><p>{progress.hint}</p></div><button className="button primary" disabled={busy||disabled} onClick={onNext}>{progress.actionLabel}</button></div>
    <ol>{steps.map((label,index)=>{const done=index<progress.step||(progress.stage==='signed-missing-file'&&index===3);return <li key={label} className={done?'complete':index===progress.step?'current':''} aria-current={index===progress.step?'step':undefined}><span aria-hidden="true">{done?<Check size={13}/>:index+1}</span><span>{label}{done&&<small className="sr-only"> · Complete</small>}</span></li>;})}</ol>
  </section>;
}
