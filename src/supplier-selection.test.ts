import {describe,expect,it} from 'vitest';
import {expandSupplierSelection} from './supplier-selection';

describe('explicit supplier assignment selection',()=>{
  const records=[{id:'a'},{id:'b'}];
  const documents=[{id:'first',linkedNdaId:'a'},{id:'second',linkedNdaId:'a'},{id:'eoi',linkedNdaId:null},{id:'other',linkedNdaId:'b'}];
  it('includes a document’s linked agreement and every document sharing it in review',()=>{
    expect(expandSupplierSelection(records,documents,new Set(['document:first']))).toEqual({agreements:[records[0]],documents:documents.slice(0,2)});
  });
  it('includes associated documents when the user starts from an agreement',()=>{
    expect(expandSupplierSelection(records,documents,new Set(['agreement:a']))).toEqual({agreements:[records[0]],documents:documents.slice(0,2)});
  });
  it('keeps unlinked EOI independent and drops unavailable selections',()=>{
    expect(expandSupplierSelection(records,documents,new Set(['document:eoi','agreement:missing']))).toEqual({agreements:[],documents:[documents[2]]});
    expect(expandSupplierSelection(records,documents,new Set())).toEqual({agreements:[],documents:[]});
  });
});
