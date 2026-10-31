import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool} from '../db/pool';
interface InvocationContext{pool:Pool;ownerId:string;sessionId:string|null;mode:string;purpose:string}
const context=new AsyncLocalStorage<InvocationContext>();
export function withModelActivity<T>(value:InvocationContext,run:()=>Promise<T>):Promise<T>{return context.run(value,run);}
/** Called at real Meta transport boundaries, after cache/budget gates. Deterministic work never enters. */
export async function trackMetaInvocation<T>(requestedModel:string,run:()=>Promise<T>,receivedModel?:(value:T)=>string|null):Promise<T>{
 const current=context.getStore();if(!current||current.mode!=='live')return run();
 const row=(await current.pool.query<{id:string}>("INSERT INTO ai_invocations(owner_id,session_id,provider,requested_model,purpose,status) VALUES($1,$2,'meta',$3,$4,'running') RETURNING id",[current.ownerId,current.sessionId,requestedModel,current.purpose])).rows[0]!;
 let status='failed',model:string|null=null;
 try{const result=await run();model=receivedModel?.(result)??null;status='succeeded';return result;}
 finally{await current.pool.query('UPDATE ai_invocations SET status=$2,model=$3,finished_at=now() WHERE id=$1',[row.id,status,model]).catch(()=>undefined);}
}
