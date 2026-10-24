import {describe,it,expect} from 'vitest';
import {parseControlScript,alignmentText,enrichSentences,buildUtterances,buildVisualTimeline,parseSrtCueStarts,visualTimelineSrt,chatGptInput,chatGptTimelineInput} from '../../src/modules/workflow/lib/storyDataExport.js';

const control=`[UT001][NARRATOR][NARRATION][calm storytelling]
Đêm đã khuya.

[UT002][MICHIKO][INNER_THOUGHT][softly]
Con bé đã đọc rồi. Chắc chỉ cần trả lời một câu thôi mà.

[UT003][MAI][DIALOGUE][worried]
Mẹ có sao không?

[UT004][MICHIKO][REACTION][sighs]
[sighs]
`;

describe('Story data export',()=>{
 it('parses speaker metadata and excludes pure reactions from alignment text',()=>{
  const rows=parseControlScript(control);
  expect(rows).toHaveLength(4);
  expect(rows[1]).toMatchObject({utterance_id:'UT002',speaker_id:'MICHIKO',speech_type:'INNER_THOUGHT',emotion:'softly'});
  const clean=alignmentText(rows);
  expect(clean).toContain('Con bé đã đọc rồi.');
  expect(clean).not.toContain('[sighs]');
  expect(clean).not.toContain('UT002');
 });
 it('maps split sentences back to speakers, timing and audio files',()=>{
  const rows=parseControlScript(control),raw=[
   {id:1,sentence:'Đêm đã khuya.',word_count:4},
   {id:2,sentence:'Con bé đã đọc rồi.',word_count:5},
   {id:3,sentence:'Chắc chỉ cần trả lời một câu thôi mà.',word_count:9},
   {id:4,sentence:'Mẹ có sao không?',word_count:4},
  ];
  const alignment=raw.map((x,i)=>({id:x.id,start_ms:i*1000,end_ms:i*1000+900,confidence:.95,match_type:'exact_contiguous',matched_srt_start_index:i+1,matched_srt_end_index:i+1}));
  const segments=raw.map((x,i)=>({id:x.id,audio_file:`C:/audio/${x.id}.wav`,segment_start_ms:i*1000,segment_end_ms:(i+1)*1000,duration_ms:1000,segment_start:i,segment_end:i+1}));
  const enriched=enrichSentences(rows,raw,alignment,segments);
  expect(enriched[1]).toMatchObject({utterance_id:'UT002',speaker_id:'MICHIKO',speech_type:'INNER_THOUGHT',audio_tags:['softly'],start_ms:1000});
  expect(enriched[2].utterance_id).toBe('UT002');
  expect(enriched[3].speaker_id).toBe('MAI');
  const grouped=buildUtterances(rows,enriched);
  expect(grouped[1].sentence_ids).toEqual(['ST002','ST003']);
  expect(grouped[3]).toMatchObject({speech_type:'REACTION',start_ms:null});
  expect(chatGptInput(grouped)).toContain('SPEAKER: MAI');
  const timeline=buildVisualTimeline(grouped,'C:/audio/master.mp3',4000,{minDurationMs:1000,maxDurationMs:12000,maxUtterances:3});
  expect(timeline.scenes.map(scene=>[scene.scene_id,scene.start_ms,scene.end_ms])).toEqual([
   ['UT001',0,1000],['UT002',1000,3000],['UT003',3000,4000],
  ]);
  expect(timeline.non_audible_utterances.map(item=>item.utterance_id)).toEqual(['UT004']);
  expect(timeline.scenes[2].merged_non_audible_utterances[0].utterance_id).toBe('UT004');
  expect(visualTimelineSrt(timeline)).toContain('UT002 | MICHIKO');
  expect(chatGptTimelineInput(timeline)).toContain('REACTION_CONTEXT: UT004 sighs');
  expect(chatGptTimelineInput(timeline)).not.toContain('SCENE_ID: UT004');
  expect(chatGptInput(grouped)).toContain('SCENE_ID: UT003');
 });
 it('merges short UTs without changing master-audio timing',()=>{
  const rows=[
   {utterance_id:'UT001',speaker_id:'NARRATOR',speech_type:'NARRATION',text:'Mở đầu.',audio_tags:[],start_ms:0,end_ms:1000,alignment_confidence:1},
   {utterance_id:'UT002',speaker_id:'KEIKO',speech_type:'DIALOGUE',text:'Bà đã ăn sáng chưa?',audio_tags:[],start_ms:1000,end_ms:2500,alignment_confidence:1},
   {utterance_id:'UT003',speaker_id:'SATO',speech_type:'DIALOGUE',text:'Tôi rất sẵn lòng.',audio_tags:[],start_ms:2500,end_ms:5500,alignment_confidence:1},
  ];
  const timeline=buildVisualTimeline(rows,'C:/audio/master.mp3',5500,{minDurationMs:2500,maxDurationMs:9000,maxUtterances:3});
  expect(timeline.scenes.map(scene=>[scene.scene_id,scene.utterance_ids,scene.start_ms,scene.end_ms])).toEqual([
   ['UT001_UT002',['UT001','UT002'],0,2500],['UT003',['UT003'],2500,5500],
  ]);
  expect(timeline.scenes[0].speaker_ids).toEqual(['NARRATOR','KEIKO']);
  expect(timeline.visual_config).toEqual({min_duration_ms:2500,max_duration_ms:9000,max_utterances_per_scene:3});
 });
 it('splits an overlong UT only at an available SRT boundary',()=>{
  const rows=[{utterance_id:'UT001',speaker_id:'NARRATOR',speech_type:'NARRATION',text:'Tình thương cần được gửi đúng lúc, và người nhận cần có quyền lựa chọn.',audio_tags:[],start_ms:0,end_ms:11000,alignment_confidence:1}];
  const starts=parseSrtCueStarts('1\n00:00:00,000 --> 00:00:05,500\nA\n\n2\n00:00:05,500 --> 00:00:11,000\nB\n');
  const timeline=buildVisualTimeline(rows,'C:/audio/master.mp3',11000,{minDurationMs:2500,maxDurationMs:9000,maxUtterances:3,srtCueStarts:starts});
  expect(timeline.scenes.map(scene=>[scene.scene_id,scene.start_ms,scene.end_ms])).toEqual([['UT001_A',0,5500],['UT001_B',5500,11000]]);
  expect(timeline.scenes.map(scene=>scene.source_text)).toEqual(['Tình thương cần được gửi đúng lúc,','và người nhận cần có quyền lựa chọn.']);
 });
 it('falls back to sentence clause boundaries when SRT cues are longer than maxDurationMs',()=>{
  const text='四十年間、自分の思いどおりに動いてくれた妻が自分の時間を持つと、ご主人は最初、不機嫌になったり、ため息をついたりするでしょう。';
  const rows=[{utterance_id:'UT001',speaker_id:'RINKO',speech_type:'DIALOGUE',text,audio_tags:[],start_ms:0,end_ms:14000,alignment_confidence:1}];
  const sentences=[{utterance_id:'UT001',sentence:text,start_ms:0,end_ms:14000}];
  const timeline=buildVisualTimeline(rows,'C:/audio/master.mp3',14000,{minDurationMs:2500,maxDurationMs:9000,maxUtterances:3,sentences,srtCueStarts:[0]});
  expect(timeline.scenes).toHaveLength(2);
  expect(timeline.scenes.every(s=>s.duration_ms<=9000&&!s.review_required)).toBe(true);
 });
 it('rejects duplicate, missing and malformed utterance ids',()=>{
  expect(()=>parseControlScript('[UT001][MAI][DIALOGUE]\nA\n\n[UT001][MAI][DIALOGUE]\nB')).toThrow(/Trùng|liên tục/);
  expect(()=>parseControlScript('[UT002][MAI][DIALOGUE]\nA')).toThrow(/liên tục/);
  expect(()=>parseControlScript('Mai: A')).toThrow(/sai định dạng/);
 });
});
