import {describe,expect,it} from 'vitest';
import {searchOptions} from './searchable-select';
describe('searchable supplier/project options',()=>{
  const options=[{value:'1',label:'090 · X Alpha',search:['090','X Alpha']},{value:'2',label:'0012 · Alpha Supplier',search:['0012','Alpha Supplier']},{value:'3',label:'P-07 · Beta',search:['P-07','Beta']}];
  it('matches IDs with leading zeros and names ignoring case',()=>{expect(searchOptions(options,'001').map(o=>o.value)).toEqual(['2']);expect(searchOptions(options,'BETA').map(o=>o.value)).toEqual(['3']);});
  it('ranks name prefixes before substrings and preserves order',()=>{expect(searchOptions(options,'alpha').map(o=>o.value)).toEqual(['2','1']);expect(searchOptions(options,'')).toEqual(options);expect(searchOptions(options,'missing')).toEqual([]);});
});
