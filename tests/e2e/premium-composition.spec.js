import { test, expect } from '@playwright/test';

async function setup(page, compositionAvailable = true) {
  const requests = [];
  let saved = null;
  const identity = { id:'4c2f26b6-cdd4-4d53-8e37-17e7858c679c', displayName:'Fixture presenter', overallStatus:'READY', avatarStatus:'READY', voiceStatus:'READY', ready:true };
  const reply = (route, body, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/,route=>route.abort());
  await page.route('**/api/video-os-lite/session',r=>reply(r,{ok:true,signedIn:true,account:{accountId:'fixture-owner',name:'Local owner'},credits:{balance:500,reserved:0},entitlements:{fullAccess:true}}));
  await page.route('**/api/video-os-lite/providers',r=>reply(r,{ok:true,providers:[{id:'heygen',configured:true,cost:90,compositionAvailable}]}));
  await page.route('**/api/video-os-lite/identities*',r=>reply(r,{ok:true,identities:[identity]}));
  await page.route('**/api/video-os/talent',r=>reply(r,{ok:true,talent:{avatars:[],voices:[]}}));
  await page.route('**/api/video-os-lite/results*',r=>reply(r,{ok:true,results:[]}));
  await page.route('**/api/video-os-lite/copywriter*',r=>reply(r,{ok:true,available:false}));
  await page.route('**/api/video-os-lite/projects',async r=>{
    if(r.request().method()==='GET') return reply(r,{ok:true,projects:saved?[saved]:[]});
    saved={...r.request().postDataJSON(),id:'fixture-project'};
    return reply(r,{ok:true,project:saved},201);
  });
  await page.route('**/api/video-os-lite/render',r=>{
    requests.push(r.request().postDataJSON());
    if(requests.length===1) return r.abort('failed');
    return reply(r,{ok:true,job:{id:'fixture-job',status:'PROCESSING',tier:'PREMIUM'}},202);
  });
  await page.goto('/');
  await page.locator('#premium-tab').click();
  await page.locator(`[data-premium-identity-id="${identity.id}"]`).click();
  await page.locator('#premium-title').fill('Owner composition preview');
  await page.locator('#script-input').fill('An authorized synthetic script for the local preview.');
  return {requests, saved:()=>saved};
}

test('Premium selections drive preview, saved project and identical recovery payload',async({page})=>{
  const f=await setup(page);
  await expect(page.locator('#premium-composition-enabled')).not.toBeChecked();
  await page.locator('#premium-composition-enabled').check();
  await expect(page.locator('#export-format')).toHaveValue('landscape');
  await page.locator('#premium-background').selectOption('ember-halo');
  await page.locator('#premium-layout').selectOption('cinematic-overlay');
  await expect(page.locator('#premium-composition-preview')).toHaveAttribute('data-background-id','ember-halo');
  await expect(page.locator('#premium-composition-preview')).toHaveAttribute('data-layout-id','cinematic-overlay');
  await expect(page.locator('#premium-composition-caption')).toContainText('not a generated video');
  await page.locator('#generate-video').click();
  await expect(page.locator('#generate-video')).toHaveText('Recover Premium submission');
  await expect(page.locator('#premium-background')).toBeDisabled();
  await expect(page.locator('#premium-layout')).toBeDisabled();
  const selection={contractVersion:'premium-composition-v1',backgroundId:'ember-halo',layoutId:'cinematic-overlay'};
  expect(f.requests[0].productionKit.composition).toEqual(selection);
  expect(f.saved().settings).toEqual({format:'landscape',composition:selection});
  await page.locator('#generate-video').click();
  await expect.poll(()=>f.requests.length).toBe(2);
  expect(f.requests[1]).toEqual(f.requests[0]);
  await page.reload();
  await page.locator('#premium-tab').click();
  await expect(page.locator('#premium-composition-enabled')).toBeChecked();
  await expect(page.locator('#premium-background')).toHaveValue('ember-halo');
  await expect(page.locator('#premium-layout')).toHaveValue('cinematic-overlay');
});

test('unconfigured composition can be previewed but cannot submit; legacy Premium stays available',async({page})=>{
  const f=await setup(page,false);
  await expect(page.locator('#generate-video')).toBeEnabled();
  await page.locator('#premium-composition-enabled').check();
  await expect(page.locator('#generate-video')).toBeDisabled();
  await expect(page.locator('#premium-status')).toContainText('not configured');
  expect(f.requests).toHaveLength(0);
  await page.locator('#premium-composition-enabled').uncheck();
  await expect(page.locator('#generate-video')).toBeEnabled();
  await page.locator('#generate-video').click();
  await expect.poll(()=>f.requests.length).toBe(1);
  expect(f.requests[0].productionKit).toEqual({});
});

test('composition supports landscape only and preview fits a narrow screen',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const f=await setup(page);
  await page.locator('#premium-composition-enabled').check();
  await page.locator('#export-format').selectOption('square');
  await expect(page.locator('#generate-video')).toBeDisabled();
  await expect(page.locator('#premium-status')).toContainText('landscape');
  await page.locator('#export-format').selectOption('landscape');
  await expect(page.locator('#generate-video')).toBeEnabled();
  const box=await page.locator('#premium-composition-preview').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(390);
  expect(f.requests).toHaveLength(0);
});

