export function expandSupplierSelection<R extends {id:string},D extends {id:string;linkedNdaId:string|null}>(records:R[],documents:D[],seeds:Set<string>){
  const agreements=new Set(records.filter(r=>seeds.has(`agreement:${r.id}`)).map(r=>r.id));
  const selectedDocuments=new Set(documents.filter(d=>seeds.has(`document:${d.id}`)).map(d=>d.id));
  const active=new Set(records.map(r=>r.id));
  for(const d of documents)if(selectedDocuments.has(d.id)&&d.linkedNdaId&&active.has(d.linkedNdaId))agreements.add(d.linkedNdaId);
  for(const d of documents)if(d.linkedNdaId&&agreements.has(d.linkedNdaId))selectedDocuments.add(d.id);
  return {agreements:records.filter(r=>agreements.has(r.id)),documents:documents.filter(d=>selectedDocuments.has(d.id))};
}
