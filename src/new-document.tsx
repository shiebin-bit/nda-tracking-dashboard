import {useState} from 'react';
import {ArrowRight,FileText} from 'lucide-react';
import {Badge,Empty,Modal,SearchBox} from './components';
import type {ContractTemplate,TemplateFamily} from './contract-types';

export function NewDocumentDialog({families,templates,onChoose,onClose}:{families:TemplateFamily[];templates:ContractTemplate[];onChoose:(family:TemplateFamily)=>void;onClose:()=>void}){
  const [search,setSearch]=useState('');
  const available=families.filter(f=>f.active&&f.publishedTemplateId);
  const filtered=available.filter(f=>`${f.name} ${f.documentType} ${f.format}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Modal title="New document" onClose={onClose} wide><div className="dialog-body">
    <p className="dialog-intro">Choose a template to start. You can select the supplier and project on the next page.</p>
    <SearchBox value={search} onChange={setSearch} placeholder="Search templates…"/>
    <div className="document-template-options">{filtered.map(f=>{const published=templates.find(t=>t.id===f.publishedTemplateId);return <button key={f.id} className="document-template-option" onClick={()=>onChoose(f)}>
      <FileText size={22}/><span><strong>{f.name}</strong><small>{f.documentType==='nda'?'Confidentiality agreement · Starts tracking after signature':'Expression of interest · Signed file record only'}</small><span className="badge-row"><Badge tone="gray">{f.documentType.toUpperCase()}</Badge><span>{f.format==='pdf'?'PDF only':'Word & PDF'}{published?` · Version ${published.version}`:''}</span></span></span><ArrowRight size={18}/>
    </button>;})}</div>
    {!filtered.length&&<Empty title={available.length?'No matching templates':'No published templates'}>{available.length?'Try a different template name.':'Publish a template in Templates before creating a document.'}</Empty>}
  </div><div className="dialog-actions"><button className="button secondary" onClick={onClose}>Cancel</button></div></Modal>;
}
