import { expect, test, type Page, type Route } from '@playwright/test';
import { FarmCommandCenter, FarmWorkspace, FarmAlerts, FarmSummary } from '@harvest/contracts';
import { FIXTURE_BOUNDARY } from '../src/workspace/today/fixtures';
test.use({serviceWorkers:'block'});
// Every API and tile request is intercepted. These tests never use a real guest workspace or paid provider.
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const date='2026-11-03',asOf=`${date}T04:30:00Z`;
const envelope=(data:unknown,error:unknown=null)=>({requestId:'all-farms-test',mode:'synthetic',asOf,data,warnings:[],error});
const farm=(id:string)=>({id,name:id===A?'Farm Alpha':'Farm Beta',location:{districtId:null,districtName:'Hassan',stateCode:'IN-KA',precision:'district'},areaHectares:id===A?2:3,facts:{}});
const cycle={id:'cycle-a',cropId:'maize',cropName:'Maize',fieldId:'field-a',sowingDate:'2026-09-01',establishmentMethod:'direct_sowing',stage:'growing'};
const workspace=(id:string,noMap=false)=>FarmWorkspace.parse({farmId:id,version:1,updatedAt:asOf,boundary:id===A&&!noMap?FIXTURE_BOUNDARY:null,previousHarvest:{status:'unknown'},cycles:id===A&&!noMap?[cycle]:[],rotationPlans:[],fields:id===A&&!noMap?[{id:'field-a',name:'North field',boundary:FIXTURE_BOUNDARY}]:[]});
const quotes={checkedAt:asOf,selectionBasis:'none',providerStatus:'unavailable',missingReason:'fixture',status:'unavailable',requestLimit:6,requestsMade:0,products:[],limitations:[]};
const task={id:'check-a',actionId:'check',cycleId:'cycle-a',cropId:'maize',title:'Inspect Alpha field moisture',action:'Inspect in person.',anchor:'direct_sowing',dueFrom:date,dueTo:date,conditions:[],sourceRefs:[],status:'due',completedOn:null,journalEntryId:null,evidenceState:'source_schedule'};
const command=(id:string,noMap=false)=>FarmCommandCenter.parse({farmId:id,asOf,workspace:workspace(id,noMap),focusedCrops:[],sources:[],currentCycles:id===A?[{cycle,careTasks:[task],limitations:[]}]:[],soil:{markers:{farmId:id,samples:[],limitations:[]},fit:[]},weather:{kind:'forecast',status:'unavailable',reason:'fixture',issuedAt:null,source:'Fixture',days:[]},currentQuotes:quotes,priorYearMarkets:[],limitations:[]});
const alerts=(id:string)=>FarmAlerts.parse({farmId:id,asOf:date,alerts:[{id:id===A?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',farmId:id,type:'weather',severity:'watch',origin:'rule',title:id===A?'Alpha rain alert':'Beta rain alert',detail:'Fixture only',source:{name:'Fixture forecast',url:'https://example.org/weather',date},validFrom:date,validTo:'2026-11-05',suggestedStep:null,createdAt:asOf}],imdStatus:'not_connected',newsReview:{status:'not_run',reason:null,lastReviewedAt:null},limitations:[]});
const summary=(id:string,over:Record<string,unknown>={})=>FarmSummary.parse({farmId:id,scope:'farm',status:'ready',origin:'deterministic',headline:id===A?'Alpha records show one field with maize.':'Beta has no growing crop recorded.',points:[{kind:'do_now',text:id===A?'Review the saved moisture check.':'Add a growing crop when planting is confirmed.',factIds:['records'],ref:null}],facts:[{id:'records',text:id===A?'One saved field has an active maize cycle.':'No active crop cycle is recorded.',ref:null}],asOf,generatedAt:null,canGenerate:false,retryAfter:null,...over});
type Options={holdA?:boolean;failB?:boolean;noMap?:boolean;empty?:boolean;farmsError?:boolean;holdSummaryA?:boolean;failSummaryB?:boolean;generateSummary?:boolean};
async function mock(page:Page,options:Options={}) {
 const requests:{path:string;method:string}[]=[];const held:{route:Route;part:string}[]=[];let holding=!!options.holdA, identityChanged=false, generated=false, summaryFailed=!!options.failSummaryB;
 const heldSummaries:Route[]=[]; let summaryHolding=!!options.holdSummaryA;
 await page.addInitScript(()=>localStorage.removeItem('ho.selectedFarm'));
 await page.route('https://**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=','base64')}));
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method(),id=path.includes(B)?B:A;requests.push({path,method});
  if(path.endsWith('/summary')){
   if(id===A&&summaryHolding&&method==='GET'){heldSummaries.push(route);return;}
   if(id===B&&summaryFailed)return route.fulfill({status:503,json:envelope(null,{code:'unavailable',message:'Fixture summary unavailable'})});
   if(options.generateSummary&&id===A){
    if(method==='POST'){generated=true;return route.fulfill({status:202,json:envelope(summary(id,{status:'pending',retryAfter:'2026-11-03T04:30:03Z'}))});}
    if(generated)return route.fulfill({json:envelope(summary(id,{origin:'model',headline:'Alpha summary: review the saved moisture check before irrigation.',generatedAt:asOf}))});
    return route.fulfill({json:envelope(summary(id,{canGenerate:true}))});
   }
   return route.fulfill({json:envelope(summary(id,options.noMap?{headline:'No fields or growing crops are recorded.',points:[],facts:[]}:{}))});
  }
  if(path==='/api/v1/farms'&&options.farmsError)return route.fulfill({status:503,json:envelope(null,{code:'unavailable',message:'Fixture unavailable'})});
  if(path.endsWith('/workspace')&&id===B&&options.failB)return route.fulfill({status:503,json:envelope(null,{code:'unavailable',message:'Fixture unavailable'})});
  if(holding&&id===A&&(path.endsWith('/alerts')||path.endsWith('/command-center'))){held.push({route,part:path.endsWith('/alerts')?'alerts':'command-center'});return;}
  const data=path==='/api/v1/session'?{authenticated:true,csrfToken:'fixture'}:path==='/api/v1/farms'?{farms:options.empty?[]:identityChanged?[farm(B)]:[farm(A),farm(B)]}:path.endsWith('/workspace')?workspace(id,options.noMap):path.endsWith('/alerts')?alerts(id):path.endsWith('/command-center')?command(id,options.noMap):path.endsWith('/market-quotes')?quotes:path.endsWith('/monitoring')?{checkedAt:asOf,weather:{status:'unavailable',reason:'fixture',issuedAt:null,attribution:'Fixture',point:null,days:[]},market:{status:'unavailable',reason:'fixture',products:[]},meta:{status:'unavailable',reason:'fixture',automatic:false}}:path==='/api/v1/crops'?{crops:[{cropId:'maize',name:'Maize',products:[]}]}:path==='/api/v1/capabilities'?{mode:'synthetic',models:{text:'fixture',escalation:'fixture',image:'fixture',segment:'fixture',speechToText:null,textToSpeech:null},providers:{meta:false},languages:['en'],database:{reachable:true,postgis:false},limits:{maxUploadImageBytes:1000000,maxVoiceSeconds:60}}:path==='/api/v1/ai/activity'?{invocations:[]}:{};
  return route.fulfill({json:envelope(data)});
 });
 return {requests,held,heldSummaries,recoverSummary(){summaryFailed=false;},async releaseSummaryA(){summaryHolding=false;for(const route of heldSummaries)await route.fulfill({json:envelope(summary(A,{origin:'model',headline:'Old Alpha AI summary',generatedAt:asOf}))});},changeIdentity(){identityChanged=true;},async releaseA(){holding=false;for(const h of held)await h.route.fulfill({json:envelope(h.part==='alerts'?alerts(A):command(A,options.noMap))});}};
}
const row=(page:Page,name:string)=>page.getByRole('button',{name:new RegExp(`^${name}`)}).filter({has:page.locator('strong')});
for(const width of [1440,390])test(`real totals and geometry, no overflow at ${width}`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:width===390?844:1000});await page.emulateMedia({colorScheme:'light'});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const state=await mock(page);await page.goto('/farms');
 await expect(page.getByRole('heading',{name:'All farms, one perspective.'})).toBeVisible();await expect(page.locator('.af-totals')).toContainText('Active fields');await expect(page.locator('.af-totals')).toContainText('2Farms');await expect(page.locator('.af-map svg path')).toHaveCount(1);await expect(page.locator('.af-map .af-pin')).toHaveText(['01Farm Alpha']);await expect(page.locator('.af-map .af-pin.is-selected')).toHaveCount(1);
 // Open reviews = stored alerts + due or overdue care tasks across farms: Alpha 1 alert + 1 due task, Beta 1 alert.
 await expect(page.locator('.af-totals')).toContainText('3Open reviews');await expect(row(page,'Farm Alpha').locator('.af-status')).toHaveText('Review due');await expect(row(page,'Farm Alpha').locator('.af-farm-number')).toHaveText('01');await expect(page.locator('.af-priorities')).toContainText('2 to review');
 const selectedCard=page.getByRole('region',{name:'Selected farm summary'});await expect(selectedCard.getByRole('link',{name:'Open field map'})).toHaveAttribute('href','/farm?tab=modify');await expect(selectedCard.getByRole('link',{name:'Alerts & actions'})).toHaveAttribute('href','/farm?tab=actions');await expect(page.locator('.af-map')).toContainText('1 of 2 farms located');await expect(page.locator('.af-map .leaflet-control-attribution')).toContainText('Esri');
 await expect(page.locator('.af-priorities')).toContainText('Alpha rain alert');await row(page,'Farm Beta').click();await expect(page.locator('.af-selected')).toContainText('Farm Beta');await expect(page.locator('.af-priorities')).toContainText('Beta rain alert');await expect(page.locator('.af-priorities')).not.toContainText('Alpha rain alert');
 expect(state.requests.some(r=>r.path.endsWith('/today'))).toBe(false);expect(state.requests.filter(r=>r.method!=='GET')).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.getByRole('button',{name:'Dark mode',exact:true})).toHaveCount(0);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:testInfo.outputPath(`all-farms-${width}-dark.png`),fullPage:true});expect(errors).toEqual([]);
});
test('late priorities from previous farm never replace selected farm',async({page})=>{
 const state=await mock(page,{holdA:true});await page.goto('/farms');await expect.poll(()=>state.held.length).toBe(2);await row(page,'Farm Beta').click();await expect(page.locator('.af-priorities')).toContainText('Beta rain alert');await state.releaseA();await expect(page.locator('.af-priorities')).not.toContainText('Alpha rain alert');await expect(page.locator('.af-priorities')).toContainText('Farm Beta only');
});
test('partial workspace failure stays unknown and task link retains field',async({page})=>{
 await mock(page,{failB:true});await page.goto('/farms');await expect(page.locator('.af-load-note')).toContainText('Counts remain partial');await expect(page.locator('.af-totals')).toContainText('1/2 farms loaded');await expect(row(page,'Farm Beta')).toContainText('Fields unavailable');await expect(row(page,'Farm Beta').locator('.af-status')).toHaveText('Unavailable');await expect(page.locator('.af-totals')).toContainText('Open reviews · partial');await page.getByRole('button',{name:'Today’s tasks',exact:true}).click();await page.getByRole('button',{name:/Inspect Alpha field moisture/}).click();await expect(page).toHaveURL(/\/farm\?tab=actions&field=field-a$/);
 const tabs=page.getByRole('navigation',{name:'Farm views'});
 await expect(tabs.getByRole('link',{name:'Modify',exact:true})).toHaveAttribute('href','/farm?tab=modify&field=field-a');
 await tabs.getByRole('link',{name:'Modify',exact:true}).click();
 await expect(page).toHaveURL(/tab=modify&field=field-a$/);
 await expect(tabs.getByRole('link',{name:'Modify',exact:true})).toHaveAttribute('aria-current','page');
 await tabs.getByRole('link',{name:'Today',exact:true}).click();
 await expect(page).toHaveURL(/tab=today&field=field-a$/);

});
test('no geometry gives honest map fallback without geographic placeholders',async({page})=>{
 const state=await mock(page,{noMap:true});await page.goto('/farms');await expect(page.getByText('No saved map locations yet')).toBeVisible();await expect(page.locator('.af-map .leaflet-marker-icon')).toHaveCount(0);expect(state.requests.some(r=>r.path.endsWith('/today'))).toBe(false);
});
test('empty farms and farm list failure preserve useful states',async({page})=>{
 await mock(page,{empty:true});await page.goto('/farms');await expect(page.getByRole('heading',{name:'Your growing world starts here'})).toBeVisible();await expect(page.getByRole('link',{name:'Add your first farm'})).toHaveAttribute('href','/farm/setup');
});
test('farm list failure is an error, never an empty farm count',async({page})=>{
 await mock(page,{farmsError:true});await page.goto('/farms');await expect(page.getByRole('heading',{name:'Your farms could not load'})).toBeVisible();await expect(page.locator('.af-totals')).toHaveCount(0);
});

test('session change drops previous owner pending priorities',async({page})=>{
 const state=await mock(page,{holdA:true});await page.goto('/farms');await expect.poll(()=>state.held.length).toBe(2);state.changeIdentity();await page.evaluate(()=>window.dispatchEvent(new Event('ho:session-ended')));await expect(page.locator('.af-priorities')).toContainText('Beta rain alert');await state.releaseA();await expect(page.locator('.af-priorities')).not.toContainText('Alpha rain alert');await expect(page.locator('.af-farm-row')).toHaveCount(1);
});

test('farm summaries stay keyed to the farm when an older selection answers late',async({page})=>{
 const state=await mock(page,{holdSummaryA:true});await page.goto('/farms');await expect.poll(()=>state.heldSummaries.length).toBe(1);
 const selected=page.getByRole('region',{name:'Selected farm summary'});await expect(selected).toContainText('Reading this farm’s summary');await row(page,'Farm Beta').click();
 await expect(selected).toContainText('Beta has no growing crop recorded.');
 await state.releaseSummaryA();await expect(selected).not.toContainText('Old Alpha');await expect(selected).toContainText('Farm records');
 // The late Alpha answer is kept under Alpha: it shows once Alpha is selected again.
 await row(page,'Farm Alpha').click();await expect(selected).toContainText('Old Alpha AI summary');
 expect(state.requests.some(request=>request.path.endsWith('/today'))).toBe(false);
});
test('per-farm generation posts once, polls the pending summary and reveals the supporting facts',async({page},testInfo)=>{
 const state=await mock(page,{generateSummary:true});await page.goto('/farms');const selected=page.getByRole('region',{name:'Selected farm summary'});
 await expect(selected).toContainText('Preparing the AI summary');await expect(selected).toContainText('Farm records');
 await expect(selected).toContainText('Alpha summary: review the saved moisture check before irrigation.',{timeout:10000});await expect(selected).toContainText('AI summary');await expect(selected).toContainText('Generated');
 expect(state.requests.filter(request=>request.method==='POST').map(request=>request.path)).toEqual([`/api/v1/farms/${A}/summary`]);
 await selected.locator('summary').click();await expect(selected).toContainText('One saved field has an active maize cycle.');
 await row(page,'Farm Beta').click();await row(page,'Farm Alpha').click();await expect(selected).toContainText('Alpha summary:');expect(state.requests.filter(request=>request.method==='POST')).toHaveLength(1);
 await page.screenshot({path:testInfo.outputPath('all-farms-ai-summary.png'),fullPage:true});expect(state.requests.some(request=>request.path.endsWith('/today'))).toBe(false);
});
test('summary read failures retry without making unavailable records look like model output',async({page})=>{
 const state=await mock(page,{failSummaryB:true});await page.goto('/farms');await row(page,'Farm Beta').click();const selected=page.getByRole('region',{name:'Selected farm summary'});
 await expect(selected).toContainText('unavailable');await expect(selected).not.toContainText('AI summary');state.recoverSummary();await selected.getByRole('button',{name:'Retry summary'}).click();
 await expect(selected).toContainText('Beta has no growing crop recorded.');await expect(selected).toContainText('Farm records');
 await selected.getByRole('link',{name:'Alerts & actions'}).click();await expect(page).toHaveURL(/\/farm\?tab=actions$/);
});
test('session change discards a previous owner summary response',async({page})=>{
 const state=await mock(page,{holdSummaryA:true});await page.goto('/farms');await expect.poll(()=>state.heldSummaries.length).toBe(1);state.changeIdentity();
 await page.evaluate(()=>window.dispatchEvent(new Event('ho:session-ended')));await expect(page.locator('.af-farm-row')).toHaveCount(1);await state.releaseSummaryA();
 await expect(page.locator('.af-selected')).not.toContainText('Old Alpha');await expect(page.getByRole('region',{name:'Selected farm summary'})).toContainText('Beta has no growing crop recorded.');
});

for(const width of [1440,2048,390])test(`More stays an anchored vertical dropdown at ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:width===390?844:1000});const state=await mock(page);await page.goto('/farms');
 await expect(page.getByRole('heading',{name:'All farms, one perspective.'})).toBeVisible();const more=page.getByRole('button',{name:'More',exact:true});
 const header=page.locator('.topbar'),before=(await header.boundingBox())!,anchor=(await more.boundingBox())!;
 await more.focus();await more.press('Enter');await expect(more).toHaveAttribute('aria-expanded','true');const menu=page.locator('#more-menu-panel');await expect(menu).toBeVisible();
 expect(await menu.evaluate(el=>getComputedStyle(el).position)).toBe('absolute');const box=(await menu.boundingBox())!,after=(await header.boundingBox())!;
 expect(after.height).toBe(before.height);expect(after.width).toBe(before.width);expect(Math.abs(box.x+box.width-anchor.x-anchor.width)).toBeLessThanOrEqual(1);
 expect(box.y).toBeGreaterThanOrEqual(anchor.y+anchor.height);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
 const links=menu.getByRole('link'),bounds=await links.evaluateAll(elements=>elements.map(el=>{const b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};}));
 expect(bounds).toHaveLength(8);for(let i=0;i<bounds.length;i++){expect(bounds[i]!.height).toBeGreaterThanOrEqual(44);if(i){expect(bounds[i]!.y).toBeGreaterThanOrEqual(bounds[i-1]!.y+bounds[i-1]!.height);expect(bounds[i]!.x).toBe(bounds[0]!.x);}}
 // A point in the last link must hit the dropdown rather than content or a clipped header.
 const last=bounds.at(-1)!;expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('#more-menu-panel'),{x:last.x+20,y:last.y+last.height/2})).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.keyboard.press('Tab');await expect(links.first()).toBeFocused();
 if(width>=1440)await page.screenshot({path:testInfo.outputPath(`more-open-${width}.png`)});
 await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
 await more.click();await page.getByRole('heading',{name:'All farms, one perspective.'}).click({position:{x:1,y:1}});await expect(menu).toHaveCount(0);
 await more.click();await page.locator('.af-heading').getByRole('link',{name:'Add a farm',exact:true}).focus();await expect(menu).toHaveCount(0);
 expect(state.requests.filter(request=>request.method!=='GET')).toEqual([]);
});
