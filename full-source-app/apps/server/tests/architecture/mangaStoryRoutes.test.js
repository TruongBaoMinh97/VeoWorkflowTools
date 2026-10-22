import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
vi.mock('../../src/modules/genNormal/genNormal.service.js',()=>({genNormalService:{}}));
vi.mock('../../src/modules/genNormal/genNormal.repository.js',()=>({genNormalRepository:{}}));
import {registerMangaStoryRoutes,mangaStoryStore} from '../../src/modules/genNormal/mangaStory.routes.js';
it('registers with Fastify plugin options and resolves the real default store',async()=>{
 const app=Fastify();const spy=vi.spyOn(mangaStoryStore,'context').mockResolvedValue({revision:0,config:{schema:1}});
 const patchSpy=vi.spyOn(mangaStoryStore,'patchPrompts').mockResolvedValue({revision:1,patchedSceneIds:['UT007_A'],rows:[]});
 try{
  await app.register(registerMangaStoryRoutes);
  const response=await app.inject('/api/gen-normal/projects/test/manga-story');
  expect(response.statusCode).toBe(200);expect(response.json().config.schema).toBe(1);expect(spy).toHaveBeenCalledWith('test');
  const patchRes=await app.inject({method:'POST',url:'/api/gen-normal/projects/test/manga-story/patch',payload:{revision:0,patchText:'UT007_A | @HARUKO_HOME drinks tea.'}});
  expect(patchRes.statusCode).toBe(200);expect(patchRes.json().patchedSceneIds).toEqual(['UT007_A']);expect(patchSpy).toHaveBeenCalledWith('test',{revision:0,patchText:'UT007_A | @HARUKO_HOME drinks tea.',allowAppend:false});
 }finally{spy.mockRestore();patchSpy.mockRestore();await app.close();}
});
