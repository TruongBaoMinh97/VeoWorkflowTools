import { describe, it, expect } from 'vitest';
import { MuseVeo3Bridge } from '../../../../integrations/muse-veo3/bridge.mjs';

function fixture() {
  const calls=[];
  const bridge=new MuseVeo3Bridge({fetchImpl:async(url,options)=>{
    const body=options.body && JSON.parse(options.body); calls.push({url,body,method:options.method});
    let data={};
    if(url.endsWith('/projects/source'))data={profiles:[{profileId:'p1'},{profileId:'p2'}],imageModelKey:'GEM_PIX_2'};
    else if(url.endsWith('/projects')&&options.method==='POST')data={id:'isolated'};
    else if(url.endsWith('/upload-image'))data={mediaId:'media-'+body.profileId};
    else if(url.endsWith('/jobs'))data={jobs:[{id:'j2',jobIndex:1},{id:'j1',jobIndex:0}]};
    return {ok:true,json:async()=>data};
  }});
  return {bridge,calls};
}
const payload={action:'submit',museProjectId:'m',sourceProjectId:'source',prompts:['one','two'],ratio:'16:9',references:[{dataBase64:'fixture'}],referenceIndices:[[0],[0]]};
describe('Muse optional Veo3 adapter',()=>{
  it('isolates batches, uploads once per profile and preserves prompt order',async()=>{
    const {bridge,calls}=fixture();const result=await bridge.invoke(payload);
    expect(result.jobs.map(j=>j.id)).toEqual(['j1','j2']);
    expect(calls.filter(c=>c.url.endsWith('/upload-image'))).toHaveLength(2);
    const batch=calls.find(c=>c.url.endsWith('/submit-storyboard-image-batch'));
    expect(batch.url).toContain('/isolated/');expect(batch.body.appendJobs).toBe(true);
    expect(batch.body.perJobReferenceImageMediaIdsByProfile).toEqual([[{p1:'media-p1',p2:'media-p2'}],[{p1:'media-p1',p2:'media-p2'}]]);
    expect(calls.at(-1).url).toContain('/isolated/start-generation');
  });
  it('rejects invalid references before contacting the service',async()=>{
    const {bridge,calls}=fixture();await expect(bridge.invoke({...payload,referenceIndices:[[3],[]]})).rejects.toThrow('tham chiếu');expect(calls).toHaveLength(0);
  });
  it('releases submission lock after a failure',async()=>{
    const {bridge}=fixture();await expect(bridge.invoke({...payload,ratio:'bad'})).rejects.toThrow();expect(bridge.busy.size).toBe(0);await expect(bridge.invoke(payload)).resolves.toHaveProperty('projectId','isolated');
  });
  it('does not auto-retry an ambiguous network failure',async()=>{
    let count=0;const bridge=new MuseVeo3Bridge({fetchImpl:async()=>{count++;throw Error('offline');}});
    await expect(bridge.invoke(payload)).rejects.toThrow('cổng 4000');expect(count).toBe(1);
  });
});
