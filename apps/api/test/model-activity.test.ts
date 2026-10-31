import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {setupHarness,login,type Harness,type Client} from './helpers';
import {withModelActivity} from '../src/services/model-activity';
import {MetaClient} from '../src/providers/meta/client';
import {callSam} from '../src/vision/sam/client';
import {DEFAULT_SAM_OPTIONS} from '../src/vision/sam/options';
import {editImage} from '../src/visuals/muse-image';
let h:Harness,a:Client,b:Client,ownerId:string,sessionId:string;
beforeAll(async()=>{h=await setupHarness();a=await login(h.app);b=await login(h.app);const s=(await h.pool.query('SELECT id,owner_id FROM sessions ORDER BY created_at LIMIT 1')).rows[0];ownerId=s.owner_id;sessionId=s.id;});
afterAll(async()=>h?.close());
const context=()=>({pool:h.pool,ownerId,sessionId,mode:'live',purpose:'assistant'});
const response=()=>new Response(JSON.stringify({id:'response-test',model:'muse-spark-1.3',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Synthetic test response'}]}],usage:{input_tokens:1,output_tokens:1}}),{status:200});
describe('actual Meta transport invocation tracking',()=>{
 it('shows text invocation only while actual transport is pending, isolates owner/session, and records received model',async()=>{
  let release:((r:Response)=>void)|undefined;const client=new MetaClient({apiKey:'fixture-key',baseUrl:'https://fixture.invalid',fetchImpl:async()=>new Promise<Response>(resolve=>{release=resolve;})});
  const pending=withModelActivity(context(),()=>client.createResponse({model:'muse-spark-1.3',instructions:'test',input:'test',maxOutputTokens:10}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const active=(await a.call('GET','/api/v1/ai/activity')).json().data.invocations;
  expect(active).toHaveLength(1);expect(active[0]).toMatchObject({requestedModel:'muse-spark-1.3',model:null,purpose:'assistant',status:'running'});
  expect((await b.call('GET','/api/v1/ai/activity')).json().data.invocations).toEqual([]);
  release!(response());await pending;expect((await a.call('GET','/api/v1/ai/activity')).json().data.invocations).toEqual([]);
  expect((await h.pool.query('SELECT status,model FROM ai_invocations WHERE id=$1',[active[0].id])).rows[0]).toEqual({status:'succeeded',model:'muse-spark-1.3'});
 });
 it('tracks independent SAM and Muse image transports with their actual requested model names',async()=>{
  await withModelActivity({...context(),purpose:'vision.segment'},()=>callSam({baseUrl:'https://fixture.invalid',apiKey:'fixture',model:'sam-3.1',text:'field',imageDataUrl:'data:image/jpeg;base64,AA==',options:{...DEFAULT_SAM_OPTIONS,stream:false},fetchImpl:async()=>new Response(JSON.stringify({output_text:'Synthetic segmentation text'}),{status:200,headers:{'content-type':'application/json'}})}));
  await withModelActivity({...context(),purpose:'visual.generate'},()=>editImage({baseUrl:'https://fixture.invalid',apiKey:'fixture',model:'muse-image-1.0',prompt:'test',imageDataUrl:'data:image/jpeg;base64,AA==',size:'768x768',fetchImpl:async()=>new Response(JSON.stringify({data:[{b64_json:'aW1hZ2U='}]}),{status:200})}));
  const rows=(await h.pool.query("SELECT requested_model,purpose,status FROM ai_invocations WHERE purpose IN('vision.segment','visual.generate') ORDER BY started_at")).rows;
  expect(rows).toEqual([{requested_model:'sam-3.1',purpose:'vision.segment',status:'succeeded'},{requested_model:'muse-image-1.0',purpose:'visual.generate',status:'succeeded'}]);
 });
 it('does not announce synthetic requests or background invocations as foreground activity',async()=>{
  const client=new MetaClient({apiKey:'fixture',baseUrl:'https://fixture.invalid',fetchImpl:async()=>response()});
  const before=(await h.pool.query('SELECT count(*)::int AS n FROM ai_invocations')).rows[0].n;
  await withModelActivity({...context(),mode:'synthetic'},()=>client.createResponse({model:'muse-spark-1.3',instructions:'test',input:'test',maxOutputTokens:10}));
  expect((await h.pool.query('SELECT count(*)::int AS n FROM ai_invocations')).rows[0].n).toBe(before);
  await withModelActivity({...context(),sessionId:null,purpose:'farm.monitor'},()=>client.createResponse({model:'muse-spark-1.3',instructions:'test',input:'test',maxOutputTokens:10}));
  expect((await a.call('GET','/api/v1/ai/activity')).json().data.invocations).toEqual([]);
 });
});
