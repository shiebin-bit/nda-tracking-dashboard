import {useEffect,useState} from 'react';
import type {NdaRecord} from './core';
import {suppliersApi,type Supplier} from './suppliers-api';

export function AgreementSupplier({record,busy,onChanged}:{record:NdaRecord;busy:boolean;onChanged:()=>void}){
  const [suppliers,setSuppliers]=useState<Supplier[]>([]);
  const [selected,setSelected]=useState(record.supplierId??'');
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{let live=true;suppliersApi.list().then(result=>{if(live)setSuppliers(result.suppliers);}).catch(e=>live&&setError(e.message)).finally(()=>live&&setLoading(false));return()=>{live=false;};},[]);
  useEffect(()=>setSelected(record.supplierId??''),[record.supplierId]);
  const save=async()=>{setSaving(true);setError('');try{await suppliersApi.linkRecord(record.id,record.version,selected||null);onChanged();}catch(e){setError(e instanceof Error?e.message:'Supplier could not be linked.');}finally{setSaving(false);}};
  return <section className="detail-section"><h3>Supplier relationship</h3><label className="field">Supplier ID<select disabled={busy||saving||loading} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Supplier not linked</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.supplierCode} · {s.companyName}</option>)}</select></label><p className="caption">Link explicitly. Saved agreement details and files stay unchanged.</p>{error&&<p role="alert" className="error-text">{error}</p>}<button className="button secondary" disabled={busy||saving||loading||selected===(record.supplierId??'')} onClick={()=>void save()}>{saving?'Saving…':'Save supplier link'}</button></section>;
}
