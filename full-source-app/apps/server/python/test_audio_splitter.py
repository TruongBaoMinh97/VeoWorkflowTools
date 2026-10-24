import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
import wave
import audio_splitter as a


class SplitterTests(unittest.TestCase):
    def test_decimal_unicode_and_long_sentences(self):
        self.assertEqual(a.split_sentences('Giá là 3.14 đồng. Mai về quê!'), ['Giá là 3.14 đồng.', 'Mai về quê!'])
        text = ' '.join(['một hai ba bốn năm'] * 20) + '.'
        parts = a.split_sentences(text)
        self.assertGreater(len(parts), 1)
        self.assertEqual(a.tokenize(' '.join(parts)), a.tokenize(text))
        self.assertEqual(a.tokenize('Đặng: “xin chào!”'), ['dang', 'xin', 'chao'])

    def test_alignment_missing_sentence_and_many_cues(self):
        cues = a.parse_srt('1\n00:00:00,000 --> 00:00:01,000\nMai về\n\n2\n00:00:01,000 --> 00:00:02,000\nquê.\n\n3\n00:00:03,000 --> 00:00:04,000\nTrời sáng.')
        result = a.align(['Mai về quê.', 'Lời này không có.', 'Trời sáng.'], cues)
        self.assertEqual(result[0]['matched_srt_start_index'], 1)
        self.assertEqual(result[0]['matched_srt_end_index'], 2)
        self.assertTrue(all(s['start_ms'] is not None and s['end_ms'] >= s['start_ms'] for s in result))
        self.assertTrue(any(s['confidence'] < .5 for s in result))

    def test_minimum_boundaries_without_padding(self):
        bounds, fixes = a.enforce_boundaries([10, 995], 3, 1000)
        self.assertEqual(bounds, [0, 200, 800, 1000])
        self.assertEqual(len(fixes), 2)
        with self.assertRaisesRegex(ValueError, 'quá ngắn'): a.enforce_boundaries([50], 2, 399)

    def test_invalid_srt(self):
        for text in ['bad', '1\n00:00:02,000 --> 00:00:01,000\nbad', '1\n00:70:00,000 --> 00:70:01,000\nbad']:
            with self.assertRaises(ValueError): a.parse_srt(text)

    def test_no_pause_and_short_audio(self):
        from pydub import AudioSegment
        audio = AudioSegment(data=b''.join(struct.pack('<h', int(10000*math.sin(i*.2))) for i in range(16000)), sample_width=2, frame_rate=16000, channels=1)
        items=[dict(id=1,end_ms=450),dict(id=2,start_ms=550)]
        cuts, report, _ = a.cut_points(audio, items)
        self.assertEqual(cuts,[550]);self.assertIsNone(report[0]['chosen_pause'])

    def test_real_export_unicode_paths(self):
        server = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory(prefix='âm thanh ') as directory:
            root=Path(directory); txt=root/'kịch bản.txt';srt=root/'phụ đề.srt';audio=root/'giọng đọc.wav'
            txt.write_text('Mai về quê. Trời sáng.',encoding='utf-8')
            srt.write_text('1\n00:00:00,000 --> 00:00:00,500\nMai về quê.\n\n2\n00:00:00,500 --> 00:00:01,000\nTrời sáng.',encoding='utf-8')
            with wave.open(str(audio),'wb') as w:
                w.setparams((1,2,16000,0,'NONE','not compressed'));w.writeframes(b'\0\0'*16000)
            cfg=dict(txt_path=str(txt),srt_path=str(srt),audio_path=str(audio),output_root=str(root/'kết quả'),ffmpeg=str(server/'binaries/ffmpeg/win32-x64-ffmpeg.exe'),ffprobe=str(server/'binaries/ffmpeg/win32-x64-ffprobe.exe'))
            report,result=a.split(cfg)
            self.assertEqual(report['summary']['sum_segments_duration_ms'],1000)
            self.assertEqual(len(result['segments']),2)
            self.assertTrue(all(Path(s['audio_file']).is_file() for s in result['segments']))
            with wave.open(str(audio),'wb') as w:
                w.setparams((1,2,16000,0,'NONE','not compressed'));w.writeframes(b'\0\0'*1000)
            cfg['output_root']=str(root/'quá ngắn')
            with self.assertRaises(ValueError):a.split(cfg)


if __name__ == '__main__': unittest.main()
