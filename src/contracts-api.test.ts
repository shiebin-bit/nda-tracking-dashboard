import {afterEach,expect,it,vi} from 'vitest';
import {ContractApiError,contractRequest,trackingDifferences} from './contracts-api';

afterEach(()=>vi.unstubAllGlobals());
it('preserves linked tracking differences for an explicit resolution',async()=>{
  const fields=[{field:'Recipient',expected:'Signed client',actual:'Current client'}];
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code:'tracking_mismatch',message:'Review the linked NDA.',details:{fields}}}),{status:409})));
  const error=await contractRequest('/contracts/example/confirm-signed',{}).catch(error=>error);
  expect(trackingDifferences(error)).toEqual(fields);
  expect(error).toBeInstanceOf(ContractApiError);
  expect((error as ContractApiError).status).toBe(409);
  expect(trackingDifferences(new Error('Network unavailable'))).toEqual([]);
});
