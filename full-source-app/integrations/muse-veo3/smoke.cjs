const {app,BrowserWindow,protocol,session}=require('electron');
const {readFile}=require('node:fs/promises');
const path=require('node:path');
const root='D:/muse-superveo-extracted';
protocol.registerSchemesAsPrivileged([{scheme:'muse',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 const ses=session.fromPartition('veo3-integration-smoke');
 ses.webRequest.onBeforeRequest((d,cb)=>cb({cancel:d.url.startsWith('http')}));
 ses.protocol.handle('muse',async request=>{
  const name=new URL(request.url).pathname;
  const file=name==='/veo3-integration/client.js'?path.join(__dirname,'client.js'):path.resolve(root,'.'+name);
  try{return new Response(await readFile(file),{headers:{'Content-Type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'}});}catch{return new Response('',{status:404});}
 });
 const win=new BrowserWindow({show:false,webPreferences:{partition:'veo3-integration-smoke'}});
 win.webContents.on('console-message',(_e,_l,m)=>console.log(m));
 await win.loadURL('muse://app/index.html');
 const run=code=>win.webContents.executeJavaScript(code);
 for(let i=0;i<100;i++){if(await run('!!window.__MUSE_STORE__'))break;await new Promise(r=>setTimeout(r,100));}
 await run(`(()=>{window.mockCalls=[];window.museDesktop={invoke:async p=>{mockCalls.push(p);if(p.action==='projects')return [{id:'source',name:'Test profile',profiles:[{id:'p'}]}];if(p.action==='submit')return {projectId:'remote',jobs:[{id:'job',profileName:'Profile test'}]};if(p.action==='poll')return {jobs:[{id:'job',status:'COMPLETED',url:'data:image/png;base64,test',profileName:'Profile test'}]};return {};}};const s=__MUSE_STORE__.getState();const id=s.createProject('Veo3 smoke','text-to-image');s.setActiveProject(id);})()`);
 await new Promise(r=>setTimeout(r,1200));
 await run(`(()=>{const s=document.querySelector('[data-provider]');if(!s)throw Error('Missing provider selector');s.value='veo3';s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-refresh]').click();})()`);
 await new Promise(r=>setTimeout(r,200));
 await run(`(()=>{const p=document.querySelector('select[data-project]');p.value='source';p.dispatchEvent(new Event('change',{bubbles:true}));const t=[...document.querySelectorAll('#muse-root textarea')].find(t=>!t.dataset.musePoolSource);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'test prompt');t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-run]').click();})()`);
 await new Promise(r=>setTimeout(r,1000));
 console.log('DIAGNOSTIC',await run(`JSON.stringify({message:document.querySelector('[data-message]')?.textContent,project:__MUSE_STORE__.getState().projects[__MUSE_STORE__.getState().activeProjectId],calls:mockCalls.filter(c=>c.cmd==='muse_veo3')})`));
 const result=await run(`(()=>{const s=__MUSE_STORE__.getState();const p=s.projects[s.activeProjectId];const sent=mockCalls.find(c=>c.action==='submit');if(!sent||sent.ratio!=='16:9'||p.jobs[0]?.status!=='done'||p.jobs[0]?.imageProvider!=='veo3')throw Error('Submission/result check failed '+JSON.stringify({sent,jobs:p.jobs}));return {provider:p.imageProvider,status:p.jobs[0].status,ratio:sent.ratio,badge:document.querySelector('[data-muse-cookie-badge]')?.textContent};})()`);
 console.log('VEO3_SMOKE_OK',JSON.stringify(result));clearTimeout(timeout);app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
