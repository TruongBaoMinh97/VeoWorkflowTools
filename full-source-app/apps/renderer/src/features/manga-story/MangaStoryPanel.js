/* MANGA_STORY_UI_START */
const mangaReferenceContexts = new Map();

function formatMangaPromptDisplay(prompt) {
  if (typeof prompt !== 'string') {
    return { isManga: false, sceneId: '', cleanPrompt: '' };
  }
  const match = prompt.match(
    /^Manga run ([0-9a-f-]+)\s*\/\s*([^.\r\n]+)\.\s*Do not render this identifier as text\.\s*\r?\n?([\s\S]*)$/i
  );
  if (!match) {
    return { isManga: false, sceneId: '', cleanPrompt: prompt };
  }
  return {
    isManga: true,
    runId: match[1],
    sceneId: match[2].trim(),
    cleanPrompt: (match[3] || '').trim() || prompt,
  };
}

function mangaReferenceContext(projectId) {
  const now = Date.now();
  const old = mangaReferenceContexts.get(projectId);
  if (old && now - old.time < 3000) return old.promise;
  const promise = ye.get('/api/gen-normal/projects/' + projectId + '/manga-story').then(Al);
  mangaReferenceContexts.set(projectId, { time: now, promise });
  return promise;
}

function MangaReferenceStrip({ projectId, images = [], sceneId, actualCount, onZoom }) {
  return e.jsxs('div', {
    style: {
      marginTop: 6,
      padding: '6px 8px',
      background: '#f0fdfa',
      border: '1px solid #ccfbf1',
      borderRadius: 7,
    },
    children: [
      e.jsx('div', {
        style: { fontSize: 11, fontWeight: 600, color: '#115e59', marginBottom: 4 },
        children: (sceneId ? sceneId + ' · ' : '') + 'Ảnh tham chiếu (' + images.length + ')',
      }),
      images.length
        ? e.jsx('div', {
            style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
            children: images.map((img, i) =>
              e.jsxs(
                'div',
                {
                  style: { width: 76 },
                  children: [
                    e.jsx(MangaStoryAsset, {
                      base: '/api/gen-normal/projects/' + projectId + '/manga-story',
                      asset: img.path.split(/[\\/]/).pop(),
                      compact: true,
                      onZoom,
                    }),
                    e.jsx('div', {
                      style: {
                        fontSize: 10,
                        fontWeight: 500,
                        color: '#334155',
                        overflowWrap: 'anywhere',
                        marginTop: 2,
                      },
                      children:
                        i + 1 + '. ' + (img.characterId || (img.role === 'style' ? 'Style' : 'Nhân vật')),
                    }),
                  ],
                },
                i
              )
            ),
          })
        : e.jsx('span', {
            style: { fontSize: 11, color: '#64748b' },
            children: 'Không dùng ảnh tham chiếu',
          }),
      actualCount !== undefined &&
        images.length > 0 &&
        e.jsx('div', {
          style: {
            fontSize: 10,
            fontWeight: 600,
            color: actualCount === images.length ? '#0f766e' : '#b91c1c',
            marginTop: 4,
          },
          children:
            actualCount === images.length
              ? 'Đã gắn ' + actualCount + ' ảnh vào job'
              : 'Job có ' + actualCount + '/' + images.length + ' ID tham chiếu — cần kiểm tra',
        }),
    ],
  });
}

function MangaDraftCard(props) {
  const [row, setRow] = u.useState(null);
  const [failed, setFailed] = u.useState(false);
  const job = props.job;
  u.useEffect(() => {
    let live = true;
    setRow(null);
    setFailed(false);
    if (job.prompt?.startsWith('Manga run ')) {
      mangaReferenceContext(props.projectId)
        .then((c) => {
          const found = c.runs.flatMap((r) => r.rows).find((r) => r.prompt === job.prompt);
          if (live) {
            setRow(found || null);
            setFailed(!found);
          }
        })
        .catch(() => {
          if (live) setFailed(true);
        });
    }
    return () => {
      live = false;
    };
  }, [props.projectId, job.id, job.prompt]);

  let count = 0;
  try {
    const ids =
      typeof job.referenceImageMediaIds === 'string'
        ? JSON.parse(job.referenceImageMediaIds)
        : job.referenceImageMediaIds;
    count = Array.isArray(ids) ? ids.length : 0;
  } catch {}

  return e.jsxs('div', {
    children: [
      e.jsx(U4, props),
      row &&
        e.jsx(MangaReferenceStrip, {
          projectId: props.projectId,
          images: row.images,
          sceneId: row.sceneId,
          actualCount: count,
        }),
      failed &&
        e.jsx('p', {
          style: { fontSize: 11, color: '#b91c1c', padding: 6 },
          children: 'Không tải được tham chiếu của lượt. Mở lại project để thử lại.',
        }),
    ],
  });
}

function MangaStoryAsset({ base, asset, compact = false, onZoom }) {
  const [url, setUrl] = u.useState('');
  u.useEffect(() => {
    let live = true;
    setUrl('');
    if (asset) {
      ye.get(base + '/assets/' + asset)
        .then((r) => {
          if (live) setUrl(Al(r).dataUrl);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [base, asset]);

  if (!url) {
    return e.jsx('span', {
      style: { fontSize: 11, color: '#64748b' },
      children: asset ? 'Đang tải ảnh…' : '',
    });
  }

  return e.jsx('a', {
    href: url,
    target: '_blank',
    rel: 'noreferrer',
    title: 'Bấm để phóng to ảnh tham chiếu',
    onClick: (ev) => {
      if (onZoom) {
        ev.preventDefault();
        onZoom({ url, title: asset || 'Ảnh tham chiếu đã chọn' });
      }
    },
    children: e.jsx('img', {
      src: url,
      alt: 'Ảnh tham chiếu đã chọn',
      style: {
        height: compact ? 66 : 116,
        maxWidth: compact ? 76 : 176,
        objectFit: 'contain',
        borderRadius: 6,
        background: 'white',
        border: '1px solid #e2e8f0',
        cursor: 'zoom-in',
      },
    }),
  });
}

function MangaStoryPanel({ projectId, onUpdated }) {
  const [open, setOpen] = u.useState(false);
  const [ctx, setCtx] = u.useState(null);
  const [cfg, setCfg] = u.useState(null);
  const [revision, setRevision] = u.useState(0);
  const [dirty, setDirty] = u.useState(false);
  const [busy, setBusy] = u.useState(false);
  const [busyLabel, setBusyLabel] = u.useState('');
  const [error, setError] = u.useState('');
  const [message, setMessage] = u.useState('');
  const [preview, setPreview] = u.useState([]);
  const [selected, setSelected] = u.useState([]);
  const [verified, setVerified] = u.useState(false);
  const [runLimit, setRunLimit] = u.useState(0);
  const [historyScope, setHistoryScope] = u.useState('all');
  const [historyType, setHistoryType] = u.useState('all');
  const [charSearch, setCharSearch] = u.useState('');
  const [collapsedChars, setCollapsedChars] = u.useState({});
  const [activeSection, setActiveSection] = u.useState('all');
  const [zoomMedia, setZoomMedia] = u.useState(null);
  const [patchedIds, setPatchedIds] = u.useState([]);
  const [patchNotes, setPatchNotes] = u.useState({});
  const [patchOpen, setPatchOpen] = u.useState(false);
  const [patchTextInput, setPatchTextInput] = u.useState('');

  const base = '/api/gen-normal/projects/' + projectId + '/manga-story';
  const live = u.useRef(true);
  const request = u.useRef(null);
  const promptTextareaRef = u.useRef(null);
  const sec1Ref = u.useRef(null);
  const sec2Ref = u.useRef(null);
  const sec3Ref = u.useRef(null);
  const sec4Ref = u.useRef(null);
  const sec5Ref = u.useRef(null);

  const reload = async (reset = false) => {
    const [current, history] = await Promise.all([ye.get(base), ye.get(base + '/history')]);
    const data = Al(current);
    data.historyRuns = Al(history).runs || [];
    if (!live.current) return;
    setCtx(data);
    if (reset) {
      setCfg(data.config);
      setRevision(data.revision);
      setDirty(false);
      setPreview([]);
      setSelected([]);
      setPatchedIds([]);
      setPatchNotes({});
    }
    return data;
  };

  u.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  u.useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setInterval(() => {
      if (active) reload().catch(() => {});
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, projectId]);

  const act = async (fn, label = 'Đang xử lý…') => {
    setBusy(true);
    setBusyLabel(label);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Không thực hiện được.');
    } finally {
      if (live.current) {
        setBusy(false);
        setBusyLabel('');
      }
    }
  };

  u.useEffect(() => {
    const handleOpenRequest = () => {
      if (!busy) {
        void act(async () => {
          await reload(true);
          setOpen(true);
        }, 'Đang mở cấu hình Manga 60+…');
      }
    };
    window.addEventListener('manga-story-open', handleOpenRequest);
    return () => window.removeEventListener('manga-story-open', handleOpenRequest);
  }, [busy, projectId]);

  const scrollToSection = (key, ref) => {
    setActiveSection(key);
    if (ref?.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const edit = (patch) => {
    setCfg((c) => ({ ...c, ...patch }));
    setDirty(true);
    setPreview([]);
    setSelected([]);
    setVerified(false);
    request.current = null;
  };

  const editChar = (index, patch) =>
    edit({
      characters: cfg.characters.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });

  const save = async () => {
    if (!dirty) return revision;
    const saved = Al(await ye.put(base, { revision, config: cfg }));
    setRevision(saved.revision);
    setDirty(false);
    return saved.revision;
  };

  const applyPromptPatch = (rawText, sourceLabel = 'bản vá') =>
    act(async () => {
      const trimmed = String(rawText ?? '').trim();
      if (!trimmed) throw Error('Nội dung bản vá cảnh lỗi đang trống.');
      const result = Al(
        await ye.post(base + '/patch', {
          revision,
          config: cfg,
          patchText: trimmed,
          allowAppend: true,
        })
      );
      setCfg(result.config);
      setRevision(result.revision);
      setDirty(false);
      setPreview(result.rows || []);
      const patchedList = result.patchedSceneIds || [];
      setPatchedIds(patchedList);
      setPatchNotes(result.notes || {});
      const patchedSet = new Set(patchedList);
      const validPatchedIds = (result.rows || [])
        .filter((r) => r.ready && !r.error && patchedSet.has(r.scene.scene_id))
        .map((r) => r.scene.scene_id);
      setSelected(validPatchedIds);
      setVerified(true);
      setPatchOpen(false);
      setPatchTextInput('');
      setMessage(
        'Đã vá thành công ' +
          patchedList.length +
          ' cảnh từ ' +
          sourceLabel +
          ' (' +
          patchedList.join(', ') +
          ') và tự động tích chọn ' +
          validPatchedIds.length +
          ' cảnh để tạo lại.'
      );
      setTimeout(() => scrollToSection('sec4', sec4Ref), 120);
    }, 'Đang gộp bản vá cảnh lỗi và kiểm tra tham chiếu…');

  const pick = async (index) =>
    act(
      async () => {
        const result = await window.electronAPI.selectImages();
        if (result.canceled || !result.paths?.length) return;
        const a = Al(await ye.post(base + '/assets', { path: result.paths[0] }));
        if (index === -1) {
          edit({ styleAsset: a.asset });
          setMessage('Đã chọn ảnh tham chiếu style. Bấm Lưu cấu hình để lưu lại.');
        } else {
          const targetId = cfg.characters[index]?.id || '#' + (index + 1);
          editChar(index, { asset: a.asset });
          setMessage('Đã gắn ảnh chuẩn cho nhân vật ' + targetId + '. Bấm Lưu cấu hình để lưu lại.');
        }
      },
      index === -1 ? 'Đang tải ảnh style…' : 'Đang tải ảnh chuẩn nhân vật…'
    );

  const importCharacters = async (file) =>
    act(async () => {
      if (!file) return;
      if (file.size > 5000000) throw Error('JSON nhân vật vượt 5 MB.');
      let doc;
      try {
        doc = JSON.parse(await file.text());
      } catch {
        throw Error('JSON không hợp lệ. Chọn story-package.json hoặc JSON có mảng characters.');
      }
      const source = Array.isArray(doc) ? doc : doc?.characters;
      if (!Array.isArray(source) || !source.length) throw Error('JSON không có danh sách characters.');
      if (source.length > 50) throw Error('Tối đa 50 nhân vật.');
      const existing = cfg.characters || [];
      const ids = new Set();
      const characters = source.map((c, index) => {
        const firstOutfit = Array.isArray(c?.outfits) ? c.outfits[0] : null;
        const id = String(c?.id ?? c?.character_id ?? '').trim();
        const name = String(c?.name ?? c?.display_name ?? id).trim();
        const description = String(
          c?.description ?? c?.description_en ?? c?.identity_description_en ?? ''
        ).trim();
        const outfit = String(c?.outfit ?? c?.outfit_en ?? firstOutfit?.description_en ?? '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(id))
          throw Error('Mã nhân vật dòng ' + (index + 1) + ' không hợp lệ: ' + (id || '(trống)'));
        if (ids.has(id)) throw Error('Trùng mã nhân vật: ' + id);
        if (!description) throw Error('Thiếu ngoại hình cho nhân vật ' + id);
        ids.add(id);
        const previous = existing.find((x) => x.id === id || x.name === id);
        return { id, name: name || id, description, outfit, asset: previous?.asset || '' };
      });
      const kept = characters.filter((c) => c.asset).length;
      if (
        !window.confirm(
          'Import ' +
            characters.length +
            ' nhân vật và thay danh sách hiện tại?' +
            (kept ? ' Giữ lại ' + kept + ' ảnh chuẩn có mã hoặc tên cũ trùng ID import.' : '')
        )
      )
        return;
      edit({ characters });
      setMessage(
        'Đã nhập ' + characters.length + ' nhân vật từ ' + file.name + '. Kiểm tra rồi bấm Lưu cấu hình.'
      );
    }, 'Đang đọc file JSON nhân vật…');

  const prepare = async (sceneIds, characterId, characterIds = null) =>
    act(
      async () => {
        const isBatchChars = Array.isArray(characterIds) && characterIds.length > 0;
        if (!characterId && !isBatchChars && !sceneIds.length) throw Error('Chọn ít nhất một cảnh hoặc nhân vật.');
        if (sceneIds.length > 4 && !verified)
          throw Error(
            'Xác nhận đã kiểm tra nhân vật và ảnh tham chiếu trước khi chuẩn bị hơn 4 cảnh.'
          );
        const rev = await save();
        if (!request.current) request.current = crypto.randomUUID();
        await ye.post(base + '/submit', {
          revision: rev,
          sceneIds,
          characterId: characterId || undefined,
          characterIds: isBatchChars ? characterIds : undefined,
          requestId: request.current,
          verified,
        });
        request.current = null;
        if (isBatchChars) {
          setMessage(
            'Đã thêm thành công ' +
              characterIds.length +
              ' job tạo ảnh mẫu 5 góc cho toàn bộ nhân vật. Khi trạng thái Sẵn sàng xuất hiện, bấm Chạy để bắt đầu tạo ảnh.'
          );
        } else if (characterId) {
          setMessage('Đã thêm job tạo ảnh mẫu 5 góc cho ' + characterId + '. Khi trạng thái Sẵn sàng xuất hiện, bấm Chạy lượt này.');
        } else {
          setMessage('Đã chuẩn bị lượt. Khi trạng thái Sẵn sàng xuất hiện, bấm Chạy lượt này.');
        }
        await reload();
        await onUpdated();
        setTimeout(() => scrollToSection('sec5', sec5Ref), 120);
      },
      Array.isArray(characterIds) && characterIds.length > 0
        ? 'Đang chuẩn bị thêm ' + characterIds.length + ' job tạo ảnh mẫu cho toàn bộ nhân vật…'
        : characterId
          ? 'Đang chuẩn bị lượt tạo ảnh mẫu 5 góc cho ' + characterId + '…'
          : 'Đang upload tham chiếu và chuẩn bị ' + sceneIds.length + ' cảnh…'
    );

  const prepareBatchCharacters = (charIds) => {
    if (!charIds || !charIds.length) {
      throw Error('Chưa có nhân vật nào để tạo ảnh mẫu.');
    }
    const emptyDesc = cfg.characters.find(
      (c) => charIds.includes(c.id) && !(c.description || '').trim()
    );
    if (emptyDesc) {
      throw Error(
        'Nhân vật "' + (emptyDesc.name || emptyDesc.id) + '" chưa có mô tả ngoại hình. Hãy nhập mô tả trước khi tạo ảnh mẫu.'
      );
    }
    return prepare([], null, charIds);
  };

  const approve = (row, run, charId = null) =>
    act(
      async () => {
        if (dirty) throw Error('Lưu cấu hình trước khi chọn ảnh.');
        const targetChar =
          charId ||
          run.characterId ||
          (row.sceneId?.startsWith('CHAR_') ? row.sceneId.slice(5) : null);
        await ye.post(base + '/approve', {
          jobId: row.job.id,
          ...(targetChar ? { characterId: targetChar } : {}),
        });
        await reload(!!targetChar);
        setMessage(
          targetChar
            ? 'Đã chọn ảnh chuẩn cho nhân vật ' + targetChar + '.'
            : 'Đã duyệt và lưu ảnh cảnh vào thư viện.'
        );
      },
      (charId || run.characterId) ? 'Đang lưu ảnh chuẩn nhân vật…' : 'Đang duyệt và lưu ảnh cảnh…'
    );

  const adopt = (row, run) =>
    act(
      async () => {
        if (dirty) throw Error('Lưu cấu hình trước khi chọn ảnh.');
        if (!run.targetCharacterId)
          throw Error('Không tìm thấy ID nhân vật tương ứng trong project hiện tại.');
        await ye.post(base + '/adopt', {
          sourceProjectId: run.sourceProjectId,
          jobId: row.job.id,
          targetCharacterId: run.targetCharacterId,
        });
        await reload(true);
        setMessage(
          'Đã dùng ảnh từ project ' +
            run.sourceProjectName +
            ' làm ảnh chuẩn cho ' +
            run.targetCharacterId +
            '.'
        );
      },
      'Đang lấy ảnh chuẩn từ project trước…'
    );

  const insertTagAtCursor = (charId) => {
    if (!charId) return;
    const tag = '@' + charId;
    const el = promptTextareaRef.current;
    const currentText = cfg?.text || '';
    if (el && typeof el.selectionStart === 'number') {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = currentText.slice(0, start);
      const after = currentText.slice(end);
      const needSpaceBefore = before.length > 0 && !/[\s|]$/.test(before);
      const needSpaceAfter = after.length > 0 && !/^[\s,.!?;:]/.test(after);
      const inserted = (needSpaceBefore ? ' ' : '') + tag + (needSpaceAfter ? ' ' : '');
      const nextText = before + inserted + after;
      edit({ text: nextText });
      setMessage('Đã chèn ' + tag + ' vào ô Prompt cảnh.');
      requestAnimationFrame(() => {
        el.focus();
        const cursor = start + inserted.length;
        el.setSelectionRange(cursor, cursor);
      });
    } else {
      const sep = currentText && !currentText.endsWith(' ') && !currentText.endsWith('\n') ? ' ' : '';
      edit({ text: currentText + sep + tag + ' ' });
      setMessage('Đã thêm ' + tag + ' vào cuối Prompt cảnh.');
    }
  };

  const appendNextSceneLine = () => {
    const currentText = cfg?.text || '';
    const existingNums = [...currentText.matchAll(/\bSC(\d+)\b/gi)].map((m) => parseInt(m[1], 10));
    const nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;
    const nextCode = 'SC' + String(nextNum).padStart(3, '0') + ' | ';
    const prefix = currentText.trim().length > 0 && !currentText.endsWith('\n') ? '\n' : '';
    const nextText = currentText + prefix + nextCode;
    edit({ text: nextText });
    setMessage('Đã thêm dòng cảnh mới ' + nextCode.trim());
    requestAnimationFrame(() => {
      const el = promptTextareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextText.length, nextText.length);
      }
    });
  };

  const active = busy || ctx?.runs?.some((r) => r.status === 'PREPARING');

  const btn = (label, fn, disabled = false, variant = 'default') => {
    const variantClass =
      variant === 'primary'
        ? 'manga-btn manga-btn-primary'
        : variant === 'accent'
          ? 'manga-btn manga-btn-accent'
          : variant === 'soft'
            ? 'manga-btn manga-btn-soft'
            : variant === 'danger'
              ? 'manga-btn manga-btn-danger'
              : variant === 'ghost'
                ? 'manga-btn manga-btn-ghost'
                : 'manga-btn';
    return e.jsx('button', {
      type: 'button',
      className: variantClass,
      disabled,
      onClick: fn,
      children: label,
    });
  };

  const sceneLineCount = cfg?.text
    ? cfg.text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean).length
    : 0;
  const readyCharCount = cfg?.characters ? cfg.characters.filter((c) => !!c.asset).length : 0;

  const allHistoryRuns = [...(ctx?.historyRuns || ctx?.runs || [])].reverse();
  const filteredHistoryRuns = allHistoryRuns.filter((run) => {
    if (historyScope === 'current' && run.sourceProjectId && run.sourceProjectId !== projectId) {
      return false;
    }
    if (historyType === 'character' && !run.characterId) return false;
    if (historyType === 'scene' && run.characterId) return false;
    return true;
  });
  const displayedRuns =
    runLimit > 0 ? filteredHistoryRuns.slice(0, runLimit) : filteredHistoryRuns;

  return e.jsxs(e.Fragment, {
    children: [
      e.jsx('button', {
        type: 'button',
        className: 'manga-trigger-btn',
        disabled: busy,
        onClick: () =>
          act(async () => {
            await reload(true);
            setOpen(true);
          }, 'Đang tải cấu hình Manga 60+…'),
        children: 'Bộ ảnh truyện · Manga 60+',
      }),
      open &&
        cfg &&
        e.jsx('div', {
          className: 'manga-modal-backdrop',
          children: e.jsxs('section', {
            role: 'dialog',
            'aria-label': 'Bộ ảnh truyện Manga',
            className: 'manga-modal-dialog',
            children: [
              /* Sticky Top Header, Context, Nav & Interactive Feedback */
              e.jsxs('div', {
                className: 'manga-modal-top',
                children: [
                  e.jsxs('div', {
                    className: 'manga-modal-header',
                    children: [
                      e.jsxs('div', {
                        className: 'manga-modal-title-group',
                        children: [
                          e.jsx('strong', {
                            className: 'manga-modal-title',
                            children: 'Bộ ảnh truyện · Manga đời thường Nhật 60+',
                          }),
                          e.jsx('span', {
                            className: dirty
                              ? 'manga-badge manga-badge-warn'
                              : 'manga-badge manga-badge-ok',
                            children: dirty
                              ? '● Có thay đổi chưa lưu'
                              : '✓ Đã lưu (Rev #' + revision + ')',
                          }),
                          e.jsx('span', {
                            className:
                              readyCharCount === cfg.characters.length && cfg.characters.length > 0
                                ? 'manga-badge manga-badge-ok'
                                : 'manga-badge manga-badge-info',
                            children:
                              'Nhân vật có ảnh chuẩn: ' +
                              readyCharCount +
                              '/' +
                              cfg.characters.length,
                          }),
                        ],
                      }),
                      e.jsxs('div', {
                        style: { display: 'flex', alignItems: 'center', gap: 8 },
                        children: [
                          dirty &&
                            btn(
                              'Lưu ngay',
                              () =>
                                act(async () => {
                                  await save();
                                  setMessage('Đã lưu cấu hình.');
                                }, 'Đang lưu cấu hình…'),
                              active,
                              'primary'
                            ),
                          btn(
                            'Đóng',
                            () => {
                              if (dirty) {
                                setError(
                                  'Bạn có thay đổi chưa lưu. Bấm Lưu cấu hình hoặc Tải lại bản đã lưu trước khi đóng.'
                                );
                                return;
                              }
                              setOpen(false);
                              onUpdated();
                            },
                            busy,
                            'ghost'
                          ),
                        ],
                      }),
                    ],
                  }),
                  e.jsxs('div', {
                    className: 'manga-modal-context-bar',
                    children: [
                      e.jsx('span', {
                        children:
                          'Dùng profile, model và thư mục của project Gen: ' +
                          (ctx?.project?.profiles?.map((p) => p.name || p.id).join(', ') ||
                            'Chưa chọn profile') +
                          ' · ' +
                          (ctx?.project?.imageModelKey || 'GEM_PIX_2') +
                          ' · ' +
                          ctx?.project?.aspectRatio +
                          ' · ' +
                          ctx?.project?.outputDir,
                      }),
                      e.jsx('span', {
                        style: { fontSize: 11, color: '#0f766e', fontWeight: 600 },
                        children:
                          'Luồng chuẩn: 1. Chọn Style → 2. Tạo/chọn ảnh nhân vật → 3. Nhập cảnh → 4. Kiểm tra → 5. Chạy & duyệt',
                      }),
                    ],
                  }),
                  e.jsxs('div', {
                    className: 'manga-nav-tabs',
                    children: [
                      [
                        ['all', 'Tất cả mục', null],
                        ['sec1', '1 · Style chung', sec1Ref],
                        [
                          'sec2',
                          '2 · Nhân vật (' + readyCharCount + '/' + cfg.characters.length + ')',
                          sec2Ref,
                        ],
                        ['sec3', '3 · Prompt cảnh (' + sceneLineCount + ')', sec3Ref],
                        ['sec4', '4 · Kiểm tra (' + preview.length + ')', sec4Ref],
                        [
                          'sec5',
                          '5 · Lịch sử & Kết quả (' + (ctx?.historyRuns?.length || 0) + ')',
                          sec5Ref,
                        ],
                      ].map(([key, label, ref]) =>
                        e.jsx(
                          'button',
                          {
                            type: 'button',
                            className:
                              'manga-nav-tab' +
                              (activeSection === key ? ' manga-nav-tab-active' : ''),
                            onClick: () => scrollToSection(key, ref),
                            children: label,
                          },
                          key
                        )
                      ),
                    ],
                  }),
                  e.jsxs('div', {
                    className: 'manga-feedback-zone',
                    children: [
                      active &&
                        e.jsxs('div', {
                          className: 'manga-alert-banner manga-alert-busy',
                          children: [
                            e.jsxs('span', {
                              style: { display: 'inline-flex', alignItems: 'center' },
                              children: [
                                e.jsx('span', {
                                  className: 'manga-spinner',
                                  'aria-hidden': 'true',
                                }),
                                busyLabel ||
                                  'Đang chuẩn bị dữ liệu và upload ảnh tham chiếu lên Google Flow…',
                              ],
                            }),
                          ],
                        }),
                      error &&
                        e.jsxs('div', {
                          className: 'manga-alert-banner manga-alert-error',
                          children: [
                            e.jsx('p', {
                              role: 'alert',
                              style: { margin: 0, whiteSpace: 'pre-wrap', flex: 1 },
                              children: error,
                            }),
                            e.jsxs('div', {
                              style: { display: 'flex', gap: 6, alignItems: 'center' },
                              children: [
                                dirty &&
                                  btn(
                                    'Lưu & Đóng',
                                    () =>
                                      act(async () => {
                                        await save();
                                        setOpen(false);
                                        onUpdated();
                                      }, 'Đang lưu và đóng…'),
                                    busy,
                                    'primary'
                                  ),
                                dirty &&
                                  btn(
                                    'Bỏ thay đổi & Đóng',
                                    () => {
                                      setDirty(false);
                                      setError('');
                                      setOpen(false);
                                      onUpdated();
                                    },
                                    busy,
                                    'danger'
                                  ),
                                e.jsx('button', {
                                  type: 'button',
                                  className: 'manga-btn manga-btn-ghost',
                                  style: { padding: '3px 8px', fontSize: 11 },
                                  onClick: () => setError(''),
                                  children: 'Ẩn thông báo',
                                }),
                              ],
                            }),
                          ],
                        }),
                      message &&
                        e.jsxs('div', {
                          className: 'manga-alert-banner manga-alert-status',
                          children: [
                            e.jsx('p', {
                              role: 'status',
                              style: { margin: 0, flex: 1 },
                              children: message,
                            }),
                            e.jsx('button', {
                              type: 'button',
                              className: 'manga-btn manga-btn-ghost',
                              style: { padding: '3px 8px', fontSize: 11 },
                              onClick: () => setMessage(''),
                              children: 'Ẩn',
                            }),
                          ],
                        }),
                    ],
                  }),
                ],
              }),

              /* Scrollable Content Area */
              e.jsxs('div', {
                className: 'manga-modal-body',
                children: [
                  /* SECTION 1: STYLE CHUNG */
                  e.jsxs('fieldset', {
                    ref: sec1Ref,
                    disabled: active,
                    className: 'manga-section-card',
                    children: [
                      e.jsx('legend', { children: '1 · Style chung' }),
                      e.jsxs('div', {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 260px',
                          gap: 14,
                          alignItems: 'start',
                        },
                        children: [
                          e.jsxs('div', {
                            style: { display: 'flex', flexDirection: 'column', gap: 8 },
                            children: [
                              e.jsxs('div', {
                                style: {
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                },
                                children: [
                                  e.jsx('span', {
                                    className: 'manga-field-label',
                                    style: { margin: 0 },
                                    children: 'Mô tả phong cách (Style Prompt tiếng Anh)',
                                  }),
                                  btn(
                                    'Áp dụng preset Manga Nhật 60+',
                                    () => {
                                      edit({ style: ctx.preset });
                                      setMessage(
                                        'Đã áp dụng preset style Manga đời thường Nhật 60+. Nhớ bấm Lưu cấu hình.'
                                      );
                                    },
                                    active,
                                    'soft'
                                  ),
                                ],
                              }),
                              e.jsx('textarea', {
                                'aria-label': 'Style bộ ảnh',
                                className: 'manga-field',
                                rows: 4,
                                value: cfg.style,
                                placeholder:
                                  'Nhập style chung hoặc bấm "Áp dụng preset Manga Nhật 60+" ở góc phải...',
                                onChange: (ev) => edit({ style: ev.target.value }),
                              }),
                              e.jsx('p', {
                                style: { fontSize: 12, color: '#475569', margin: 0 },
                                children:
                                  'Style áp dụng cho nhân vật và mọi cảnh. Đổi style không tự thay ảnh chuẩn; hãy kiểm tra lại ảnh nhân vật.',
                              }),
                            ],
                          }),
                          e.jsxs('div', {
                            style: {
                              border: '1px solid #e2e8f0',
                              borderRadius: 8,
                              padding: 10,
                              background: '#f8fafc',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            },
                            children: [
                              e.jsx('span', {
                                className: 'manga-field-label',
                                style: { margin: 0 },
                                children: 'Ảnh tham chiếu Style (tùy chọn)',
                              }),
                              e.jsx(MangaStoryAsset, {
                                base,
                                asset: cfg.styleAsset,
                                onZoom: setZoomMedia,
                              }),
                              e.jsxs('div', {
                                style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                                children: [
                                  btn(
                                    'Chọn ảnh style (tùy chọn)',
                                    () => pick(-1),
                                    active,
                                    'soft'
                                  ),
                                  cfg.styleAsset &&
                                    btn(
                                      'Bỏ ảnh style',
                                      () => {
                                        edit({ styleAsset: '' });
                                        setMessage('Đã bỏ ảnh tham chiếu style.');
                                      },
                                      active,
                                      'danger'
                                    ),
                                ],
                              }),
                              e.jsxs('label', {
                                style: {
                                  fontSize: 12,
                                  color: '#334155',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                  paddingTop: 6,
                                  borderTop: '1px solid #e2e8f0',
                                },
                                children: [
                                  'Giới hạn tham chiếu mỗi cảnh (cần kiểm chứng với model) ',
                                  e.jsx('input', {
                                    'aria-label': 'Giới hạn tham chiếu Manga',
                                    type: 'number',
                                    min: 1,
                                    max: 8,
                                    value: cfg.maxReferences,
                                    onChange: (ev) =>
                                      edit({ maxReferences: Number(ev.target.value) }),
                                    className: 'manga-field',
                                    style: { width: 65, textAlign: 'center' },
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),

                  /* SECTION 2: NHÂN VẬT VÀ ẢNH CHUẨN 5 GÓC */
                  e.jsxs('fieldset', {
                    ref: sec2Ref,
                    disabled: active,
                    className: 'manga-section-card',
                    children: [
                      e.jsx('legend', { children: '2 · Nhân vật và ảnh chuẩn 5 góc' }),
                      e.jsxs('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                          paddingBottom: 8,
                          borderBottom: '1px solid #e2e8f0',
                        },
                        children: [
                          e.jsxs('div', {
                            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                            children: [
                              btn(
                                '+ Thêm nhân vật',
                                () => {
                                  let id = 'CHAR' + (cfg.characters.length + 1);
                                  while (cfg.characters.some((c) => c.id === id)) id += 'X';
                                  edit({
                                    characters: [
                                      ...cfg.characters,
                                      { id, name: '', description: '', outfit: '', asset: '' },
                                    ],
                                  });
                                  setMessage(
                                    'Đã thêm nhân vật mới ' +
                                      id +
                                      '. Nhập ngoại hình và chọn/tạo ảnh chuẩn.'
                                  );
                                },
                                active,
                                'primary'
                              ),
                              e.jsxs('label', {
                                className: 'manga-btn manga-btn-soft',
                                style: { opacity: active ? 0.5 : 1, margin: 0 },
                                children: [
                                  'Import JSON nhân vật',
                                  e.jsx('input', {
                                    'aria-label': 'Import JSON nhân vật Manga',
                                    type: 'file',
                                    accept: '.json,application/json',
                                    disabled: active,
                                    style: { display: 'none' },
                                    onChange: (ev) => {
                                      const file = ev.currentTarget.files?.[0];
                                      if (file) void importCharacters(file);
                                      ev.currentTarget.value = '';
                                    },
                                  }),
                                ],
                              }),
                              cfg.characters.length > 0 && (() => {
                                const validChars = cfg.characters.filter(
                                  (c) => (c.id || '').trim() && (c.description || '').trim()
                                );
                                const missingChars = validChars.filter((c) => !c.asset);
                                return e.jsxs('div', {
                                  style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                                  children: [
                                    validChars.length > 0 &&
                                      btn(
                                        '⚡ Thêm job tạo mẫu tất cả nhân vật (' + validChars.length + ')',
                                        () => prepareBatchCharacters(validChars.map((c) => c.id)),
                                        active,
                                        'accent'
                                      ),
                                    missingChars.length > 0 &&
                                    missingChars.length < validChars.length &&
                                      btn(
                                        '⚡ Tạo mẫu nhân vật chưa có ảnh (' + missingChars.length + ')',
                                        () => prepareBatchCharacters(missingChars.map((c) => c.id)),
                                        active,
                                        'primary'
                                      ),
                                  ],
                                });
                              })(),
                              cfg.characters.length > 2 &&
                                btn(
                                  Object.keys(collapsedChars).length >= cfg.characters.length
                                    ? 'Mở rộng tất cả thẻ'
                                    : 'Thu gọn bớt thẻ',
                                  () => {
                                    if (
                                      Object.keys(collapsedChars).length >= cfg.characters.length
                                    ) {
                                      setCollapsedChars({});
                                    } else {
                                      const next = {};
                                      cfg.characters.forEach((_, idx) => {
                                        next[idx] = true;
                                      });
                                      setCollapsedChars(next);
                                    }
                                  },
                                  active,
                                  'ghost'
                                ),
                            ],
                          }),
                          cfg.characters.length > 2 &&
                            e.jsx('input', {
                              type: 'search',
                              value: charSearch,
                              onChange: (ev) => setCharSearch(ev.target.value),
                              placeholder: 'Tìm nhanh nhân vật theo @ID hoặc tên...',
                              className: 'manga-field',
                              style: { maxWidth: 260, padding: '5px 10px', fontSize: 12 },
                            }),
                        ],
                      }),

                      /* Character Grid */
                      e.jsx('div', {
                        className: 'manga-char-grid',
                        children: cfg.characters.map((c, index) => {
                          const query = charSearch.trim().toLowerCase();
                          const matchesSearch =
                            !query ||
                            (c.id || '').toLowerCase().includes(query) ||
                            (c.name || '').toLowerCase().includes(query) ||
                            (c.description || '').toLowerCase().includes(query);
                          const isCollapsed = !!collapsedChars[index] && !query;
                          const latestCharRun = [...(ctx?.runs || [])]
                            .reverse()
                            .find(
                              (r) =>
                                (r.characterId && r.characterId === c.id) ||
                                (Array.isArray(r.characterIds) && r.characterIds.includes(c.id)) ||
                                r.rows?.some((row) => row.sceneId === 'CHAR_' + c.id)
                            );
                          const latestCharRow =
                            latestCharRun?.rows?.find((row) => row.sceneId === 'CHAR_' + c.id) ||
                            latestCharRun?.rows?.[0];

                          return e.jsxs(
                            'div',
                            {
                              className:
                                'manga-char-card ' +
                                (c.asset ? 'manga-char-card-ready' : 'manga-char-card-missing'),
                              style: matchesSearch ? undefined : { display: 'none' },
                              children: [
                                /* Card Header */
                                e.jsxs('div', {
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                  },
                                  children: [
                                    e.jsxs('div', {
                                      style: { display: 'flex', alignItems: 'center', gap: 6 },
                                      children: [
                                        e.jsx('span', {
                                          style: {
                                            fontSize: 11,
                                            fontWeight: 700,
                                            color: '#64748b',
                                          },
                                          children: '#' + (index + 1),
                                        }),
                                        e.jsx('button', {
                                          type: 'button',
                                          className: 'manga-tag-pill',
                                          title: 'Bấm để chèn @' + (c.id || '') + ' vào Prompt cảnh',
                                          onClick: () => insertTagAtCursor(c.id),
                                          children: '@' + (c.id || 'CHUA_DAT_MA'),
                                        }),
                                        c.name &&
                                          e.jsx('strong', {
                                            style: { fontSize: 13, color: '#0f172a' },
                                            children: c.name,
                                          }),
                                      ],
                                    }),
                                    e.jsxs('div', {
                                      style: { display: 'flex', alignItems: 'center', gap: 6 },
                                      children: [
                                        e.jsx('span', {
                                          className: c.asset
                                            ? 'manga-badge manga-badge-ok'
                                            : 'manga-badge manga-badge-warn',
                                          children: c.asset
                                            ? '✓ Đã có ảnh chuẩn'
                                            : '⚠ Chưa có ảnh chuẩn',
                                        }),
                                        cfg.characters.length > 2 &&
                                          e.jsx('button', {
                                            type: 'button',
                                            className: 'manga-btn manga-btn-ghost',
                                            style: { padding: '2px 7px', fontSize: 11 },
                                            onClick: () =>
                                              setCollapsedChars((old) => ({
                                                ...old,
                                                [index]: !old[index],
                                              })),
                                            children: isCollapsed ? 'Mở' : 'Gọn',
                                          }),
                                      ],
                                    }),
                                  ],
                                }),

                                /* Fields (kept mounted in DOM so Playwright getByLabel always works) */
                                e.jsxs('div', {
                                  style: isCollapsed
                                    ? { display: 'none' }
                                    : { display: 'grid', gap: 8 },
                                  children: [
                                    e.jsxs('div', {
                                      style: {
                                        display: 'grid',
                                        gridTemplateColumns: '1fr 1fr',
                                        gap: 8,
                                      },
                                      children: [
                                        e.jsxs('div', {
                                          children: [
                                            e.jsx('span', {
                                              className: 'manga-field-label',
                                              children: 'Mã nhân vật (dùng với @)',
                                            }),
                                            e.jsx('input', {
                                              'aria-label': 'Mã nhân vật ' + index,
                                              className: 'manga-field',
                                              value: c.id,
                                              placeholder: 'KEIKO_HOME',
                                              onChange: (ev) =>
                                                editChar(index, { id: ev.target.value }),
                                            }),
                                          ],
                                        }),
                                        e.jsxs('div', {
                                          children: [
                                            e.jsx('span', {
                                              className: 'manga-field-label',
                                              children: 'Tên nhân vật',
                                            }),
                                            e.jsx('input', {
                                              'aria-label': 'Tên nhân vật ' + index,
                                              className: 'manga-field',
                                              value: c.name,
                                              placeholder: 'Keiko',
                                              onChange: (ev) =>
                                                editChar(index, { name: ev.target.value }),
                                            }),
                                          ],
                                        }),
                                      ],
                                    }),
                                    e.jsxs('div', {
                                      children: [
                                        e.jsx('span', {
                                          className: 'manga-field-label',
                                          children:
                                            'Ngoại hình cố định (tuổi, khuôn mặt, kiểu tóc, vóc dáng)',
                                        }),
                                        e.jsx('textarea', {
                                          'aria-label': 'Ngoại hình nhân vật ' + index,
                                          className: 'manga-field',
                                          rows: 2,
                                          value: c.description,
                                          placeholder: 'Tuổi, khuôn mặt, tóc, vóc dáng cố định',
                                          onChange: (ev) =>
                                            editChar(index, { description: ev.target.value }),
                                        }),
                                      ],
                                    }),
                                    e.jsxs('div', {
                                      children: [
                                        e.jsx('span', {
                                          className: 'manga-field-label',
                                          children: 'Trang phục của mã nhân vật này',
                                        }),
                                        e.jsx('input', {
                                          'aria-label': 'Trang phục nhân vật ' + index,
                                          className: 'manga-field',
                                          value: c.outfit,
                                          placeholder: 'Trang phục',
                                          onChange: (ev) =>
                                            editChar(index, { outfit: ev.target.value }),
                                        }),
                                      ],
                                    }),
                                  ],
                                }),

                                /* Asset & Inline Latest Sample Run Status */
                                e.jsxs('div', {
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 12,
                                    flexWrap: 'wrap',
                                    background: '#ffffff',
                                    padding: 8,
                                    borderRadius: 8,
                                    border: '1px solid #e2e8f0',
                                  },
                                  children: [
                                    e.jsx(MangaStoryAsset, {
                                      base,
                                      asset: c.asset,
                                      onZoom: setZoomMedia,
                                    }),
                                    latestCharRun &&
                                      e.jsxs('div', {
                                        style: {
                                          flex: 1,
                                          minWidth: 180,
                                          fontSize: 11.5,
                                          color: '#334155',
                                          background: '#f0fdfa',
                                          border: '1px solid #99f6e4',
                                          borderRadius: 6,
                                          padding: '6px 8px',
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: 4,
                                        },
                                        children: [
                                          e.jsx('strong', {
                                            style: { color: '#0f766e' },
                                            children:
                                              'Lượt tạo ảnh mẫu gần nhất: ' +
                                              (latestCharRun.status === 'PREPARING'
                                                ? 'Đang chuẩn bị…'
                                                : latestCharRun.status === 'READY'
                                                  ? latestCharRow?.job?.status || 'Sẵn sàng'
                                                  : latestCharRun.status),
                                          }),
                                          latestCharRow?.job?.resultUrl &&
                                            e.jsx('img', {
                                              src: Lr(latestCharRow.job.resultUrl),
                                              alt: 'Ảnh mẫu ' + c.id,
                                              style: {
                                                height: 64,
                                                maxWidth: 120,
                                                objectFit: 'contain',
                                                borderRadius: 4,
                                                background: '#fff',
                                                border: '1px solid #cbd5e1',
                                                cursor: 'zoom-in',
                                              },
                                              onClick: () =>
                                                setZoomMedia({
                                                  url: Lr(latestCharRow.job.resultUrl),
                                                  title: 'Ảnh mẫu ' + c.id,
                                                }),
                                            }),
                                          e.jsxs('div', {
                                            style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                                            children: [
                                              latestCharRun.status === 'READY' &&
                                                latestCharRow?.job?.status === 'DRAFT' &&
                                                btn(
                                                  'Bắt đầu chạy mẫu ' + c.id,
                                                  () =>
                                                    act(async () => {
                                                      await ye.post(base + '/start', {
                                                        runId: latestCharRun.id,
                                                      });
                                                      await reload();
                                                      await onUpdated();
                                                      setMessage(
                                                        'Đã bắt đầu tạo ảnh mẫu 5 góc cho ' +
                                                          c.id +
                                                          '.'
                                                      );
                                                    }, 'Đang kích hoạt lượt tạo ảnh mẫu…'),
                                                  active,
                                                  'primary'
                                                ),
                                              latestCharRow?.job?.status === 'COMPLETED' &&
                                                btn(
                                                  'Dùng mẫu vừa tạo',
                                                  () => approve(latestCharRow, latestCharRun, c.id),
                                                  active,
                                                  'primary'
                                                ),
                                              btn(
                                                'Xem ở mục 5',
                                                () => scrollToSection('sec5', sec5Ref),
                                                false,
                                                'ghost'
                                              ),
                                            ],
                                          }),
                                        ],
                                      }),
                                  ],
                                }),

                                /* Card Action Buttons */
                                e.jsxs('div', {
                                  style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                                  children: [
                                    btn(
                                      c.asset ? 'Đổi ảnh chuẩn' : 'Chọn ảnh chuẩn',
                                      () => pick(index),
                                      active,
                                      'soft'
                                    ),
                                    btn(
                                      'Tạo ảnh mẫu ' + (c.id || ''),
                                      () => prepare([], c.id),
                                      active || !c.id || !c.description.trim(),
                                      'primary'
                                    ),
                                    btn(
                                      'Thêm biến thể trang phục',
                                      () => {
                                        let next = c.id + '_OUT';
                                        while (cfg.characters.some((x) => x.id === next))
                                          next += '_2';
                                        edit({
                                          characters: [
                                            ...cfg.characters,
                                            { ...c, id: next, outfit: '' },
                                          ],
                                        });
                                        setMessage(
                                          'Đã tạo biến thể trang phục ' +
                                            next +
                                            ' giữ nguyên khuôn mặt từ ' +
                                            c.id +
                                            '.'
                                        );
                                      },
                                      active,
                                      'default'
                                    ),
                                    btn(
                                      'Bỏ nhân vật',
                                      () => {
                                        if (
                                          (c.description?.trim() || c.asset) &&
                                          !window.confirm(
                                            'Xóa nhân vật ' +
                                              (c.id || '#' + (index + 1)) +
                                              ' khỏi cấu hình?'
                                          )
                                        ) {
                                          return;
                                        }
                                        edit({
                                          characters: cfg.characters.filter((_, i) => i !== index),
                                        });
                                        setMessage(
                                          'Đã bỏ nhân vật ' + (c.id || '#' + (index + 1)) + '.'
                                        );
                                      },
                                      active,
                                      'danger'
                                    ),
                                  ],
                                }),
                              ],
                            },
                            index
                          );
                        }),
                      }),

                      e.jsx('p', {
                        style: { fontSize: 12, color: '#475569', margin: '4px 0 0' },
                        children:
                          'Import nhận story-package.json, mảng characters hoặc JSON story-prompts; thay danh sách hiện tại và giữ ảnh chuẩn khi mã hoặc tên cũ trùng ID mới. Tạo ảnh mẫu sinh một bảng 5 góc: toàn thân trước, toàn thân sau, cận mặt chính diện, nghiêng và 3/4 trên nền trắng; dùng style đang chọn. Biến thể dùng ảnh chuẩn gốc để giữ khuôn mặt khi đổi trang phục. Chọn ảnh đạt ở mục Kết quả. Các job cũ giữ prompt cũ; bấm Tạo ảnh mẫu để tạo lượt mới.',
                      }),
                    ],
                  }),

                  /* SECTION 3: PROMPT TỪNG CẢNH */
                  e.jsxs('fieldset', {
                    ref: sec3Ref,
                    disabled: active,
                    className: 'manga-section-card',
                    children: [
                      e.jsx('legend', { children: '3 · Prompt từng cảnh' }),
                      e.jsxs('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        },
                        children: [
                          e.jsx('p', {
                            style: { fontSize: 12, color: '#475569', margin: 0 },
                            children:
                              'Mỗi dòng một cảnh. Ví dụ SC001 | @KEIKO_HOME uống trà trong bếp. Chỉ dùng @ID cho người xuất hiện trong hình.',
                          }),
                          e.jsx('span', {
                            className: 'manga-badge manga-badge-info',
                            children: sceneLineCount + ' dòng cảnh',
                          }),
                        ],
                      }),

                      /* Quick @ID Tag Insertion Bar */
                      cfg.characters.length > 0 &&
                        e.jsxs('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                            padding: '6px 10px',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 8,
                          },
                          children: [
                            e.jsx('span', {
                              style: { fontSize: 11.5, fontWeight: 600, color: '#475569' },
                              children: 'Chèn nhanh @ID vào con trỏ:',
                            }),
                            ...cfg.characters
                              .filter((c) => c.id)
                              .map((c) =>
                                e.jsxs(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'manga-tag-pill',
                                    disabled: active,
                                    onClick: () => insertTagAtCursor(c.id),
                                    title:
                                      (c.name ? c.name + ' · ' : '') +
                                      (c.asset ? 'Đã có ảnh chuẩn' : 'Chưa có ảnh chuẩn'),
                                    children: [
                                      '@' + c.id,
                                      e.jsx('span', {
                                        style: {
                                          color: c.asset ? '#10b981' : '#f59e0b',
                                          fontSize: 10,
                                        },
                                        children: c.asset ? '●' : '○',
                                      }),
                                    ],
                                  },
                                  c.id
                                )
                              ),
                            e.jsx('button', {
                              type: 'button',
                              className: 'manga-btn manga-btn-ghost',
                              style: { padding: '3px 8px', fontSize: 11, marginLeft: 'auto' },
                              disabled: active,
                              onClick: appendNextSceneLine,
                              children: '+ Thêm dòng SC mới',
                            }),
                          ],
                        }),

                      e.jsx('textarea', {
                        ref: promptTextareaRef,
                        'aria-label': 'Prompt cảnh Manga',
                        className: 'manga-field',
                        style: {
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          lineHeight: 1.5,
                        },
                        rows: 7,
                        value: cfg.text,
                        placeholder:
                          'SC001 | @KEIKO_HOME uống trà trong bếp.\nSC002 | @KENJI bước vào hành lang.',
                        onChange: (ev) => edit({ text: ev.target.value }),
                      }),

                      e.jsxs('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                        },
                        children: [
                          e.jsxs('div', {
                            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
                            children: [
                              e.jsxs('label', {
                                className: 'manga-btn manga-btn-soft',
                                style: { margin: 0 },
                                children: [
                                  'Import TXT ',
                                  e.jsx('input', {
                                    'aria-label': 'Import TXT Manga',
                                    type: 'file',
                                    accept: '.txt',
                                    style: { display: 'none' },
                                    onChange: (ev) => {
                                      const file = ev.target.files?.[0];
                                      if (file)
                                        act(async () => {
                                          if (file.size > 1000000) throw Error('TXT quá lớn.');
                                          const text = await file.text();
                                          edit({ text });
                                          setPatchedIds([]);
                                          setPatchNotes({});
                                          const count = text
                                            .split(/\r?\n/)
                                            .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
                                          setMessage(
                                            'Đã nạp ' +
                                              count +
                                              ' dòng cảnh từ ' +
                                              file.name +
                                              '. Bấm Kiểm tra cảnh để xem tham chiếu.'
                                          );
                                        }, 'Đang đọc file TXT…');
                                      ev.target.value = '';
                                    },
                                  }),
                                ],
                              }),
                              e.jsxs('label', {
                                className: 'manga-btn manga-btn-accent',
                                style: { margin: 0 },
                                title:
                                  'Chọn file báo cáo sửa cảnh lỗi (.txt hoặc .json) để chỉ cập nhật các cảnh lỗi và tự động tích chọn tạo lại',
                                children: [
                                  '🩹 Nhập file sửa cảnh lỗi (.txt/.json)',
                                  e.jsx('input', {
                                    'aria-label': 'Nhập file sửa cảnh lỗi Manga',
                                    type: 'file',
                                    accept: '.txt,.json,text/plain,application/json',
                                    style: { display: 'none' },
                                    onChange: (ev) => {
                                      const file = ev.target.files?.[0];
                                      if (file) {
                                        void (async () => {
                                          if (file.size > 1000000) {
                                            setError('File bản vá quá lớn (tối đa 1 MB).');
                                            return;
                                          }
                                          const raw = await file.text();
                                          await applyPromptPatch(raw, file.name);
                                        })();
                                      }
                                      ev.target.value = '';
                                    },
                                  }),
                                ],
                              }),
                              btn(
                                patchOpen ? 'Đóng khung dán bản vá' : '📋 Dán bản vá cảnh lỗi',
                                () => setPatchOpen((v) => !v),
                                active,
                                'soft'
                              ),
                            ],
                          }),
                          e.jsxs('div', {
                            style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
                            children: [
                              btn(
                                'Lưu cấu hình',
                                () =>
                                  act(async () => {
                                    await save();
                                    setMessage('Đã lưu cấu hình.');
                                  }, 'Đang lưu cấu hình…'),
                                active,
                                'primary'
                              ),
                              btn(
                                'Kiểm tra cảnh',
                                () =>
                                  act(async () => {
                                    await save();
                                    const result = Al(await ye.post(base + '/preview', cfg));
                                    setPreview(result.rows);
                                    const validIds = result.rows
                                      .filter((r) => r.ready && !r.error)
                                      .map((r) => r.scene.scene_id);
                                    setSelected(validIds);
                                    setMessage(
                                      'Đã kiểm tra ' +
                                        result.rows.length +
                                        ' cảnh: ' +
                                        validIds.length +
                                        ' cảnh hợp lệ sẵn sàng chuẩn bị.'
                                    );
                                    setTimeout(() => scrollToSection('sec4', sec4Ref), 100);
                                  }, 'Đang kiểm tra nhân vật và ảnh tham chiếu từng cảnh…'),
                                active,
                                'accent'
                              ),
                              btn(
                                'Tải lại bản đã lưu',
                                () =>
                                  act(async () => {
                                    await reload(true);
                                    setMessage('Đã tải lại bản cấu hình đã lưu.');
                                  }, 'Đang tải lại bản đã lưu…'),
                                active,
                                'ghost'
                              ),
                            ],
                          }),
                        ],
                      }),

                      patchOpen &&
                        e.jsxs('div', {
                          style: {
                            marginTop: 8,
                            padding: 10,
                            borderRadius: 8,
                            background: '#fffbeb',
                            border: '1px solid #fcd34d',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          },
                          children: [
                            e.jsx('span', {
                              style: { fontSize: 12, fontWeight: 600, color: '#92400e' },
                              children:
                                'Dán các dòng cảnh lỗi cần sửa (hỗ trợ chú thích # phía trên mỗi mã UTxxx_x | prompt):',
                            }),
                            e.jsx('textarea', {
                              'aria-label': 'Nội dung bản vá cảnh lỗi Manga',
                              className: 'manga-field',
                              rows: 5,
                              value: patchTextInput,
                              placeholder:
                                '# Lỗi lệch nhân vật cảnh UT012_C\nUT012_C | @HARUKO_HOME ngồi uống trà tại bàn gỗ...',
                              onChange: (ev) => setPatchTextInput(ev.target.value),
                            }),
                            e.jsxs('div', {
                              style: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
                              children: [
                                btn(
                                  'Hủy',
                                  () => {
                                    setPatchOpen(false);
                                    setPatchTextInput('');
                                  },
                                  active,
                                  'ghost'
                                ),
                                btn(
                                  'Áp dụng bản vá & Chọn cảnh lỗi',
                                  () => applyPromptPatch(patchTextInput, 'khung dán trực tiếp'),
                                  active || !patchTextInput.trim(),
                                  'primary'
                                ),
                              ],
                            }),
                          ],
                        }),
                    ],
                  }),

                  /* SECTION 4: KIỂM TRA VÀ CHỌN CẢNH */
                  preview.length > 0 &&
                    e.jsxs('div', {
                      ref: sec4Ref,
                      className: 'manga-section-card',
                      children: [
                        e.jsxs('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            flexWrap: 'wrap',
                          },
                          children: [
                            e.jsxs('div', {
                              style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                              children: [
                                e.jsx('strong', {
                                  className: 'manga-section-title',
                                  children:
                                    '4 · Kiểm tra và chọn cảnh (' +
                                    selected.length +
                                    '/' +
                                    preview.length +
                                    ')',
                                }),
                                patchedIds.length > 0 &&
                                  e.jsx('span', {
                                    className: 'manga-badge manga-badge-warn',
                                    children: '🩹 Đã vá ' + patchedIds.length + ' cảnh lỗi',
                                  }),
                              ],
                            }),
                            e.jsxs('div', {
                              style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                              children: [
                                patchedIds.length > 0 &&
                                  btn(
                                    '🩹 Chọn riêng cảnh vừa vá (' + patchedIds.length + ')',
                                    () =>
                                      setSelected(
                                        preview
                                          .filter(
                                            (r) =>
                                              r.ready &&
                                              !r.error &&
                                              patchedIds.includes(r.scene.scene_id)
                                          )
                                          .map((r) => r.scene.scene_id)
                                      ),
                                    active,
                                    'accent'
                                  ),
                                btn(
                                  'Chọn cảnh hợp lệ',
                                  () =>
                                    setSelected(
                                      preview
                                        .filter((r) => r.ready && !r.error)
                                        .map((r) => r.scene.scene_id)
                                    ),
                                  active,
                                  'soft'
                                ),
                                btn('Bỏ chọn', () => setSelected([]), active, 'ghost'),
                              ],
                            }),
                          ],
                        }),
                        e.jsx('div', {
                          style: {
                            display: 'grid',
                            gap: 8,
                            maxHeight: 360,
                            overflowY: 'auto',
                            paddingRight: 4,
                          },
                          children: preview.map((row) => {
                            const isPatched = patchedIds.includes(row.scene.scene_id);
                            const qaNote = patchNotes[row.scene.scene_id];
                            const hasWarnings = Array.isArray(row.warnings) && row.warnings.length > 0;
                            return e.jsxs(
                              'div',
                              {
                                style: {
                                  border:
                                    '1px solid ' +
                                    (row.error
                                      ? '#fecaca'
                                      : isPatched
                                        ? '#6ee7b7'
                                        : hasWarnings
                                          ? '#fde68a'
                                          : '#e2e8f0'),
                                  background: row.error
                                    ? '#fef2f2'
                                    : isPatched
                                      ? '#ecfdf5'
                                      : '#f8fafc',
                                  borderRadius: 8,
                                  padding: '8px 12px',
                                },
                                children: [
                                  e.jsxs('label', {
                                    style: {
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      fontWeight: 600,
                                      fontSize: 13,
                                      cursor: 'pointer',
                                      flexWrap: 'wrap',
                                    },
                                    children: [
                                      e.jsx('input', {
                                        type: 'checkbox',
                                        disabled: active || !row.ready || !!row.error,
                                        checked: selected.includes(row.scene.scene_id),
                                        onChange: (ev) =>
                                          setSelected((s) =>
                                            ev.target.checked
                                              ? [...s, row.scene.scene_id]
                                              : s.filter((id) => id !== row.scene.scene_id)
                                          ),
                                      }),
                                      isPatched &&
                                        e.jsx('span', {
                                          className: 'manga-badge manga-badge-ok',
                                          children: '🩹 Vừa vá lỗi',
                                        }),
                                      row.scene.scene_id + ' · ' + row.scene.prompt_en,
                                    ],
                                  }),
                                  qaNote &&
                                    e.jsx('p', {
                                      style: {
                                        fontSize: 11.5,
                                        color: '#065f46',
                                        margin: '4px 0 0',
                                        fontStyle: 'italic',
                                      },
                                      children: 'Ghi chú QA: ' + qaNote,
                                    }),
                                  e.jsx('p', {
                                    style: {
                                      fontSize: 12,
                                      color: row.error ? '#b91c1c' : '#0f766e',
                                      margin: '4px 0',
                                    },
                                    children:
                                      row.error ||
                                      'Tham chiếu: ' +
                                        (row.images
                                          .map((img) => img.characterId || 'Style')
                                          .join(' → ') || 'Không có'),
                                  }),
                                  hasWarnings &&
                                    row.warnings.map((w, wi) =>
                                      e.jsx(
                                        'p',
                                        {
                                          style: {
                                            fontSize: 11.5,
                                            color: '#b45309',
                                            background: '#fffbeb',
                                            border: '1px solid #fde68a',
                                            borderRadius: 6,
                                            padding: '4px 8px',
                                            margin: '4px 0',
                                          },
                                          children: '⚠ ' + w,
                                        },
                                        wi
                                      )
                                    ),
                                  e.jsxs('details', {
                                    children: [
                                      e.jsx('summary', {
                                        style: {
                                          fontSize: 11.5,
                                          color: '#475569',
                                          cursor: 'pointer',
                                        },
                                        children: 'Xem prompt cuối',
                                      }),
                                      e.jsx('pre', {
                                        style: {
                                          whiteSpace: 'pre-wrap',
                                          fontSize: 11.5,
                                          background: '#ffffff',
                                          padding: 8,
                                          borderRadius: 6,
                                          border: '1px solid #e2e8f0',
                                          marginTop: 4,
                                        },
                                        children: row.prompt,
                                      }),
                                    ],
                                  }),
                                ],
                              },
                              row.scene.scene_id
                            );
                          }),
                        }),
                        e.jsxs('label', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            margin: '6px 0',
                            fontSize: 13,
                            cursor: 'pointer',
                          },
                          children: [
                            e.jsx('input', {
                              type: 'checkbox',
                              checked: verified,
                              onChange: (ev) => setVerified(ev.target.checked),
                              disabled: active,
                            }),
                            ' Tôi xác nhận đã kiểm tra nhân vật và ảnh tham chiếu để chuẩn bị nhiều cảnh. Không bắt buộc duyệt ảnh.',
                          ],
                        }),
                        e.jsxs('div', {
                          style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
                          children: [
                            btn(
                              'Chuẩn bị thử (tối đa 4 cảnh)',
                              () => prepare(selected.slice(0, 4)),
                              active || !selected.length,
                              'soft'
                            ),
                            btn(
                              'Chuẩn bị ' + selected.length + ' cảnh',
                              () => prepare(selected),
                              active || !selected.length || (selected.length > 4 && !verified),
                              'primary'
                            ),
                          ],
                        }),
                      ],
                    }),

                  /* SECTION 5: TOÀN BỘ LỊCH SỬ LƯỢT TẠO VÀ KẾT QUẢ */
                  e.jsxs('div', {
                    ref: sec5Ref,
                    className: 'manga-section-card',
                    children: [
                      e.jsxs('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                        },
                        children: [
                          e.jsx('strong', {
                            className: 'manga-section-title',
                            children:
                              '5 · Toàn bộ lịch sử lượt tạo và kết quả (' +
                              (ctx?.historyRuns?.length || 0) +
                              ' lượt)',
                          }),
                          e.jsxs('div', {
                            style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
                            children: [
                              e.jsxs('select', {
                                value: historyScope,
                                onChange: (ev) => setHistoryScope(ev.target.value),
                                className: 'manga-field',
                                style: { width: 'auto', padding: '4px 8px', fontSize: 12 },
                                children: [
                                  e.jsx('option', {
                                    value: 'all',
                                    children: 'Mọi project (' + allHistoryRuns.length + ')',
                                  }),
                                  e.jsx('option', {
                                    value: 'current',
                                    children: 'Chỉ project hiện tại',
                                  }),
                                ],
                              }),
                              e.jsxs('select', {
                                value: historyType,
                                onChange: (ev) => setHistoryType(ev.target.value),
                                className: 'manga-field',
                                style: { width: 'auto', padding: '4px 8px', fontSize: 12 },
                                children: [
                                  e.jsx('option', { value: 'all', children: 'Tất cả loại lượt' }),
                                  e.jsx('option', {
                                    value: 'character',
                                    children: 'Chỉ ảnh mẫu nhân vật',
                                  }),
                                  e.jsx('option', { value: 'scene', children: 'Chỉ bộ cảnh truyện' }),
                                ],
                              }),
                              e.jsxs('select', {
                                value: String(runLimit),
                                onChange: (ev) => setRunLimit(Number(ev.target.value)),
                                className: 'manga-field',
                                style: { width: 'auto', padding: '4px 8px', fontSize: 12 },
                                children: [
                                  e.jsx('option', { value: '0', children: 'Hiển thị tất cả' }),
                                  e.jsx('option', { value: '10', children: '10 lượt mới nhất' }),
                                  e.jsx('option', { value: '25', children: '25 lượt mới nhất' }),
                                  e.jsx('option', { value: '50', children: '50 lượt mới nhất' }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                      e.jsx('p', {
                        style: { fontSize: 12, color: '#475569', margin: 0 },
                        children:
                          'Hiển thị toàn bộ lịch sử Manga ở mọi project, mới nhất ở trên. Lượt thuộc project hiện tại có thể chạy; ảnh hoàn thành ở project cũ có thể dùng làm ảnh chuẩn cho ID tương ứng.',
                      }),
                      ...displayedRuns.map((run) =>
                        e.jsxs(
                          'div',
                          {
                            className: 'manga-run-card',
                            children: [
                              e.jsxs('div', {
                                style: {
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                },
                                children: [
                                  e.jsx('b', {
                                    style: { fontSize: 13, color: '#0f172a' },
                                    children:
                                      (run.characterId
                                        ? 'Ảnh mẫu ' + run.characterId
                                        : 'Bộ ' + run.rows.length + ' cảnh') +
                                      ' · ' +
                                      (run.status === 'PREPARING'
                                        ? 'Đang chuẩn bị'
                                        : run.status === 'READY'
                                          ? 'Sẵn sàng'
                                          : run.status) +
                                      ' · ' +
                                      new Date(run.createdAt).toLocaleString() +
                                      ' · Project: ' +
                                      (run.sourceProjectName || ctx?.project?.name || 'Hiện tại'),
                                  }),
                                  (!run.sourceProjectId || run.sourceProjectId === projectId) &&
                                    run.status === 'READY' &&
                                    run.rows.some((r) => r.job?.status === 'DRAFT') &&
                                    btn(
                                      'Chạy lượt này',
                                      () =>
                                        act(async () => {
                                          await ye.post(base + '/start', { runId: run.id });
                                          await reload();
                                          await onUpdated();
                                          setMessage(
                                            'Đã kích hoạt chạy lượt ' +
                                              (run.characterId
                                                ? 'ảnh mẫu ' + run.characterId
                                                : run.rows.length + ' cảnh') +
                                              '.'
                                          );
                                        }, 'Đang bắt đầu chạy lượt này…'),
                                      active,
                                      'primary'
                                    ),
                                ],
                              }),
                              run.error &&
                                e.jsx('p', {
                                  style: { color: '#b91c1c', fontSize: 12.5, margin: '6px 0 0' },
                                  children: run.error,
                                }),
                              e.jsx('div', {
                                style: {
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 12,
                                  marginTop: 10,
                                },
                                children: run.rows.map((row) =>
                                  e.jsxs(
                                    'div',
                                    {
                                      className: 'manga-scene-result-card',
                                      children: [
                                        e.jsxs('div', {
                                          style: {
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 6,
                                          },
                                          children: [
                                            e.jsx('b', {
                                              style: { fontSize: 12.5, color: '#0f172a' },
                                              children: row.sceneId,
                                            }),
                                            e.jsx('span', {
                                              className:
                                                (row.job?.status || run.status) === 'COMPLETED'
                                                  ? 'manga-badge manga-badge-ok'
                                                  : (row.job?.status || run.status) === 'FAILED'
                                                    ? 'manga-badge manga-badge-error'
                                                    : 'manga-badge manga-badge-info',
                                              children: row.job?.status || run.status,
                                            }),
                                          ],
                                        }),
                                        e.jsx(MangaReferenceStrip, {
                                          projectId: run.sourceProjectId || projectId,
                                          images: row.images || [],
                                          sceneId: row.sceneId,
                                          onZoom: setZoomMedia,
                                        }),
                                        row.job?.resultUrl &&
                                          e.jsx('img', {
                                            src: Lr(row.job.resultUrl),
                                            alt: row.sceneId,
                                            title: 'Bấm để phóng to ảnh kết quả',
                                            style: {
                                              width: '100%',
                                              height: 135,
                                              objectFit: 'contain',
                                              borderRadius: 6,
                                              background: '#f8fafc',
                                              border: '1px solid #e2e8f0',
                                              cursor: 'zoom-in',
                                            },
                                            onClick: () =>
                                              setZoomMedia({
                                                url: Lr(row.job.resultUrl),
                                                title: row.sceneId,
                                              }),
                                          }),
                                        row.job?.error &&
                                          e.jsx('p', {
                                            style: { color: '#b91c1c', fontSize: 12, margin: 0 },
                                            children: row.job.error,
                                          }),
                                        row.job?.status === 'COMPLETED' &&
                                          (run.sourceProjectId && run.sourceProjectId !== projectId
                                            ? run.targetCharacterId &&
                                              btn(
                                                'Dùng làm ảnh chuẩn ' + run.targetCharacterId,
                                                () => adopt(row, run),
                                                active,
                                                'primary'
                                              )
                                            : btn(
                                                run.characterId
                                                  ? 'Chọn làm ảnh chuẩn'
                                                  : ctx.approved?.[row.sceneId]?.jobId ===
                                                      row.job.id
                                                    ? 'Đã duyệt ảnh này'
                                                    : 'Duyệt và lưu ảnh',
                                                () => approve(row, run),
                                                active ||
                                                  ctx.approved?.[row.sceneId]?.jobId === row.job.id,
                                                ctx.approved?.[row.sceneId]?.jobId === row.job.id
                                                  ? 'soft'
                                                  : 'primary'
                                              )),
                                      ],
                                    },
                                    row.sceneId
                                  )
                                ),
                              }),
                            ],
                          },
                          (run.sourceProjectId || projectId) + '-' + run.id
                        )
                      ),
                    ],
                  }),
                ],
              }),
            ],
          }),
        }),
      zoomMedia &&
        e.jsx('div', {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 10005,
            background: 'rgba(15, 23, 42, 0.85)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          },
          onClick: () => setZoomMedia(null),
          children: e.jsxs('div', {
            style: {
              maxWidth: '92vw',
              maxHeight: '90vh',
              background: '#ffffff',
              borderRadius: 12,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            },
            onClick: (ev) => ev.stopPropagation(),
            children: [
              e.jsxs('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                },
                children: [
                  e.jsx('strong', {
                    style: { fontSize: 13, color: '#0f172a' },
                    children: zoomMedia.title || 'Xem ảnh',
                  }),
                  btn('Thu nhỏ ảnh', () => setZoomMedia(null), false, 'ghost'),
                ],
              }),
              e.jsx('img', {
                src: zoomMedia.url,
                alt: zoomMedia.title || 'Preview',
                style: {
                  maxWidth: '88vw',
                  maxHeight: '80vh',
                  objectFit: 'contain',
                  borderRadius: 8,
                  background: '#f8fafc',
                },
              }),
            ],
          }),
        }),
    ],
  });
}
/* MANGA_STORY_UI_END */
