import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {login,setupHarness,type Client,type Harness} from './helpers';

const field={type:'Polygon',coordinates:[[[76.9349,11.0131],[76.9359,11.0131],[76.9359,11.014],[76.9349,11.014],[76.9349,11.0131]]]};
const huge={type:'Polygon',coordinates:[[[75,10],[76,10],[76,11],[75,11],[75,10]]]};
let h:Harness;
beforeAll(async()=>{h=await setupHarness()});
afterAll(async()=>h?.close());
function geoFetch(){return vi.fn(async(request:RequestInfo|URL)=>{
 const url=String(request);let data:unknown;
 if(url.includes('geoboundaries.org')){const level=url.includes('ADM1')?'ADM1':'ADM2';data={simplifiedGeometryGeoJSON:`https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/${level}/test.geojson`,boundaryLicense:'Test fixture licence',boundarySource:'Synthetic test geometry',boundaryYearRepresented:level==='ADM1'?'2011':'2021'};}
 else if(url.includes('github.com'))data={type:'FeatureCollection',features:[{properties:{shapeName:url.includes('ADM1')?'Tamil Nadu':'Coimbatore'},geometry:{type:'Polygon',coordinates:[[[75,10],[79,10],[79,13],[75,13],[75,10]]]}}]};
 else throw new Error('Unexpected provider request');
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
});}
async function liveClient(f:ReturnType<typeof geoFetch>):Promise<Client>{
 const app=await h.make({RUNTIME_MODE:'live',MODEL_API_KEY:'test-fixture-key'},{weatherFetch:f as never});return login(app);
}
describe('POST /api/v1/boundary-context (onboarding state/district prefill)',()=>{
 it('resolves state, district and a suggested name from the drawn boundary in live mode, with no model call',async()=>{
  const f=geoFetch();const c=await liveClient(f);
  const res=await c.call('POST','/api/v1/boundary-context',{payload:{boundary:field}});
  expect(res.statusCode).toBe(200);const data=res.json().data;
  expect(data.location).toMatchObject({status:'resolved',stateId:'IN-TN',stateName:'Tamil Nadu',districtName:'Coimbatore'});
  expect(data.suggestedName).toBe('Coimbatore field');expect(data.areaHectares).toBeGreaterThan(0);
  for(const [request] of f.mock.calls)expect(String(request)).toMatch(/geoboundaries\.org|github\.com/);
 });
 it('refuses boundaries above 5000 hectares before any public lookup',async()=>{
  const f=geoFetch();const c=await liveClient(f);
  const res=await c.call('POST','/api/v1/boundary-context',{payload:{boundary:huge}});
  expect(res.statusCode).toBe(400);expect(f).not.toHaveBeenCalled();
 });
 it('does not call public sources outside live mode and falls back to an editable default name',async()=>{
  const f=geoFetch();const app=await h.make({},{weatherFetch:f as never});const c=await login(app);
  const res=await c.call('POST','/api/v1/boundary-context',{payload:{boundary:field}});
  expect(res.statusCode).toBe(200);expect(res.json().data.location.status).toBe('unavailable');expect(res.json().data.suggestedName).toBe('My field');expect(f).not.toHaveBeenCalled();
 });
 it('requires a session and CSRF token',async()=>{
  const c=await login(h.app);
  expect((await c.call('POST','/api/v1/boundary-context',{payload:{boundary:field},cookie:null})).statusCode).toBe(401);
  expect((await c.call('POST','/api/v1/boundary-context',{payload:{boundary:field},csrf:null})).statusCode).toBe(403);
 });
});
