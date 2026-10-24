/* INLINE_STORY_PROMPTS_START */
function InlineStoryPrompts({projectId,outputDir,onFill,disabled}) {
 const [open,setOpen]=u.useState(false),[fields,setFields]=u.useState({txtPath:'',audioPath:'',srtPath:'',outputDir:outputDir||'',visualMinDurationMs:2500,visualMaxDurationMs:9000,visualMaxUtterances:3}),[busy,setBusy]=u.useState(false),[message,setMessage]=u.useState(''),[error,setError]=u.useState(''),[result,setResult]=u.useState(null);
 const alive=u.useRef(true);u.useEffect(()=>()=>{alive.current=false},[]);u.useEffect(()=>{if(outputDir)setFields(old=>({...old,outputDir:old.outputDir||outputDir}))},[outputDir]);
 const edit=(key,value)=>setFields(old=>({...old,[key]:value}));
 const pick=async(key,kind)=>{try{const r=kind==='folder'?await window.electronAPI.selectFolder():await window.electronAPI.selectWorkflowFile(kind);if(!r.canceled)edit(key,r.path||r.paths?.[0]||'')}catch(err){setError(err.message||String(err))}};
 const ready=['txtPath','audioPath','srtPath','outputDir'].every(key=>fields[key]);
 const generate=async()=>{setBusy(true);setError('');setResult(null);setMessage('Đang kiểm tra kịch bản có người nói…');try{
   const run=Al(await ye.post('/api/workflow/story-data/start',fields));let state=run;
   while(alive.current){
    state=Al(await ye.get('/api/workflow/story-data/'+run.runId+'?root='+encodeURIComponent(run.root)));
    if(['FAILED','CANCELLED'].includes(state.status))throw Error(state.error||'Lượt xuất dữ liệu đã dừng.');
    setMessage((state.message||'Đang xử lý')+' · '+Math.round((state.progress||0)*100)+'%');
    if(state.status==='COMPLETED')break;
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
   if(!alive.current)return;setResult(state.result);window.dispatchEvent(new CustomEvent('story-audio-ready',{detail:{projectId,audioRoot:run.root}}));setMessage('Đã tạo visual timeline. Dùng CHATGPT_STORY_INPUT.txt để tạo prompt; scene ID UT phải được giữ nguyên.');
 }catch(err){if(alive.current)setError(err.message||String(err))}finally{if(alive.current)setBusy(false)}};
 return e.jsxs('details',{className:'mb-3 rounded border border-violet-200 bg-violet-50 p-3 text-sm',open,onToggle:ev=>setOpen(ev.currentTarget.open),children:[
 e.jsx('summary',{className:'cursor-pointer font-semibold text-violet-700',children:'Chuẩn bị Story · TXT người nói / Audio / SRT'}),
 open&&e.jsxs('fieldset',{disabled:busy||disabled,className:'space-y-2 max-h-96 overflow-y-auto mt-2',children:[
 ...[['txtPath','TXT có tên người nói','txt'],['audioPath','Audio ElevenLabs cuối','audio'],['srtPath','SRT của audio cuối','srt'],['outputDir','Thư mục kết quả','folder']].map(([key,label,kind])=>e.jsxs('label',{className:'block',children:[label,e.jsxs('div',{className:'flex gap-1',children:[e.jsx('input',{'aria-label':'Story '+label,className:'min-w-0 flex-1 rounded border p-1',value:fields[key]||'',onChange:ev=>edit(key,ev.target.value)}),e.jsx('button',{type:'button',className:'rounded border px-2',onClick:()=>pick(key,kind),children:'Chọn'})]})]},key)),
 e.jsxs('div',{className:'grid grid-cols-3 gap-2',children:[['visualMinDurationMs','Cảnh tối thiểu (ms)',1000,6000,100],['visualMaxDurationMs','Cảnh tối đa (ms)',4000,20000,100],['visualMaxUtterances','UT tối đa/cảnh',1,5,1]].map(([key,label,min,max,step])=>e.jsxs('label',{className:'block text-xs',children:[label,e.jsx('input',{type:'number',min,max,step,'aria-label':'Story '+label,className:'w-full rounded border p-1',value:fields[key],onChange:ev=>edit(key,Number(ev.target.value))})]},key))}),
 e.jsx('p',{className:'text-xs text-slate-500',children:'UT ngắn được gộp ở timeline hình; UT dài chỉ chia tại mốc SRT/câu an toàn. Audio gốc không bị cắt.'}),
  e.jsx('p',{className:'text-xs text-slate-500',children:'TXT dùng dạng [UT001][MICHIKO][DIALOGUE][emotion]. Công cụ căn UT với audio, giữ audio gốc và xuất visual_timeline.json/.srt để ghép ảnh chính xác.'}),
  e.jsx('button',{type:'button',disabled:!ready,className:'w-full rounded bg-violet-600 disabled:bg-slate-300 text-white p-2',onClick:generate,children:busy?'Đang phân tích và tạo timeline…':'Phân tích và tạo visual timeline'}),
 result&&e.jsxs('div',{className:'rounded border border-emerald-200 bg-emerald-50 p-2 text-xs space-y-1',children:[
   e.jsx('div',{className:'font-semibold text-emerald-800',children:`${result.summary.visual_scenes??result.summary.utterances} cảnh · ${result.summary.utterances} lượt thoại · ${result.summary.speakers.length} người nói`}),
  e.jsx('div',{className:'break-all',children:'sentences.json: '+result.files.sentences}),
   e.jsx('div',{className:'break-all',children:'ChatGPT TXT: '+result.files.chatgpt_input}),
   result.files.visual_timeline&&e.jsx('div',{className:'break-all',children:'Timeline JSON: '+result.files.visual_timeline}),
   result.files.visual_timeline_srt&&e.jsx('div',{className:'break-all',children:'Timeline SRT: '+result.files.visual_timeline_srt}),
   result.summary.review_required&&e.jsx('div',{className:'text-amber-700',children:`Cần kiểm tra ${result.summary.visual_scenes_review_required??result.summary.low_confidence_sentences} cảnh có độ tin cậy thấp hoặc thời lượng bất thường.`})
 ]})
 ]}),
 message&&e.jsx('p',{className:'text-xs mt-2',children:message}),error&&e.jsx('p',{role:'alert',className:'text-red-600 text-xs mt-2',children:error})
 ]});
}
/* INLINE_STORY_PROMPTS_END */
