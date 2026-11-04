import {ApiError} from './storage';
import type {EmailDelivery,EmailStatus,ReminderSummary} from './email-types';

async function request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/email${path}`,{
    method:body===undefined?'GET':'POST',credentials:'same-origin',
    headers:body===undefined?undefined:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),
    signal,
  });
  const payload=await response.json().catch(()=>null);
  if(!response.ok)throw new ApiError(payload?.error?.message??`Email request failed (${response.status}).`,response.status,payload?.error?.code);
  if(!payload||typeof payload!=='object')throw new ApiError('The server returned an invalid email response.',502,'invalid_response');
  return payload as T;
}

export const emailApi={
  summary:(signal?:AbortSignal)=>request<ReminderSummary>('/summary',undefined,signal),
  status:()=>request<EmailStatus>('/status'),
  deliveries:async()=>{const result=await request<{deliveries:EmailDelivery[]}>('/deliveries');return result.deliveries;},
  test:async(recipientEmail:string,requestId:string)=>{const result=await request<{delivery:EmailDelivery}>('/test',{recipientEmail,requestId});return result.delivery;},
  retry:async(id:string,requestId:string)=>{const result=await request<{delivery:EmailDelivery}>(`/deliveries/${encodeURIComponent(id)}/retry`,{requestId});return result.delivery;},
};
