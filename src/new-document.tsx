import {useState} from 'react';
import {ArrowRight,FileText} from 'lucide-react';
import {Badge,Empty,Modal,SearchBox} from './components';
import type {ContractTemplate,TemplateFamily} from './contract-types';

export function NewDocumentDialog({families,templates,onChoose,onClose}:{families:TemplateFamily[];templates:ContractTemplate[];onChoose:(family:TemplateFamily,templateId:string)=>void;onClose:()=>void}){
  const [search,setSearch]=useState('');
  const [familyId,setFamilyId]=useState('');const [versionId,setVersionId]=useState('');
  const available=families.filter(f=>f.active&&f.publishedTemplateId);
  const chosen=available.find(f=>f.id===familyId);
  const versions=templates.filter(t=>t.familyId===familyId);
  const version=versions.find(t=>t.id===versionId);
  const filtered=available.filter(f=>`${f.name} ${f.documentType} ${f.format}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Modal title="New document" onClose={onClose} wide><div className="dialog-body">
    <p className="dialog-intro">Choose a template, then its published version. Supplier and project details are filled on the next page.</p>
    <SearchBox value={search} onChange={setSearch} placeholder="Search templates…"/>
    <div className="document-template-options">{filtered.map(f=>{const published=templates.find(t=>t.id===f.publishedTemplateId);return <button key={f.id} aria-pressed={familyId===f.id} className="document-template-option" onClick={()=>{setFamilyId(f.id);setVersionId(f.publishedTemplateId??'');}}>
      <FileText size={22}/><span><strong>{f.name}</strong><small>{f.documentType==='nda'?'Confidentiality agreement · Starts tracking after signature':'Expression of interest · Signed file record only'}</small><span className="badge-row"><Badge tone="gray">{f.documentType.toUpperCase()}</Badge><span>{f.format==='pdf'?'PDF only':'Word & PDF'}{published?` · Version ${published.version}`:''}</span></span></span><ArrowRight size={18}/>
    </button>;})}</div>
    {!filtered.length&&<Empty title={available.length?'No matching templates':'No published templates'}>{available.length?'Try a different template name.':'Publish a template in Templates before creating a document.'}</Empty>}
    {chosen&&<label className="field new-document-version">Published version · {chosen.name}<select value={versionId} onChange={e=>setVersionId(e.target.value)}>{versions.map(t=><option key={t.id} value={t.id}>Version {t.version}{t.id===chosen.publishedTemplateId?' · Latest published':' · Earlier published'}</option>)}</select><small>This version is selected for generation in the editor. Published versions and existing files stay unchanged.</small></label>}
  </div><div className="dialog-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!chosen||!version} onClick={()=>chosen&&version&&onChoose(chosen,version.id)}>Continue{version?` with version ${version.version}`:''}<ArrowRight size={15}/></button></div></Modal>;
}
