"""Local TXT/SRT/pause splitter, ported from Super Image V120.12.

No application import, license code, ASR or network access. The SRT remains
the timing source. CLI emits JSON lines so cancellation/progress stay outside
the workflow server's event loop. Requires pydub==0.25.1.
"""
from __future__ import annotations
import argparse
from dataclasses import dataclass, asdict
import difflib
import html
import json
import math
import os
from pathlib import Path
import re
import sys
import unicodedata
import wave


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def read_text(file):
    raw = Path(file).read_bytes()
    for encoding in ('utf-8-sig', 'utf-16', 'cp1258'):
        try:
            return raw.decode(encoding)
        except UnicodeError:
            pass
    raise ValueError('Không đọc được mã hóa văn bản: ' + str(file))


def dense(ch):
    n = ord(ch)
    return (0x3400 <= n <= 0x9fff or 0x3040 <= n <= 0x30ff or
            0xac00 <= n <= 0xd7af or 0x0e00 <= n <= 0x0eff)


def tokenize(text):
    text = html.unescape(re.sub(r'<[^>]+>|\{[^}]*\}|\[[^\]]*\]', '', text)).casefold()
    for mark in ('’', '‘', 'ʼ', 'ʻ', '＇', '`', '´'):
        text = text.replace(mark, "'")
    text = unicodedata.normalize('NFKD', text.replace('đ', 'd').replace('ð', 'd'))
    tokens, buf = [], []
    def flush():
        if buf:
            tokens.append(''.join(buf)); buf.clear()
    for i, ch in enumerate(text):
        cat = unicodedata.category(ch)
        if cat.startswith('M'):
            continue
        if cat[0] in 'LN':
            if dense(ch):
                flush(); tokens.append(ch)
            else:
                buf.append(ch)
        elif ch == "'" and buf and i + 1 < len(text) and unicodedata.category(text[i + 1])[0] in 'LN':
            continue
        else:
            flush()
    flush()
    return tokens


def token_weight(token):
    if len(token) == 1 and dense(token):
        return 1.0
    digits = sum(c.isdigit() for c in token)
    size = sum(c.isalpha() for c in token) + digits
    if digits == len(token):
        size += digits
    return float(clamp(size, 1, 18))


ABBREVIATIONS = set('рис u.s est mr mrs vol i.e etc st dept г a.m sr p ms ts e.g ths vs u.k dr fig bs ltd prof pgs стр p.m gs inc q no tp им ph.d tr jr'.split())


def split_sentences(text, max_words=18):
    def is_abbreviation(text, start, pos):
        if text[pos] != '.':
            return False
        prefix = text[start:pos + 1]
        match = re.search(r'([^\W_]+(?:\.[^\W_]+)*)\.$', prefix)
        word = match.group(1).casefold() if match else ''
        return word in ABBREVIATIONS or bool(re.search(r'(?:\b[^\W\d_]\.){2,}$', prefix)) or (len(word) == 1 and word.isalpha())
    def initial(text):
        out, start, i, n = [], 0, 0, len(text)
        while i < n:
            ch = text[i]
            if ch in '.!?…。！？｡؟۔։':
                decimal = ch == '.' and 0 < i < n - 1 and text[i - 1].isdigit() and text[i + 1].isdigit()
                if decimal or is_abbreviation(text, start, i):
                    i += 1; continue
                j = i + 1
                while j < n and text[j] == ch and ch in '.!?…':
                    j += 1
                while j < n and text[j] in '\"\'”’»›）)]}】」』':
                    j += 1
                if j >= n or text[j].isspace() or ch in '。！？｡؟۔։':
                    piece = text[start:j].strip()
                    if piece: out.append(piece)
                    while j < n and text[j].isspace(): j += 1
                    start = i = j
                    continue
            i += 1
        if text[start:].strip(): out.append(text[start:].strip())
        return out
    def split_long(sent):
        sent = sent.strip()
        if not sent: return []
        quote = re.search(r':[\s\u00A0]*[\"“‘«‹「『]', sent)
        if quote:
            left, right = sent[:quote.start() + 1].strip(), sent[quote.start() + 1:].strip()
            if left and right and len(tokenize(right)) >= 2:
                return split_long(left) + split_long(right)
        count = len(tokenize(sent))
        if count <= max_words: return [sent]
        best, score = -1, float('inf')
        for mark in ('—', '–', ',', '，', '、', '-', ':', '：', ';', '；', '…'):
            for pos, ch in enumerate(sent):
                if ch != mark: continue
                left, right = sent[:pos + 1].strip(), sent[pos + 1:].strip()
                if not left or not right: continue
                a, b = len(tokenize(left)), len(tokenize(right))
                if a > max_words * 1.4: continue
                value = abs(a - b) + a * .05
                if value < score: best, score = pos, value
        if best == -1 and count > max_words * 1.25:
            for pos, ch in enumerate(sent):
                if not ch.isspace(): continue
                a, b = len(tokenize(sent[:pos])), len(tokenize(sent[pos + 1:]))
                if min(a, b) < 2: continue
                value = abs(a - max_words) + abs(a - b) * .15
                if value < score: best, score = pos, value
        if best == -1: return [sent]
        return split_long(sent[:best + 1]) + split_long(sent[best + 1:])
    paragraphs = [re.sub(r'\s+', ' ', p).strip() for p in re.split(r'\n\s*\n+', text.replace('\r\n', '\n').replace('\r', '\n').strip()) if p.strip()]
    return [s for p in paragraphs for sentence in initial(p) for s in split_long(sentence) if s.strip()]


@dataclass
class Word:
    token: str
    start_ms: int
    end_ms: int
    srt_index: int


def parse_srt(text):
    def ms(s):
        h, m, sec, milli = map(int, re.split('[:,.]', s))
        if m >= 60 or sec >= 60: raise ValueError('Mốc SRT không hợp lệ')
        return ((h * 60 + m) * 60 + sec) * 1000 + milli
    cues = []
    for block in re.split(r'\n\s*\n', text.replace('\r\n', '\n').strip().lstrip('\ufeff')):
        lines = block.splitlines()
        time_index = next((i for i, line in enumerate(lines) if '-->' in line), None)
        if time_index is None: raise ValueError('SRT có mục thiếu mốc thời gian')
        match = re.search(r'(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})', lines[time_index])
        if not match: raise ValueError('Sai định dạng thời gian SRT')
        start, end = ms(match[1]), ms(match[2])
        if end <= start: raise ValueError('SRT có mục thời lượng không dương')
        index = int(lines[0]) if time_index and lines[0].strip().isdigit() else len(cues) + 1
        cues.append(dict(index=index, start_ms=start, end_ms=end, text=' '.join(lines[time_index + 1:])))
    if not cues: raise ValueError('SRT rỗng')
    if len({c['index'] for c in cues}) != len(cues): raise ValueError('SRT trùng mã mục phụ đề')
    if any(b['start_ms'] < a['start_ms'] for a, b in zip(cues, cues[1:])): raise ValueError('SRT không theo thứ tự thời gian')
    return cues


def timed_words(cues):
    words = []
    for cue in cues:
        tokens = tokenize(cue['text']); weights = [token_weight(t) for t in tokens]
        total, consumed = max(1.0, sum(weights)), 0.0
        duration = max(1, cue['end_ms'] - cue['start_ms'])
        for token, weight in zip(tokens, weights):
            start = int(round(cue['start_ms'] + duration * consumed / total)); consumed += weight
            end = int(round(cue['start_ms'] + duration * consumed / total))
            words.append(Word(token, start, max(start + 1, end), cue['index']))
    return words


def global_ranges(sentences, words):
    flat, spans = [], []
    for sentence in sentences:
        start = len(flat); flat.extend(tokenize(sentence)); spans.append((start, len(flat)))
    tokens = [w.token for w in words]
    if not flat or not tokens or max(len(flat), len(tokens)) > 60000: return {}
    mapping = {}
    for block in difflib.SequenceMatcher(a=flat, b=tokens, autojunk=False).get_matching_blocks():
        for off in range(block.size): mapping[block.a + off] = block.b + off
    result = {}
    for i, (start, end) in enumerate(spans):
        positions = [mapping[p] for p in range(start, end) if p in mapping]
        if not positions: continue
        coverage = len(positions) / max(1, end - start)
        compactness = min(1.0, len(positions) / max(1, positions[-1] - positions[0] + 1))
        if coverage >= .45: result[i + 1] = (positions[0], positions[-1], 'global_sequence', coverage * (.78 + .22 * compactness))
    return result


def find_range(target, tokens, cursor):
    n = len(target)
    for pos in range(cursor, min(len(tokens), cursor + max(180, n * 2 + 80))):
        if tokens[pos:pos + n] == target: return pos, pos + n - 1, 'exact_contiguous', 1.0
    end = min(len(tokens), cursor + max(220, n * 5 + 80))
    first = set(target[:min(4, n)])
    starts = [p for p in range(cursor, end) if tokens[p] in first][:80] or list(range(cursor, min(end, cursor + 60)))
    best = None
    for start in starts:
        j, matched = 0, []
        for pos in range(start, min(len(tokens), start + max(n * 3, n + 20))):
            if j < n and tokens[pos] == target[j]:
                matched.append(pos); j += 1
                if j >= n: break
        coverage = j / max(1, n)
        compactness = len(matched) / max(1, matched[-1] - matched[0] + 1) if matched else 0.0
        confidence = coverage * (.78 + .22 * compactness)
        if matched and coverage >= .45:
            candidate = matched[0], matched[-1], 'fuzzy_sequential', confidence
            if best is None or confidence > best[3] or (confidence == best[3] and matched[0] < best[0]): best = candidate
            if coverage >= .98 and compactness >= .9: break
    return best


def normal_match(target, tokens, cursor, anchor=None):
    if not target or cursor >= len(tokens): return None
    last = min(len(tokens) - 1, cursor + max(72, len(target) * 3 + 32))
    result = find_range(target, tokens, cursor)
    if result and cursor <= result[0] <= last and result[1] <= last and (result[2] == 'exact_contiguous' or result[3] >= .72): return result
    if anchor and cursor <= anchor[0] <= last and anchor[1] <= last and anchor[3] >= .78: return anchor
    expected = cursor + len(target) - 1
    tolerance = max(1, min(3, math.ceil(len(target) * .18)))
    candidates = [expected + delta for delta in range(-tolerance, tolerance + 1) if cursor <= expected + delta <= last and tokens[expected + delta] == target[-1]]
    if len(candidates) == 1:
        end = candidates[0]; size = min(2, len(target), end - cursor + 1)
        score = sum(similarity(target[-i], tokens[end - i + 1]) for i in range(1, size + 1)) / max(1, size)
        if score >= .75: return cursor, end, 'end_anchor_local', .82
    return None


def similarity(a, b):
    return difflib.SequenceMatcher(a=a, b=b, autojunk=False).ratio() if a and b else 0.0


def count_fallback(target, tokens, cursor):
    if not target or cursor >= len(tokens): return None
    best = None; tolerance = max(1, min(2, math.ceil(len(target) * .12)))
    for delta in (0, -1, 1, -2, 2):
        end = cursor + len(target) - 1 + delta
        if abs(delta) > tolerance or not cursor <= end < len(tokens): continue
        window = tokens[cursor:end + 1]; size = min(2, len(target), len(window))
        ending = sum(similarity(target[-i], window[-i]) for i in range(1, size + 1)) / max(1, size)
        score = .7 * ending + .3 * similarity(target, window)
        candidate = cursor, end, 'count_fallback', score, ending
        if best is None or score > best[3]: best = candidate
    if best and best[4] >= .5 and best[3] >= .5: return (*best[:3], round(best[3], 3))
    return None


def repair_times(items, total_ms):
    i = 0
    while i < len(items):
        if items[i]['start_ms'] is not None and items[i]['end_ms'] is not None:
            i += 1; continue
        begin = i
        while i < len(items) and (items[i]['start_ms'] is None or items[i]['end_ms'] is None): i += 1
        end = i
        left = clamp(int(items[begin - 1]['end_ms'] or 0) if begin else 0, 0, total_ms)
        right = clamp(int((items[end]['start_ms'] if end < len(items) else total_ms) or left), left, total_ms)
        indices = list(range(begin, end)); share = False
        if right <= left and end < len(items) and len(indices) <= 2:
            anchor_end = clamp(int(items[end]['end_ms'] or 0), left, total_ms)
            if anchor_end > left: indices.append(end); right = anchor_end; share = True
        weights = [max(1, items[k]['word_count']) for k in indices]; weight = max(1, sum(weights)); consumed = 0
        for k, w in zip(indices, weights):
            start_ms = left + int(round((right - left) * consumed / weight)); consumed += w
            end_ms = left + int(round((right - left) * consumed / weight))
            item = items[k]; item.update(start_ms=start_ms, end_ms=max(start_ms, end_ms), start_time=start_ms / 1000, end_time=max(start_ms, end_ms) / 1000)
            item['match_type'] += ('_time_repaired_shared_next_audio' if share else '_time_repaired') if k < end else '_time_shared_with_previous_unmatched'
            item['confidence'] = min(item['confidence'], .1 if k < end else .49)


def align(sentences, cues):
    words = timed_words(cues); tokens = [w.token for w in words]
    if not words: raise ValueError('SRT không có từ để căn khớp')
    anchors = global_ranges(sentences, words); cursor = consecutive = 0; items = []
    for idx, sentence in enumerate(sentences, 1):
        target = tokenize(sentence)
        result = normal_match(target, tokens, cursor, anchors.get(idx))
        future = False
        if target and result is None:
            for ahead in range(idx, min(len(sentences), idx + 5)):
                found = normal_match(tokenize(sentences[ahead]), tokens, cursor, anchors.get(ahead + 1))
                if found and found[0] <= cursor + 2 and found[3] >= .78: future = True; break
            if not future and consecutive < 2: result = count_fallback(target, tokens, cursor)
        item = dict(id=idx, sentence=sentence, start_time=None, end_time=None, start_ms=None, end_ms=None, word_count=len(target), matched_srt_start_index=None, matched_srt_end_index=None, match_type='empty' if not target else ('unmatched_reanchor_ahead' if future else 'unmatched'), confidence=0.0)
        if result:
            start, end, kind, confidence = result
            start = clamp(int(start), 0, len(words) - 1); end = clamp(int(end), start, len(words) - 1)
            cursor = max(cursor, end + 1); consecutive = consecutive + 1 if kind == 'count_fallback' else 0
            item.update(start_time=words[start].start_ms / 1000, end_time=words[end].end_ms / 1000, start_ms=words[start].start_ms, end_ms=words[end].end_ms, matched_srt_start_index=words[start].srt_index, matched_srt_end_index=words[end].srt_index, match_type=kind, confidence=round(float(confidence), 3))
        else: consecutive = 0
        items.append(item)
    repair_times(items, cues[-1]['end_ms'])
    return items


def percentile(values, percent):
    values = sorted(values); k = (len(values) - 1) * percent / 100
    lo, hi = math.floor(k), math.ceil(k)
    return values[lo] * (hi - k) + values[hi] * (k - lo) if lo != hi else values[lo]


def cut_points(audio, items, min_silence=80, seek_step=5, progress=lambda *a: None):
    from pydub.silence import detect_silence
    values = [audio[i:i + 50].dBFS for i in range(0, len(audio), 50)]
    values = [v for v in values if v != float('-inf')]
    threshold = round(max(-60, min(min((percentile(values, 50) or -35) - 16, (percentile(values, 20) or -45) + 6), -30)), 2) if values else -50
    cuts, reports, prev = [], [], 0
    for i, (cur, nxt) in enumerate(zip(items, items[1:])):
        a, b = int(cur['end_ms'] if cur['end_ms'] is not None else prev), int(nxt['start_ms'] if nxt['start_ms'] is not None else cur['end_ms'] or prev)
        pauses, chosen, method = [], None, 'fallback_next_start'
        if b > a:
            lo, hi = clamp(a, prev, len(audio)), clamp(b, clamp(a, prev, len(audio)), len(audio))
            local = detect_silence(audio[lo:hi], min_silence_len=min_silence, silence_thresh=threshold, seek_step=seek_step)
            if not local and min_silence > 60:
                local = detect_silence(audio[lo:hi], min_silence_len=60, silence_thresh=threshold + 2, seek_step=seek_step)
            pauses = [(lo + p, lo + q) for p, q in local if q > p]
            if pauses:
                across = [p for p in pauses if p[0] <= b <= p[1]]
                earlier = [p for p in pauses if p[1] <= b]
                chosen = max(across, key=lambda p: p[1] - p[0]) if across else (max(earlier, key=lambda p: (p[1], p[1] - p[0])) if earlier else min(pauses, key=lambda p: abs(p[1] - b)))
            cut = clamp(chosen[1], lo, hi) if chosen else hi
            if chosen: method = 'best_pause_end_between_sentences'
        elif a > b: cut = int(round((a + b) / 2)); method = 'overlap_midpoint'
        else: cut = b
        cut = clamp(int(cut), prev, len(audio)); cuts.append(cut); prev = cut
        reports.append(dict(after_sentence_id=cur['id'], before_sentence_id=nxt['id'], interval_start_ms=a, interval_end_ms=b, chosen_pause=dict(start_ms=chosen[0], end_ms=chosen[1]) if chosen else None, pause_candidates=len(pauses), method=method, cut_ms=cut, cut_time=cut / 1000))
        progress(.4 + .2 * (i + 1) / max(1, len(items) - 1), f'Tính điểm cắt {i + 1}/{len(items) - 1}')
    return cuts, reports, threshold


def enforce_boundaries(cuts, count, length):
    if length < count * 200: raise ValueError(f'Audio quá ngắn: cần ít nhất {count * 200} ms cho {count} đoạn')
    raw = [0] + [clamp(int(c), 0, length) for c in cuts[:count - 1]] + [length]
    while len(raw) < count + 1: raw.insert(-1, length)
    bounds = [0] * count + [length]; fixes = []
    for i in range(1, count):
        value = clamp(raw[i], bounds[i - 1] + 200, length - (count - i) * 200)
        bounds[i] = value
        if value != raw[i]: fixes.append(dict(boundary_index=i, original_ms=raw[i], fixed_ms=value, reason='enforce_min_200ms_segment'))
    return bounds, fixes


def split(config, progress=lambda *a: None):
    params = dict(max_words=18, min_silence_ms=80, seek_step_ms=5, lead_in_ms=100)
    params.update(config.get('params', {}))
    for key, lo, hi in [('max_words', 2, 500), ('min_silence_ms', 20, 5000), ('seek_step_ms', 1, 100), ('lead_in_ms', 0, 5000)]:
        if not isinstance(params[key], int) or not lo <= params[key] <= hi: raise ValueError('Thông số không hợp lệ: ' + key)
    # Pin tool paths before importing pydub; never rely on the user's global PATH.
    for tool in ('ffmpeg', 'ffprobe'):
        if not Path(config[tool]).is_file(): raise ValueError('Thiếu ' + tool)
    os.environ['PATH'] = os.pathsep.join([str(Path(config[t]).parent) for t in ('ffmpeg', 'ffprobe')] + [os.environ.get('PATH', '')])
    from pydub import AudioSegment, utils
    AudioSegment.converter = config['ffmpeg']
    utils.get_prober_name = lambda: config['ffprobe']
    sentences = split_sentences(read_text(config['txt_path']), params['max_words'])
    if not 1 <= len(sentences) <= 500: raise ValueError('Cần từ 1 đến 500 câu')
    cues = parse_srt(read_text(config['srt_path'])); progress(.1, 'Căn TXT với SRT')
    items = align(sentences, cues); progress(.3, 'Mở audio gốc')
    with open(config['audio_path'], 'rb') as source:
        audio = AudioSegment.from_file(source)
    if not len(audio): raise ValueError('Audio rỗng')
    # Encoded audio/SRT end rounding differs by 26 ms in the reference fixture.
    # Preserve alignment timestamps; exported boundaries remain clamped to audio.
    if max(c['end_ms'] for c in cues) > len(audio) + 100:
        raise ValueError('Timeline SRT vượt quá thời lượng audio; hãy chọn các file tương ứng')
    cuts, reports, threshold = cut_points(audio, items, params['min_silence_ms'], params['seek_step_ms'], progress)
    bounds, fixes = enforce_boundaries(cuts, len(items), len(audio))
    root = Path(config['output_root']); folder = root / 'audio_segments'; folder.mkdir(parents=True, exist_ok=False)
    segments = []
    for i, item in enumerate(items):
        start, end = bounds[i:i + 2]; file = folder / f'{i + 1:03d}_id{item["id"]:03d}.wav'; temp = file.with_suffix('.tmp.wav')
        audio[start:end].export(temp, format='wav').close()
        with wave.open(str(temp), 'rb') as wav:
            decoded_ms = round(wav.getnframes() * 1000 / wav.getframerate())
            if decoded_ms < 200 or abs(decoded_ms - (end - start)) > 1: raise ValueError('Kiểm tra WAV thất bại: ' + str(file))
        temp.replace(file)
        segments.append(dict(id=item['id'], sentence=item['sentence'], audio_file=str(file), segment_start_ms=start, segment_end_ms=end, duration_ms=end - start, segment_start=start / 1000, segment_end=end / 1000, duration=(end - start) / 1000))
        progress(.6 + .38 * (i + 1) / len(items), f'Xuất audio {i + 1}/{len(items)}')
    low = sum(a['confidence'] < .5 for a in items); unmatched = sum(a['match_type'].startswith('unmatched') for a in items)
    summary = dict(total_sentences=len(items), total_srt_cues=len(cues), total_audio_segments=len(segments), unmatched_sentences=unmatched, audio_duration_ms=len(audio), sum_segments_duration_ms=sum(s['duration_ms'] for s in segments), duration_diff_ms=0, duration_check_pass=True, coverage_check_pass=True, low_confidence_sentences=low, repaired_sentences=sum('repaired' in a['match_type'] for a in items), zero_length_segments=0, short_segments_under_200ms=0, audio_export_min_segment_ms=200, pause_boundaries=sum(r['chosen_pause'] is not None for r in reports), pause_cut_policy='pause_end_to_previous_clip', review_required=bool(low or unmatched))
    report = dict(app='VeoWorkflowTools Audio Splitter', version=1, input={k: config[k] for k in ('txt_path', 'audio_path', 'srt_path')}, output=dict(output_root=str(root), audio_segments_dir=str(folder)), summary=summary, params={**params, 'output_format':'wav', 'silence_threshold_dbfs':threshold, 'alignment_timing':{'source':'srt_weighted_estimate'}, 'pause_assignment':'pause_end_to_previous_clip'}, alignment=items)
    split_report = dict(mode='TXT_REFERENCE_SRT_ALIGN_AUDIO_PAUSE_CUT', input_audio=config['audio_path'], output_dir=str(folder), duration_check_pass=True, boundaries=reports, export_validation=dict(min_segment_ms=200, alignment_boundary_fixes=[], boundary_fixes=fixes), segments=segments)
    for name, value in [('alignment_report.json', report), ('split_audio_report.json', split_report), ('sentences.json', [dict(id=a['id'], sentence=a['sentence'], word_count=a['word_count']) for a in items])]:
        (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    return report, split_report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); args = parser.parse_args()
    def emit(value): print(json.dumps(value, ensure_ascii=False), flush=True)
    try:
        config = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
        report, result = split(config, lambda progress, message: emit(dict(type='progress', progress=progress, message=message)))
        emit(dict(type='done', outputRoot=config['output_root'], summary=report['summary']))
    except Exception as error:
        emit(dict(type='error', message=str(error))); sys.exit(1)
