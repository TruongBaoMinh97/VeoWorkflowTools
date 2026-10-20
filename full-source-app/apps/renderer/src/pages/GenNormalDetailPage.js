const P4 = ({ projectId: t, onBack: s }) => {
    const r = u.useRef(!1);
    u.useEffect(
      () => (
        console.log("[GenNormalDetailPage] Mounted", { projectId: t }),
        (r.current = !0),
        () => {
          console.log("[GenNormalDetailPage] Unmounted"), (r.current = !1);
        }
      ),
      [t],
    );
    const {
      project: l,
      setProject: o,
      loadProject: c,
      loading: h,
    } = W3({ projectId: t });
    u.useEffect(() => {
      if (!l) return;
      const E = l.autoUpscaleVideo || l.autoUpscaleImage;
      E !== void 0 && Fl(!!E);
      const D = Da(l, "imageUpscaleRes"),
        K = Da(l, "videoUpscaleRes"),
        te =
          l.inputMethod === "IMAGE_GENERATION" ||
          l.inputMethod === "IMAGE_GENERATION_BATCH_REFS"
            ? D
            : K;
      te && Sa(te);
      const le = Da(l, "imageUpscaleConcurrency");
      le && le >= 1 && le <= 4 && Hl(le),
        Wr(Da(l, "autoDownload") ?? !1),
        Vl(Da(l, "fileNamingTemplate") || Mr),
        l.outputDir && q(l.outputDir);
      const fe = Da(l, "concurrency");
      fe && fe >= 1 && O(Math.max(1, Math.min(fe, 12)));
      const xe = Da(l, "delaySeconds");
      xe && xe >= 1 && ue(xe);
      const pe = Da(l, "batchSize");
      pe && pe >= 1 && pe <= 4 && Le(pe);
      const Oe = Da(l, "videoDurationSeconds");
      Oe && [4, 6, 8, 10].includes(Oe) && P(Oe);
      const $e = D1();
      Y($e),
        Da(l, "audioEnabled") !== $e &&
          Me.updateProject(t, { audioEnabled: $e }).catch((Te) =>
            console.error("Failed to sync remembered audioEnabled:", Te),
          );
    }, [l?.id]);
    const [m, f] = u.useState(null),
      x = u.useRef(!1);
    u.useEffect(() => {
      l &&
        !m &&
        (async () => {
          if (!x.current) {
            x.current = !0;
            try {
              const D = await Me.getCredits(t);
              f(D),
                l &&
                  (!l.paygateTier || l.paygateTier !== D.userPaygateTier) &&
                  (await Me.updateProject(t, {
                    paygateTier: D.userPaygateTier,
                  })),
                (D.credits == null || D.credits == null) && (D.credits = 0);
            } catch (D) {
              console.error("Failed to check credits:", D), (x.current = !1);
            }
          }
        })();
    }, [t, l]);
    const { jobs: b, pollJobs: p } = Q3({ projectId: t, setProject: o }),
      [v, w] = u.useState(""),
      [N, C] = u.useState("newline"),
      [k, j] = u.useState("==="),
      [A, T] = u.useState("TEXT"),
      [M, S] = u.useState("16:9"),
      [_, L] = u.useState(""),
      [z, P] = u.useState(8),
      [J, Y] = u.useState(D1),
      [F, W] = u.useState([]),
      [$, G] = u.useState([]),
      [I, U] = u.useState(!1),
      [V, q] = u.useState(""),
      [X, O] = u.useState(8),
      [H, ae] = u.useState(12),
      ue = (E) => {
        const D = od.includes(E) ? E : od[0];
        ae(D);
      },
      de = 12,
      ce = Math.max(1, Math.min(X, de)),
      Q = od.includes(H) ? H : od[0],
      {
        loading: se,
        uploadingFrames: ie,
        uploadProgress: Ee,
        handleBatchSubmit: ke,
      } = n4({
        projectId: t,
        project: l,
        concurrency: ce,
        delaySeconds: Q,
        onSuccess: async () => {
          await p(), await c();
        },
      }),
      [Ae, oe] = u.useState({
        maxConcurrentGlobal: 50,
        maxConcurrentPerProfile: 20,
        totalMemGB: 0,
      });
    u.useEffect(() => {
      let E = !1;
      return (
        Me.getSystemStats()
          .then((D) => {
            E ||
              oe({
                maxConcurrentGlobal: D.maxConcurrentGlobal,
                maxConcurrentPerProfile: D.maxConcurrentPerProfile,
                totalMemGB: Math.round((D.totalMemMB || 0) / 1024),
              });
          })
          .catch(() => {}),
        () => {
          E = !0;
        }
      );
    }, []);
    const storyGenLoaded=u.useRef(null);
    u.useEffect(()=>{if(l && storyGenLoaded.current!==t){storyGenLoaded.current=t;T(l.inputMethod||'TEXT');S(l.aspectRatio||'16:9');}},[l,t]);
    const [we, Le] = u.useState(4),
      [Ge, He] = u.useState(!1),
      xt = h || se || Ge,
      [Et, wt] = u.useState(!1),
      [Ie, De] = u.useState(!1),
      [Ze, ze] = u.useState(!1),
      [Ve, Ce] = u.useState({ current: 0, total: 0, success: 0, failed: 0 }),
      [Ye, We] = u.useState(!1),
      [Se, Re] = u.useState(null);
    u.useEffect(() => {
      if (!Se) return;
      const E = (D) => {
        D.key === "Escape" && Re(null);
      };
      return (
        window.addEventListener("keydown", E),
        () => window.removeEventListener("keydown", E)
      );
    }, [Se]);
    const [et, gt] = u.useState(!1),
      [ot, At] = u.useState(5),
      [Jt, nn] = u.useState("size"),
      [qt, Wn] = u.useState(!1),
      [Ua, xs] = u.useState({ current: 0, total: 0 }),
      [Ws, En] = u.useState([]),
      gs = u.useRef(!1),
      [ps, ya] = u.useState(null),
      [Br, Vr] = u.useState(""),
      [Ba, wa] = u.useState(!1),
      [yn, Pl] = u.useState(null),
      [Va, Hr] = u.useState(""),
      [Ha, Fr] = u.useState(!1),
      [zn, bs] = u.useState([]),
      [Un, Ht] = u.useState(new Set()),
      [it, sn] = u.useState([]),
      [Bn, Fa] = u.useState(new Set()),
      [cc, Ga] = u.useState({}),
      [Rn, Gr] = u.useState([]),
      [fn, _s] = u.useState([]),
      [Zn, ja] = u.useState(new Set()),
      [Pt, Vi] = u.useState(new Set()),
      [Ka, Is] = u.useState("ALL"),
      vs = (E) => {
        E.forEach((D) => {
          D?.preview?.startsWith("blob:") && pf(D.preview);
        });
      },
      [Na, Kr] = u.useState([]),
      [qa, Hi] = u.useState(!1),
      [Zs, Ya] = u.useState(null),
      [_n, In] = u.useState(""),
      qr = u.useRef(null),
      Fi = "genNormal.voiceList.v2",
      Yr = 1440 * 60 * 1e3,
      zl = async (E = !1) => {
        if ((Ya(null), !E))
          try {
            const D = localStorage.getItem(Fi);
            if (D) {
              const K = JSON.parse(D);
              if (
                K &&
                Array.isArray(K.voices) &&
                K.voices.length > 0 &&
                K.voices.every((te) => te?.mediaId && te?.audioSamplePath) &&
                Date.now() - K.ts < Yr
              ) {
                Kr(K.voices);
                return;
              }
            }
          } catch {}
        Hi(!0);
        try {
          const K = (await Me.fetchVoicePresets(t))?.voices || [];
          Kr(K);
          try {
            localStorage.setItem(
              Fi,
              JSON.stringify({ ts: Date.now(), voices: K }),
            );
          } catch {}
        } catch (D) {
          const K = $t(D),
            ee = K.toUpperCase().includes("UNAUTHORIZED") || K.includes("401");
          Ya(
            ee
              ? "Cookie profile đã hết hạn. Vui lòng mở Profiles → Login lại."
              : `Không tải được danh sách giọng: ${K}`,
          );
        } finally {
          Hi(!1);
        }
      };
    u.useEffect(() => {
      A === "COMPONENTS_AUDIO" && (Na.length > 0 || qa || zl());
    }, [A]);
    const Js = Un.size > 0 || Bn.size > 0 || Zn.size > 0 || Pt.size > 0,
      [Qs, xn] = u.useState([]),
      [Cn, ka] = u.useState([]),
      [an, wn] = u.useState([]),
      [Gi, dc] = u.useState(!1),
      [Xa, Ki] = u.useState({ current: 0, total: 0 }),
      [Wa, ea] = u.useState({
        isOpen: !1,
        file: null,
        type: null,
        pendingFiles: [],
      }),
      [uc, qi] = u.useState(!1),
      [hc, Za] = u.useState(null),
      Ds = u.useRef(0),
      [Yi, Xi] = u.useState(new Set()),
      [Vn, Ja] = u.useState(!1),
      [Zd, Wi] = u.useState([]),
      [Xr, Qa] = u.useState(!1),
      [ys, Ul] = u.useState(null),
      [Bl, ws] = u.useState(0),
      [ta, Wr] = u.useState(!1),
      [Os, Vl] = u.useState(Mr),
      [Zr, Jd] = u.useState(
        () => localStorage.getItem("genNormal:fileNamingPanelOpen") === "true",
      ),
      jn = u.useRef(null),
      [er, Hl] = u.useState(1),
      Hn = u.useRef(new Set()),
      [js, Fl] = u.useState(!1),
      [Jr, Sa] = u.useState("1080P"),
      Ls = u.useRef(new Set()),
      $s = u.useRef(new Set()),
      [D0, mc] = u.useState(!1),
      [Qd, fc] = u.useState([]),
      [O0, Gl] = u.useState(!1);
    u.useEffect(() => {
      A === "IMAGE_GENERATION" || A === "IMAGE_GENERATION_BATCH_REFS"
        ? Jr === "1080P" && Sa("2K")
        : (Jr === "2K" && Sa("1080P"),
          M !== "16:9" && M !== "9:16" && S("16:9"));
    }, [A, Jr, M]),
      u.useEffect(() => {
        X > de && O(de);
      }, [X, de]);
    const [eu, xc] = u.useState(!1),
      [tr, Zi] = u.useState(new Set()),
      [Ea, gc] = u.useState("all"),
      [Ji, pc] = u.useState(!1),
      [Ca, Kl] = u.useState(new Set()),
      [bc, Qi] = u.useState(null),
      [eo, tu] = u.useState(new Map()),
      [vc, nu] = u.useState(!1),
      [Ps, su] = u.useState(O4),
      [ql, L0] = u.useState(L4);
    u.useEffect(() => {
      try {
        localStorage.setItem(Jy, Ps);
      } catch {}
    }, [Ps]),
      u.useEffect(() => {
        try {
          localStorage.setItem(Qy, String(ql));
        } catch {}
      }, [ql]),
      u.useEffect(() => {
        !ta ||
          !V ||
          !V.trim() ||
          (b.forEach((E) => {
            E.status !== "COMPLETED" ||
              !E.resultUrl ||
              E.parentJobId ||
              js ||
              E.upsamplingJobId != null ||
              E.downloadedAt ||
              (E.downloadAttempts ?? 0) >= 3 ||
              Hn.current.has(E.id) ||
              $s.current.has(E.id) ||
              ($s.current.add(E.id), $0(E));
          }),
          Uo(Hn.current));
      }, [b, ta, js, V, Os, M]),
      u.useEffect(() => {
        if (!ta || !V || !V.trim()) return;
        const E = (D, K, ee) => {
          $s.current.add(K),
            Me.downloadFile(D.resultUrl, V, ee, D.id)
              .then((te) => {
                te.success
                  ? (Ls.current.add(K), Uo(Ls.current))
                  : console.warn(
                      `Auto-download upscaled returned success=false for ${K}`,
                    );
              })
              .catch((te) => {
                console.error("Auto-download upscaled failed:", te);
              })
              .finally(() => {
                $s.current.delete(K);
              });
        };
        b.forEach((D) => {
          if (
            D.parentJobId &&
            D.status === "COMPLETED" &&
            D.resultUrl &&
            !D.downloadedAt &&
            (D.downloadAttempts ?? 0) < 3 &&
            !Ls.current.has(D.id) &&
            !$s.current.has(D.id)
          ) {
            const K = nr.get(D.parentJobId),
              ee = K ? K.jobIndex + 1 : D.jobIndex + 1,
              le =
                (K ?? D).mode === "IMAGE_GENERATION" ||
                D.mode === "IMAGE_UPSAMPLING"
                  ? ".jpg"
                  : ".mp4",
              fe = Go(Os, K ?? D, { aspectRatio: M }, le, "upscaled", ee);
            console.log(`📥 Auto-downloading upscaled (child) job #${ee}`),
              E(D, D.id, fe);
            return;
          }
          if (
            !D.parentJobId &&
            D.status === "COMPLETED" &&
            D.isUpsampled &&
            D.resultUrl &&
            !D.downloadedAt &&
            (D.downloadAttempts ?? 0) < 3 &&
            !Ls.current.has(`parent_${D.id}`) &&
            !$s.current.has(`parent_${D.id}`)
          ) {
            const K = D.mode === "IMAGE_GENERATION" ? ".jpg" : ".mp4",
              ee = Go(Os, D, { aspectRatio: M }, K, "upscaled");
            console.log(
              `📥 Auto-downloading upscaled (parent) job #${D.jobIndex + 1}`,
            ),
              E(D, `parent_${D.id}`, ee);
          }
        }),
          Uo(Ls.current);
      }, [b, ta, V, Os, M]);
    const $0 = async (E) => {
        try {
          if (!V) return;
          const D = E.mode === "IMAGE_GENERATION" ? ".jpg" : ".mp4",
            K = Go(Os, E, { aspectRatio: M }, D),
            ee = (te) => {
              Hn.current.add(E.id),
                Uo(Hn.current),
                console.log(`✅ Auto-downloaded: ${te}`);
            };
          try {
            const te = await Me.downloadFile(E.resultUrl, V, K, E.id);
            te.success && ee(te.filePath);
          } catch (te) {
            const le = $t(te);
            if (le.includes("HTTP 403") || le.includes("HTTP 404")) {
              const fe = await Me.refreshResultUrl(E.id).catch(() => null);
              if (fe?.success && fe.freshUrl) {
                const xe = await Me.downloadFile(fe.freshUrl, V, K, E.id);
                if (xe.success) {
                  ee(xe.filePath);
                  return;
                }
              }
            }
            console.error("Auto-download failed:", te);
          }
        } catch (D) {
          console.error("Auto-download failed (outer):", D);
        } finally {
          $s.current.delete(E.id);
        }
      },
      P0 = (E) => {
        const D = new Set(tr);
        D.has(E) ? D.delete(E) : D.add(E), Zi(D);
      },
      yc = async () => {
        if (tr.size < 2) {
          alert("Vui lòng chọn ít nhất 2 video để ghép");
          return;
        }
        try {
          wt(!0), He(!0);
          const E = bt
            .filter((D) => tr.has(D.id) && D.mode !== "IMAGE_GENERATION")
            .sort((D, K) => D.jobIndex - K.jobIndex);
          if (E.length < 2) {
            alert("Cần ít nhất 2 video hợp lệ để ghép");
            return;
          }
          if (js) {
            const D = E.filter((K) => !K.isUpsampled && !K.parentJobId).length;
            if (
              D > 0 &&
              !confirm(
                `${D} video chưa upscale xong — ghép bây giờ sẽ dùng bản thường. Tiếp tục?`,
              )
            )
              return;
          }
          await Me.mergeVideos(
            t,
            E.map((D) => D.id),
            V,
          ),
            alert("Đã ghép video thành công!");
        } catch (E) {
          console.error("Merge failed:", E), alert(`Lỗi ghép video: ${$t(E)}`);
        } finally {
          wt(!1), He(!1);
        }
      };
    U3({ profiles: l?.profiles }),
      u.useEffect(
        () => () => {
          t &&
            Me.cleanupProject(t).catch((E) => {
              console.warn("Failed to cleanup project queue:", E);
            });
        },
        [t],
      ),
      u.useEffect(() => {
        Xr &&
          b.some((E) => E.status === "PROCESSING") &&
          (Qa(!1), Ul(null), ws(0));
      }, [b, Xr]),
      u.useEffect(() => {
        if (!Xr || !ys) return;
        const E = setInterval(() => {
          ws(Math.floor((Date.now() - ys) / 1e3));
        }, 1e3);
        return () => clearInterval(E);
      }, [Xr, ys]),
      u.useEffect(() => {
        try {
          const E = `genNormal_${t}_uiState`;
          localStorage.removeItem(E),
            console.log(
              "[GenNormalDetailPage] Cleared saved UI state for fresh start",
            );
        } catch (E) {
          console.warn("Failed to clear saved UI state:", E);
        }
      }, [t]);
    const Qr = u.useMemo(
        () =>
          b.reduce(
            (E, D) =>
              D.status === "PROCESSING" || D.status === "QUEUED" ? E + 1 : E,
            0,
          ),
        [b],
      ),
      z0 = Qr > 0,
      {
        showModal: au,
        verifyNavigation: ru,
        proceedNavigation: wc,
        cancelNavigation: lu,
      } = s4({
        shouldBlock: z0,
        message: "Đang có tiến trình chạy. Bạn có chắc chắn muốn rời đi?",
      }),
      iu = async (E) => {
        try {
          He(!0),
            E === "pause" ? await fu() : E === "stop" && (await xu()),
            wc();
        } catch (D) {
          console.error("Navigation guard action failed:", D), wc();
        } finally {
          He(!1);
        }
      },
      el = () => {
        console.log("[GenNormalDetailPage] handleBackClick triggered"), ru(s);
      };
    u.useEffect(() => {
      (async () => {
        if (m) {
          U(!0);
          try {
            if (
              A === "IMAGE_GENERATION" ||
              A === "IMAGE_GENERATION_BATCH_REFS"
            ) {
              const D = await Me.getImageModels();
              if ((G(D), !_ || !D.find((K) => K.key === _))) {
                const K =
                  D.find((ee) => ee.key === "HARBOR_SEAL") ||
                  D.find((ee) => ee.key === "GEM_PIX_2") ||
                  D[0];
                K && L(K.key);
              }
            } else {
              const D = bf(A),
                K = m.userPaygateTier === "PAYGATE_TIER_TWO",
                ee = m.credits ?? 0,
                te = K ? "ADVANCED" : "INTERMEDIATE",
                le = await Me.getVideoModels(D, M, te);
              let fe;
              if (
                (K
                  ? (fe = ee < 50 ? le.filter((xe) => xe.isRelaxed) : le)
                  : (fe = le.filter((xe) => !xe.isRelaxed)),
                W(fe),
                !_ || !fe.find((xe) => xe.key === _))
              ) {
                const xe =
                  fe.find((pe) => pe.isRelaxed && pe.key.includes("_lite")) ||
                  fe.find((pe) => !pe.isRelaxed) ||
                  fe[0];
                xe && L(xe.key);
              }
            }
          } catch (D) {
            console.error("Failed to load models:", D);
          } finally {
            U(!1);
          }
        }
      })();
    }, [A, M, m]);
    const U0 = [
        "TEXT",
        "IMAGE",
        "COMPONENTS",
        "COMPONENTS_AUDIO",
        "REFERENCE_BATCH",
      ],
      to = u.useMemo(() => F.find((E) => E.key === _), [F, _]),
      Fn = v3(to ?? _),
      ou = to?.availableDurations ?? [4, 6, 8, 10],
      cu = to?.creditByDuration ?? null,
      rn = Fn ? (to?.maxImageInputs ?? 7) : 3;
    u.useEffect(() => {
      Fn &&
        (U0.includes(A) || T("TEXT"),
        Cn.length > 0 &&
          (Cn.forEach((E) => {
            E?.preview && URL.revokeObjectURL(E.preview);
          }),
          ka([])));
    }, [Fn]);
    const nr = u.useMemo(() => new Map(b.map((E) => [E.id, E])), [b]),
      {
        activeJobs: jc,
        activeUpscaleJobs: tl,
        draftJobs: Mt,
        failedJobs: gn,
        completedJobs: bt,
        upsampleChildJobs: no,
        queuedJobs: Yl,
        processingJobs: Xl,
        captcha403JobCount: Nc,
        dailyQuotaFailedJobs: B0,
        upgradeableQuotaProfileIds: du,
      } = u.useMemo(() => {
        const E = [],
          D = [],
          K = [],
          ee = [],
          te = [],
          le = [],
          fe = [],
          xe = [],
          pe = [],
          Oe = new Set();
        let $e = 0;
        for (const Te of b)
          Te.parentJobId
            ? (le.push(Te),
              (Te.status === "QUEUED" || Te.status === "PROCESSING") &&
                D.push(Te))
            : Te.status === "QUEUED" || Te.status === "PROCESSING"
              ? E.push(Te)
              : Te.status === "DRAFT"
                ? K.push(Te)
                : Te.status === "FAILED"
                  ? ee.push(Te)
                  : Te.status === "COMPLETED" && te.push(Te),
            Te.status === "QUEUED"
              ? fe.push(Te)
              : Te.status === "PROCESSING" && xe.push(Te),
            typeof Te.error == "string" &&
              Te.error.includes("RATE_LIMIT_RETRY") &&
              (Te.error.includes("403") || Te.error.includes("reCAPTCHA")) &&
              $e++,
            Te.status === "FAILED" &&
              typeof Te.error == "string" &&
              (Te.error.startsWith(wd) && pe.push(Te),
              Te.error.startsWith(wi) && Oe.add(Te.profileId));
        return {
          activeJobs: E,
          activeUpscaleJobs: D,
          draftJobs: K,
          failedJobs: ee,
          completedJobs: te,
          upsampleChildJobs: le,
          queuedJobs: fe,
          processingJobs: xe,
          captcha403JobCount: $e,
          dailyQuotaFailedJobs: pe,
          upgradeableQuotaProfileIds: [...Oe],
        };
      }, [b]),
      sr = jc.length > 0 || tl.length > 0,
      V0 = u.useMemo(() => {
        const E = new Map();
        for (const D of no) D.parentJobId && E.set(D.parentJobId, D);
        return E;
      }, [no]),
      Wl = u.useMemo(
        () =>
          bt.filter((E) =>
            E.downloadedAt || !E.lastDownloadError
              ? !1
              : E.lastDownloadError === "URL_PENDING"
                ? !0
                : !(
                    !E.isUpsampled &&
                    (E.upsamplingJobId != null || (js && sr))
                  ),
          ),
        [bt, js, sr],
      ),
      ln = Wl.length;
    u.useEffect(() => {
      Ea === "missing" && ln === 0 && gc("all");
    }, [Ea, ln]);
    const na = u.useMemo(
        () =>
          b.filter(
            (E) =>
              !E.parentJobId &&
              E.lastDownloadError &&
              E.lastDownloadError !== "URL_PENDING" &&
              !E.downloadedAt,
          ).length,
        [b],
      ),
      kc = u.useRef(0);
    u.useEffect(() => {
      na > kc.current && mc(!1), (kc.current = na);
    }, [na]);
    const Zl = u.useMemo(
        () =>
          Ea === "completed"
            ? bt
            : Ea === "failed"
              ? gn
              : Ea === "missing"
                ? Wl
                : [...bt, ...gn],
        [bt, gn, Ea, Wl],
      ),
      Sc = u.useRef(null),
      Jl = Ps === "grid" ? ql : 1,
      so = u.useMemo(() => {
        const E = [];
        for (let D = 0; D < Zl.length; D += Jl) E.push(Zl.slice(D, D + Jl));
        return E;
      }, [Zl, Jl]),
      Ql = N1({
        count: so.length,
        getScrollElement: () => Sc.current,
        estimateSize: () => (Ps === "list" ? 96 : 320),
        overscan: 5,
      });
    u.useEffect(() => {
      Ql.measure();
    }, [Ql, Ps, Jl]);
    const nl = async () => {
        if (!v.trim()) {
          alert("Vui lòng nhập prompts");
          return;
        }
        const E = [...Mt].sort((ee, te) => ee.jobIndex - te.jobIndex);
        if (E.length === 0) {
          alert("Không có job DRAFT để fill prompt");
          return;
        }
        let D;
        switch (N) {
          case "newline":
            D = /\n/;
            break;
          case "blankline":
            D = /\n\s*\n/;
            break;
          case "separator":
            D = /\n=====\n|=====/;
            break;
          case "custom":
            D =
              k ||
              `
`;
            break;
          default:
            D = /\n/;
        }
        const K = v.split(D).filter((ee) => ee.trim());
        if (K.length !== E.length) {
          alert(`Số prompt (${K.length}) phải bằng số job DRAFT (${E.length})`);
          return;
        }
        try {
          He(!0);
          for (let ee = 0; ee < E.length; ee++) {
            const te = E[ee],
              le = K[ee].trim();
            await Me.updateJob(te.id, { prompt: le });
          }
          w(""),
            await p(),
            await new Promise((ee) => setTimeout(ee, 300)),
            await p(),
            await c(),
            alert(
              `Đã điền ${K.length} prompt vào các job DRAFT. Bạn có thể ấn "Bắt đầu gen" để bắt đầu.`,
            );
        } catch (ee) {
          console.error("Failed to auto-fill prompts:", ee),
            alert(`Lỗi điền prompt: ${$t(ee)}`);
        } finally {
          He(!1);
        }
      },
      ei = Mt.length > 0 ? Mt[0].mode : null,
      ti = bf(A),
      ar = Mt.length > 0,
      Ta = ar,
      rr = (E) => {
        if (Mt.length > 0 && bf(E) !== ei) {
          alert(
            'Đang có job chờ xử lý ở chế độ khác. Hãy "Bắt đầu gen" hoặc "Xóa tất cả draft" trước khi đổi chế độ.',
          );
          return;
        }
        A === "REFERENCE_BATCH" &&
          E !== "REFERENCE_BATCH" &&
          an.length > 0 &&
          (an.forEach((K) =>
            K.images.forEach((ee) => URL.revokeObjectURL(ee.preview)),
          ),
          wn([])),
          T(E),
          !(E === "IMAGE_GENERATION" || E === "IMAGE_GENERATION_BATCH_REFS") &&
            M !== "16:9" &&
            M !== "9:16" &&
            S("16:9");
      },
      sl = async () => {
        if (
          Mt.length !== 0 &&
          confirm(`Xóa tất cả ${Mt.length} job đang chờ xử lý?`)
        )
          try {
            He(!0),
              await Promise.all(Mt.map((E) => Me.deleteJob(E.id))),
              await p();
          } catch (E) {
            console.error("Failed to clear drafts:", E),
              alert("Lỗi khi xóa draft: " + $t(E));
          } finally {
            He(!1);
          }
      },
      ni = async () => {
        if (Vn && Mt.length > 0) {
          await nl();
          return;
        }
        if (ar && ei && ei !== ti) {
          alert(
            'Các job chờ xử lý phải cùng chế độ. Hãy xóa tất cả draft hoặc "Bắt đầu gen" trước khi tạo job ở chế độ mới.',
          );
          return;
        }
        const E = ar ? Math.max(...b.map((K) => K.jobIndex ?? -1), -1) + 1 : 0,
          D = await ke({
            promptText: v,
            inputMethod: A,
            aspectRatio: M,
            outputDir: V,
            selectedModelKey: _,
            promptDelimiter: N,
            customDelimiter: k,
            imageGenReferenceImages: zn,
            componentsReferenceImages: it,
            startFrameImages: Qs,
            endFrameImages: Cn,
            referenceShots: an,
            appendToDraft: ar,
            jobIndexOffset: E,
            batchRefsFixedImages: Rn,
            batchRefsDynamicImages: fn,
            batchRefsPromptMode: Ka,
            audioMediaId: _n || void 0,
            videoDurationSeconds: Fn ? z : void 0,
            maxRefImages: rn,
            componentsPerPromptResolved: Ic,
          });
        D.success &&
          D.clearState &&
          (A === "IMAGE" &&
            (Qs.forEach((K) => URL.revokeObjectURL(K.preview)),
            Cn.forEach((K) => {
              K?.preview && URL.revokeObjectURL(K.preview);
            }),
            xn([]),
            ka([])),
          A === "REFERENCE_BATCH" &&
            (an.forEach((K) =>
              K.images.forEach((ee) => URL.revokeObjectURL(ee.preview)),
            ),
            wn([])),
          A === "IMAGE_GENERATION" && (vs(zn), bs([])),
          A === "COMPONENTS" && (vs(it), sn([])),
          A === "IMAGE_GENERATION_BATCH_REFS" && (vs(fn), _s([])),
          A === "COMPONENTS_AUDIO" && (vs(it), sn([])),
          w(""));
      },
      Ec = () => Date.now() - Ds.current < _4,
      lr = () => {
        if (Vn && Mt.length > 0) {
          ni();
          return;
        }
        if (Ec()) {
          ni();
          return;
        }
        Za("submit"), qi(!0);
      },
      uu = () => {
        if (Ec()) {
          hl();
          return;
        }
        Za("start"), qi(!0);
      },
      hu = () => {
        const E = hc;
        qi(!1),
          Za(null),
          (Ds.current = Date.now()),
          E === "submit" ? ni() : E === "start" && hl();
      },
      mu = () => {
        qi(!1), Za(null);
      },
      fu = async () => {
        try {
          He(!0), await Me.pauseProject(t), await c();
        } catch (E) {
          console.error("Failed to pause:", E);
        } finally {
          He(!1);
        }
      },
      Cc = async () => {
        try {
          He(!0), await Me.resumeProject(t), await c(), await p();
        } catch (E) {
          console.error("Failed to resume:", E);
        } finally {
          He(!1);
        }
      },
      xu = async () => {
        if (confirm("Bạn có chắc muốn dừng toàn bộ project?"))
          try {
            He(!0), await Me.stopProject(t), await c(), await p();
          } catch (E) {
            console.error("Failed to stop:", E);
          } finally {
            He(!1);
          }
      },
      ao = (E) => {
        Hn.current.delete(E),
          Ls.current.delete(E),
          Ls.current.delete(`parent_${E}`),
          $s.current.delete(E),
          $s.current.delete(`parent_${E}`);
      },
      gu = async (E) => {
        try {
          await Me.retryJob(t, E), ao(E), await p();
        } catch (D) {
          console.error("Failed to retry job:", D);
        }
      },
      si = async (E) => {
        try {
          await Me.cancelJob(E), await p();
        } catch (D) {
          console.error("Failed to cancel job:", D);
        }
      },
      Jn = async (E) => {
        if (confirm("Xóa job này?"))
          try {
            await Me.deleteJob(E), await p();
          } catch (D) {
            console.error("Failed to delete job:", D);
          }
      },
      ro = async () => {
        if (gn.length === 0) {
          alert("Không có job lỗi để retry");
          return;
        }
        if (confirm(`Gen lại tất cả ${gn.length} job lỗi?`))
          try {
            await Me.retryAllFailedJobs(t),
              gn.forEach((E) => ao(E.id)),
              await p();
          } catch (E) {
            console.error("Failed to retry all failed jobs:", E);
          }
      },
      Gn = async (E, D) => {
        try {
          await Me.updateJob(E, { prompt: D }),
            tu((K) => new Map(K).set(E, D)),
            Qi(null),
            await p();
        } catch (K) {
          console.error("Failed to save prompt:", K),
            alert("Lỗi khi lưu prompt");
        }
      },
      al = (E) => {
        Kl((D) => {
          const K = new Set(D);
          return K.has(E) ? K.delete(E) : K.add(E), K;
        });
      },
      Tc = () => {
        Kl(new Set(Zl.map((E) => E.id)));
      },
      lo = () => {
        Kl(new Set());
      },
      io = async () => {
        if (Ca.size !== 0 && confirm(`Gen lại ${Ca.size} job đã chọn?`)) {
          nu(!0);
          try {
            for (const E of Ca)
              eo.has(E) && (await Me.updateJob(E, { prompt: eo.get(E) })),
                await Me.retryJob(t, E),
                ao(E);
            Kl(new Set()), tu(new Map()), pc(!1), await p();
          } catch (E) {
            console.error("Failed to regen selected jobs:", E),
              alert("Lỗi khi gen lại");
          } finally {
            nu(!1);
          }
        }
      },
      Ac = async () => {
        if (bt.length === 0) {
          alert("Không có job hoàn thành để xóa");
          return;
        }
        if (confirm(`Xóa tất cả ${bt.length} job đã hoàn thành?`))
          try {
            await Me.deleteAllCompletedJobs(t), await p();
          } catch (E) {
            console.error("Failed to delete all completed jobs:", E);
          }
      },
      ir = async () => {
        const E = bt.filter(
          (D) =>
            D.mode === "IMAGE_GENERATION" &&
            D.status === "COMPLETED" &&
            D.resultUrl,
        );
        if (E.length === 0) {
          alert("Không có ảnh đã gen xong để chuyển sang start frame");
          return;
        }
        if (
          confirm(
            `Chuyển ${E.length} ảnh đã gen thành start frame để gen video?`,
          )
        )
          try {
            He(!0);
            const D = [...E].sort((le, fe) => le.jobIndex - fe.jobIndex),
              K = D.map((le, fe) => {
                let xe = "";
                if (le.providerJobId) xe = le.providerJobId;
                else if (le.resultUrl) {
                  const pe = le.resultUrl.match(
                    /\/([a-zA-Z0-9_-]{20,})\.(jpg|jpeg|png|webp)/i,
                  );
                  if (pe && pe[1]) xe = pe[1];
                  else {
                    const Oe = le.resultUrl.split("/"),
                      Te = Oe[Oe.length - 1].replace(
                        /\.(jpg|jpeg|png|webp)$/i,
                        "",
                      );
                    Te.length > 10 && (xe = Te);
                  }
                }
                return (
                  !xe && le.resultUrl && (xe = le.resultUrl),
                  {
                    prompt: "",
                    mode: "IMAGE_TO_VIDEO",
                    profileId: le.profileId,
                    jobIndex: fe,
                    batchIndex: le.batchIndex ?? 0,
                    startImageMediaId: xe || "",
                    endImageMediaId: null,
                    startImagePreviewUrl: le.resultUrl || null,
                    endImagePreviewUrl: null,
                    veo3ProjectId: le.veo3ProjectId || void 0,
                  }
                );
              });
            Wi(
              D.map((le, fe) => ({
                originalJobId: le.id,
                profileId: le.profileId,
                mediaId: K[fe].startImageMediaId,
                previewUrl: le.resultUrl || "",
                jobIndex: fe,
                veo3ProjectId: le.veo3ProjectId || void 0,
              })),
            );
            const ee = await Me.getVideoModels("IMAGE_TO_VIDEO", M),
              te =
                ee.find((le) => !le.isRelaxed)?.key ||
                ee[0]?.key ||
                "veo_3_1_i2v_s_fast_ultra";
            console.log("🔄 Reuse: Model selection for IMAGE_TO_VIDEO", {
              currentSelectedModelKey: _,
              capability: "IMAGE_TO_VIDEO",
              aspectRatio: M,
              actualModelKey: te,
            }),
              await Me.submitBatchWithFrames(t, K, M, te, V),
              Ja(!0),
              T("IMAGE"),
              await p(),
              await c(),
              alert(
                `Đã tạo ${K.length} job DRAFT từ ảnh đã gen. Vui lòng nhập prompt và ấn "Auto Fill Prompt".`,
              );
          } catch (D) {
            console.error("Failed to reuse all images:", D),
              alert(`Lỗi chuyển ảnh sang start frame: ${$t(D)}`);
          } finally {
            He(!1);
          }
      },
      pu = (E) => {
        ya(E), Vr("");
      },
      or = () => {
        ya(null), Vr("");
      },
      rl = async () => {
        if (!ps || !Br.trim()) {
          alert("Vui lòng nhập prompt để sửa ảnh");
          return;
        }
        try {
          wa(!0), await Me.editImage(t, ps.id, Br), await p(), or();
        } catch (E) {
          console.error("Failed to edit image:", E),
            alert(`Lỗi sửa ảnh: ${$t(E)}`);
        } finally {
          wa(!1);
        }
      },
      H0 = (E) => {
        Pl(E), Hr(E.prompt);
      },
      Kn = (E) => {
        switch (E) {
          case "TEXT_TO_VIDEO":
            return "Văn bản → Video";
          case "IMAGE_TO_VIDEO":
            return "Ảnh → Video";
          case "FRAME_TO_FRAME":
            return "Khung hình → Video";
          case "REFERENCE_TO_VIDEO":
            return "Tham chiếu → Video";
          case "IMAGE_GENERATION":
            return "Tạo hình ảnh";
          default:
            return E;
        }
      },
      cr = (E) => {
        if (
          E.status !== "COMPLETED" ||
          !E.resultUrl ||
          E.isUpsampled ||
          E.parentJobId
        )
          return !1;
        if (!E.upsamplingJobId) return !0;
        const D = nr.get(E.upsamplingJobId);
        return D
          ? D.status === "FAILED" ||
              (D.status === "COMPLETED" && !E.isUpsampled)
          : !1;
      },
      sa = (E) => {
        if (E.parentJobId || !E.upsamplingJobId || E.isUpsampled) return !1;
        const D = nr.get(E.upsamplingJobId);
        return !!(
          (D && (D.status === "QUEUED" || D.status === "PROCESSING")) ||
          !D
        );
      },
      ai = () => {
        Pl(null), Hr("");
      },
      oo = async (E, D) => {
        if (!E.id) {
          alert("Job ID không hợp lệ");
          return;
        }
        if (!cr(E)) {
          E.isUpsampled
            ? alert("Video đã được upsampled lên 1080p")
            : sa(E)
              ? alert("Video đang được upsampled, vui lòng đợi...")
              : alert("Không thể upsampling video này");
          return;
        }
        const K = D || (E.mode === "IMAGE_GENERATION" ? "2K" : "1080P");
        if (
          confirm(
            `Bạn có chắc muốn upsampling job #${E.jobIndex + 1} lên ${K}?`,
          )
        )
          try {
            He(!0);
            const ee = await Me.upsampleJob(E.id, D);
            if (ee.success)
              alert("Đã tạo job upsampling thành công!"), await p();
            else {
              const te = ee.error || "Không thể tạo job upsampling";
              te.includes("already being upsampled")
                ? alert(
                    "Job đang được upscale (auto-upscale). Vui lòng đợi hoàn thành.",
                  )
                : alert(`Lỗi: ${te}`);
            }
          } catch (ee) {
            console.error("Error upsampling job:", ee), alert(`Lỗi: ${$t(ee)}`);
          } finally {
            He(!1);
          }
      },
      dr = async (E = "1080P") => {
        if (!t) {
          alert("Project ID không hợp lệ");
          return;
        }
        const D = b.filter((K) => cr(K));
        if (D.length === 0) {
          alert("Không có video nào cần upsampling");
          return;
        }
        if (
          confirm(
            `Bạn có chắc muốn upsampling ${D.length} jobs (đã hoàn thành, chưa upsample) lên ${E}?`,
          )
        )
          try {
            He(!0);
            const K = await Me.upsampleAllJobs(t, E);
            K.success
              ? (alert(
                  `Đã tạo ${K.count || K.created || 0} job upsampling thành công!`,
                ),
                K.errors &&
                  K.errors > 0 &&
                  alert(`Có ${K.errors} job không thể tạo upsampling`),
                await p())
              : alert("Lỗi khi tạo job upsampling");
          } catch (K) {
            console.error("Error upsampling all jobs:", K),
              alert(`Lỗi: ${$t(K)}`);
          } finally {
            He(!1);
          }
      },
      Mc = async () => {
        if (!yn || !Va.trim()) {
          alert("Vui lòng nhập prompt");
          return;
        }
        try {
          Fr(!0), await Me.reuseVideo(t, yn.id, Va), await p(), ai();
        } catch (E) {
          console.error("Failed to reuse video:", E),
            alert(`Lỗi tạo lại video: ${$t(E)}`);
        } finally {
          Fr(!1);
        }
      },
      bu = async () => {
        if (bt.length === 0) {
          alert("Không có file để tải");
          return;
        }
        if (!V || V.trim() === "") {
          alert("Vui lòng chọn thư mục lưu file trước khi tải");
          return;
        }
        if (js) {
          const E = bt.filter(
            (D) =>
              D.mode !== "IMAGE_GENERATION" &&
              !D.isUpsampled &&
              !D.parentJobId &&
              D.resultUrl,
          ).length;
          if (
            E > 0 &&
            !confirm(
              `${E} video chưa upscale xong — tải bây giờ sẽ là bản thường. Tiếp tục?`,
            )
          )
            return;
        }
        await co(bt, { refreshFirst: !1 });
      },
      co = async (E, { refreshFirst: D }) => {
        De(!0), Ce({ current: 0, total: E.length, success: 0, failed: 0 });
        const K = [];
        let ee = 0,
          te = 0;
        try {
          for (let le = 0; le < E.length; le++) {
            const fe = E[le];
            if (
              (Ce({
                current: le + 1,
                total: E.length,
                success: ee,
                failed: te,
              }),
              !fe.resultUrl && !D)
            ) {
              te++, K.push({ job: fe, error: "Không có URL kết quả" });
              continue;
            }
            const xe = fe.mode === "IMAGE_GENERATION" ? ".jpg" : ".mp4",
              pe = Go(
                Os,
                fe,
                { aspectRatio: M },
                xe,
                fe.isUpsampled ? "upscaled" : void 0,
              ),
              Oe = async () => {
                const $e = await Me.refreshResultUrl(fe.id).catch(() => null);
                return $e?.success && $e.freshUrl
                  ? $e.freshUrl
                  : ($e?.error === "MEDIA_DELETED"
                      ? K.push({
                          job: fe,
                          error:
                            "Không lấy được link mới — media có thể đã bị xóa khỏi Google, hoặc mạng lỗi (thử lại sau)",
                        })
                      : $e?.error === "EXPIRED_COOKIES" &&
                        K.push({
                          job: fe,
                          error:
                            "Cookie profile hết hạn — mở Profiles → Login lại",
                        }),
                    null);
              };
            try {
              let $e = fe.resultUrl;
              if (D) {
                const Ue = await Oe();
                if (!Ue && K.some((Xe) => Xe.job.id === fe.id)) {
                  te++;
                  continue;
                }
                Ue && ($e = Ue);
              }
              if (!$e) {
                te++,
                  K.push({
                    job: fe,
                    error: "Chưa lấy được link video — thử lại sau ít phút",
                  });
                continue;
              }
              (await Me.downloadFile($e, V, pe, fe.id)).success
                ? (ee++, Hn.current.add(fe.id), Uo(Hn.current))
                : (te++, K.push({ job: fe, error: "Tải về thất bại" }));
            } catch ($e) {
              const Te = $t($e);
              if (!D && (Te.includes("HTTP 403") || Te.includes("HTTP 404"))) {
                const Ue = await Oe();
                if (Ue)
                  try {
                    if ((await Me.downloadFile(Ue, V, pe, fe.id)).success) {
                      ee++, Hn.current.add(fe.id), Uo(Hn.current);
                      continue;
                    }
                  } catch (Xe) {
                    te++, K.push({ job: fe, error: $t(Xe).slice(0, 150) });
                    continue;
                  }
              }
              te++,
                K.some((Ue) => Ue.job.id === fe.id) ||
                  K.push({ job: fe, error: Te.slice(0, 150) });
            }
          }
          Ce({ current: E.length, total: E.length, success: ee, failed: te }),
            De(!1),
            K.length > 0
              ? (fc(K), Gl(!0))
              : (mc(!1), alert(`Đã tải ${ee}/${E.length} file thành công.`));
        } catch (le) {
          console.error("Failed to download all files:", le),
            De(!1),
            alert("Lỗi khi tải file. Vui lòng thử lại.");
        }
      },
      uo = async () => {
        if (Wl.length === 0) {
          alert("Không có video nào cần tải lại.");
          return;
        }
        if (!V || V.trim() === "") {
          alert("Vui lòng chọn thư mục lưu file trước khi tải");
          return;
        }
        await co(Wl, { refreshFirst: !0 });
      },
      Qn = async () => {
        if (bt.length < 2) {
          alert("Cần ít nhất 2 video để ghép");
          return;
        }
        if (!V || V.trim() === "") {
          alert("Vui lòng chọn thư mục lưu video trước khi ghép");
          return;
        }
        if (!Et) {
          if (js) {
            const E = bt.filter(
              (D) =>
                D.mode !== "IMAGE_GENERATION" &&
                !D.isUpsampled &&
                !D.parentJobId,
            ).length;
            if (
              E > 0 &&
              !confirm(
                `${E} video chưa upscale xong — ghép bây giờ sẽ dùng bản thường. Tiếp tục?`,
              )
            )
              return;
          }
          try {
            wt(!0), He(!0);
            const E = await Me.mergeVideos(t, void 0, V);
            alert(`✅ Đã ghép ${E.videoCount} video thành công!

Lưu tại: ${E.outputPath}`);
          } catch (E) {
            console.error("Failed to merge videos:", E),
              alert(`Lỗi ghép video: ${$t(E)}`);
          } finally {
            wt(!1), He(!1);
          }
        }
      },
      ll = (E) => {
        const D = b.filter(
            (pe) =>
              pe.mode !== "IMAGE_GENERATION" &&
              pe.status === "COMPLETED" &&
              !!pe.resultUrl,
          ),
          K = b;
        if (K.length === 0 || E < 2)
          return { batches: [], totalValid: D.length };
        const ee = Math.min(...K.map((pe) => pe.jobIndex)),
          te = Math.max(...K.map((pe) => pe.jobIndex)),
          le = Math.ceil((te - ee + 1) / E),
          fe = (pe) => String(pe).padStart(2, "0"),
          xe = [];
        for (let pe = 0; pe < le; pe++) {
          const Oe = ee + pe * E,
            $e = Math.min(Oe + E - 1, te),
            Te = D.filter((Ue) => Ue.jobIndex >= Oe && Ue.jobIndex <= $e).sort(
              (Ue, Xe) => Ue.jobIndex - Xe.jobIndex,
            );
          xe.push({
            label: `Batch ${fe(pe + 1)} · jobs ${Oe}-${$e}`,
            fileBase: `batch_${fe(pe + 1)}_jobs_${Oe}-${$e}`,
            jobs: Te,
          });
        }
        return { batches: xe, totalValid: D.length };
      },
      il = () => {
        const E = b.filter(
            (le) =>
              le.mode !== "IMAGE_GENERATION" &&
              le.status === "COMPLETED" &&
              !!le.resultUrl,
          ),
          D = new Map();
        for (const le of E) {
          const fe = le.batchIndex ?? 0,
            xe = D.get(fe);
          xe ? xe.push(le) : D.set(fe, [le]);
        }
        const K = Array.from(D.keys()).sort((le, fe) => le - fe),
          ee = (le) => String(le).padStart(2, "0");
        return {
          batches: K.map((le, fe) => {
            const xe = (D.get(le) || []).sort(
                (Oe, $e) => Oe.jobIndex - $e.jobIndex,
              ),
              pe = fe + 1;
            return {
              label: `Batch gốc ${ee(pe)} · ${xe.length} video`,
              fileBase: `batch_${ee(pe)}`,
              jobs: xe,
            };
          }),
          totalValid: E.length,
        };
      },
      ri = (E, D) => (E === "original" ? il() : ll(D)),
      li = (E) =>
        E.replace(/[\\/:*?"<>|]+/g, "_")
          .replace(/\s+/g, "_")
          .slice(0, 120) || "project",
      es = async () => {
        if (qt) return;
        if (!V || V.trim() === "") {
          alert("Vui lòng chọn thư mục lưu video trước khi export");
          return;
        }
        const E = Math.max(2, Math.min(50, Math.floor(ot || 5))),
          { batches: D } = ri(Jt, E);
        if (D.length === 0) {
          alert("Không có video hoàn thành để export");
          return;
        }
        if (js) {
          const ee = D.flatMap((te) => te.jobs).filter(
            (te) => !te.isUpsampled && !te.parentJobId,
          ).length;
          if (
            ee > 0 &&
            !confirm(
              `${ee} video chưa upscale xong — export bây giờ sẽ dùng bản thường. Tiếp tục?`,
            )
          )
            return;
        }
        (gs.current = !1), Wn(!0), En([]), xs({ current: 0, total: D.length });
        const K = li(l?.name || t);
        for (let ee = 0; ee < D.length; ee++) {
          if (gs.current) {
            En((pe) => [
              ...pe,
              {
                label: `Batch ${ee + 1}/${D.length}`,
                status: "skipped",
                message: "Đã hủy bởi người dùng",
              },
            ]);
            break;
          }
          const te = D[ee],
            { label: le, fileBase: fe } = te,
            xe = `${K}_${fe}.mp4`;
          if (te.jobs.length === 0) {
            En((pe) => [
              ...pe,
              {
                label: le,
                status: "skipped",
                message: "Không có video hợp lệ",
              },
            ]),
              xs({ current: ee + 1, total: D.length });
            continue;
          }
          if (te.jobs.length === 1) {
            if (Jt === "size")
              En((pe) => [
                ...pe,
                {
                  label: le,
                  status: "skipped",
                  message: "Chỉ còn 1 video hợp lệ, cần tối thiểu 2 để ghép",
                },
              ]);
            else {
              const pe = te.jobs[0].resultUrl;
              try {
                const Oe = await Me.downloadFile(pe, V, xe);
                En(($e) => [
                  ...$e,
                  {
                    label: le,
                    status: "ok",
                    message: `Copy 1 video → ${xe}`,
                    fileName: Oe.filePath.split(/[\\/]/).pop() || xe,
                  },
                ]);
              } catch (Oe) {
                En(($e) => [
                  ...$e,
                  {
                    label: le,
                    status: "failed",
                    message: $t(Oe) || "Copy thất bại",
                  },
                ]);
              }
            }
            xs({ current: ee + 1, total: D.length });
            continue;
          }
          try {
            const pe = await Me.mergeVideos(
              t,
              te.jobs.map((Oe) => Oe.id),
              V,
              xe,
            );
            En((Oe) => [
              ...Oe,
              {
                label: le,
                status: "ok",
                message: `Ghép ${pe.videoCount} video → ${pe.fileName}`,
                fileName: pe.fileName,
              },
            ]);
          } catch (pe) {
            En((Oe) => [
              ...Oe,
              {
                label: le,
                status: "failed",
                message: $t(pe) || "Lỗi không xác định",
              },
            ]);
          }
          xs({ current: ee + 1, total: D.length });
        }
        Wn(!1);
      },
      ts = () => {
        gs.current = !0;
      },
      zs = u.useMemo(
        () =>
          A === "IMAGE_GENERATION" || A === "IMAGE_GENERATION_BATCH_REFS"
            ? $.map((E) => ({ value: E.key, label: E.displayName }))
            : F.map((E) => {
                const D =
                  E.family === "omni_flash" && E.creditByDuration
                    ? (E.creditByDuration[z] ?? E.creditCost)
                    : E.creditCost;
                return {
                  value: E.key,
                  label: E.isRelaxed
                    ? E.displayName
                    : `${E.displayName} (${D} credits${E.family === "omni_flash" ? ` · ${z}s` : ""})`,
                  creditCost: D,
                  isRelaxed: E.isRelaxed,
                  generationTime: E.videoGenerationTimeSeconds,
                };
              }),
        [A, $, F, z],
      ),
      Us = async () => {
        try {
          if (!window.electronAPI?.selectFolder) {
            alert("Folder selection chỉ khả dụng trong Electron app");
            return;
          }
          const E = await window.electronAPI.selectFolder();
          !E.canceled &&
            E.path &&
            (q(E.path),
            Me.updateProject(t, { outputDir: E.path }).catch((D) => {
              console.error("Failed to save outputDir:", D);
            }));
        } catch (E) {
          console.error("Failed to select folder:", E),
            alert("Không thể chọn folder");
        }
      },
      Bs = [
        "TEXT_TO_VIDEO",
        "REFERENCE_TO_VIDEO",
        "IMAGE_TO_VIDEO",
        "FRAME_TO_FRAME",
      ].includes(A),
      ur = Bs ? 3 : 10,
      ho = () => {
        if (zn.length >= ur) {
          alert(`Tối đa ${ur} ảnh tham chiếu cho ${Bs ? "video" : "ảnh"}`);
          return;
        }
        Un.size > 0 || Dt();
      },
      ii = async (E) => {
        if (!l || !l.profiles || l.profiles.length === 0)
          throw new Error("Project chưa được load hoặc không có profile.");
        return D3(E, l.profiles, t, M);
      },
      vu = 2,
      Qt = async (E, D) => {
        let K = 0;
        const ee = Array.from({ length: Math.min(vu, E.length) }, async () => {
          for (;;) {
            const te = K++;
            if (te >= E.length) break;
            await D(E[te], te);
          }
        });
        await Promise.allSettled(ee);
      },
      Dt = () => {
        const E = document.createElement("input");
        (E.type = "file"), (E.accept = "image/*"), (E.multiple = !0);
        let D = !1;
        const K = () => {
          setTimeout(() => {
            !D && r.current && Ht(new Set()),
              window.removeEventListener("focus", K);
          }, 300);
        };
        window.addEventListener("focus", K),
          (E.onchange = async (ee) => {
            const te = ee.target.files;
            if (
              ((D = !0),
              window.removeEventListener("focus", K),
              !te || te.length === 0)
            ) {
              Ht(new Set());
              return;
            }
            const le = ur - zn.length,
              fe = Array.from(te).slice(0, le);
            te.length > le &&
              alert(
                `Chỉ upload ${le}/${te.length} ảnh (đã đạt giới hạn ${ur})`,
              );
            const xe = zn.length,
              pe = new Set(fe.map((Oe, $e) => xe + $e));
            bs((Oe) => [
              ...Oe,
              ...fe.map(() => ({ mediaIds: {}, preview: "" })),
            ]),
              Ht(pe),
              await Qt(fe, async (Oe, $e) => {
                const Te = xe + $e;
                try {
                  const Ue = await ii(Oe);
                  bs((Xe) => {
                    const pt = [...Xe];
                    return (
                      Te < pt.length &&
                        (pt[Te].preview?.startsWith("blob:") &&
                          URL.revokeObjectURL(pt[Te].preview),
                        (pt[Te] = Ue)),
                      pt
                    );
                  });
                } catch (Ue) {
                  console.error(`Upload error (file ${$e + 1}):`, Ue),
                    bs((Xe) => {
                      const pt = [...Xe];
                      return Te < pt.length && (pt[Te].__failed = !0), pt;
                    });
                } finally {
                  Ht((Ue) => {
                    const Xe = new Set(Ue);
                    return Xe.delete(Te), Xe;
                  });
                }
              }),
              bs((Oe) => Oe.filter(($e) => !$e.__failed));
          }),
          E.click();
      },
      ct = async (E) => {
        const D = zn[E];
        if (!D?.mediaIds || Object.keys(D.mediaIds).length === 0) {
          bs((K) => K.filter((ee, te) => te !== E));
          return;
        }
        try {
          if (!l || !l.profiles || l.profiles.length === 0) {
            D.preview &&
              D.preview.startsWith("blob:") &&
              URL.revokeObjectURL(D.preview),
              bs((ee) => ee.filter((te, le) => le !== E));
            return;
          }
          const K = Object.entries(D.mediaIds).map(async ([ee, te]) => {
            try {
              await Me.deleteMedia([te], ee);
            } catch (le) {
              console.error(
                `Failed to delete mediaId ${te} from profile ${ee}:`,
                le,
              );
            }
          });
          await Promise.all(K),
            D.preview &&
              D.preview.startsWith("blob:") &&
              URL.revokeObjectURL(D.preview),
            bs((ee) => ee.filter((te, le) => le !== E));
        } catch (K) {
          console.error("Delete error:", K), alert(`Lỗi xóa ảnh: ${$t(K)}`);
        }
      },
      ns = 9,
      qn = (E, D, K, ee) => () => {
        const te = document.createElement("input");
        (te.type = "file"), (te.accept = "image/*"), (te.multiple = !0);
        let le = !1;
        const fe = () => {
          setTimeout(() => {
            !le && r.current && K(new Set()),
              window.removeEventListener("focus", fe);
          }, 300);
        };
        window.addEventListener("focus", fe),
          (te.onchange = async (xe) => {
            const pe = xe.target.files;
            if (
              ((le = !0),
              window.removeEventListener("focus", fe),
              !pe || pe.length === 0)
            ) {
              K(new Set());
              return;
            }
            const Oe = ee - E.length,
              $e = Array.from(pe).slice(0, Oe);
            pe.length > Oe &&
              alert(
                `Chỉ upload ${Oe}/${pe.length} ảnh (đã đạt giới hạn ${ee})`,
              );
            const Te = E.length,
              Ue = new Set($e.map((Xe, pt) => Te + pt));
            D((Xe) => [
              ...Xe,
              ...$e.map(() => ({ mediaIds: {}, preview: "" })),
            ]),
              K(Ue),
              await Qt($e, async (Xe, pt) => {
                const St = Te + pt;
                try {
                  const Ot = await ii(Xe);
                  D((as) => {
                    const rs = [...as];
                    return (
                      St < rs.length &&
                        (rs[St].preview?.startsWith("blob:") &&
                          URL.revokeObjectURL(rs[St].preview),
                        (rs[St] = Ot)),
                      rs
                    );
                  });
                } catch (Ot) {
                  console.error(`Upload error (file ${pt + 1}):`, Ot),
                    D((as) => {
                      const rs = [...as];
                      return St < rs.length && (rs[St].__failed = !0), rs;
                    });
                } finally {
                  K((Ot) => {
                    const as = new Set(Ot);
                    return as.delete(St), as;
                  });
                }
              }),
              D((Xe) => Xe.filter((pt) => !pt.__failed));
          }),
          te.click();
      },
      mo = (E, D) => async (K) => {
        const ee = E[K];
        if (!ee?.mediaIds || Object.keys(ee.mediaIds).length === 0) {
          D((te) => te.filter((le, fe) => fe !== K));
          return;
        }
        if (!l || !l.profiles || l.profiles.length === 0) {
          ee.preview &&
            ee.preview.startsWith("blob:") &&
            URL.revokeObjectURL(ee.preview),
            D((te) => te.filter((le, fe) => fe !== K));
          return;
        }
        try {
          await Promise.all(
            Object.entries(ee.mediaIds).map(async ([te, le]) => {
              try {
                await Me.deleteMedia([le], te);
              } catch (fe) {
                console.error(
                  `Failed to delete mediaId ${le} from profile ${te}:`,
                  fe,
                );
              }
            }),
          ),
            ee.preview &&
              ee.preview.startsWith("blob:") &&
              URL.revokeObjectURL(ee.preview),
            D((te) => te.filter((le, fe) => fe !== K));
        } catch (te) {
          console.error("Delete error:", te), alert(`Lỗi xóa ảnh: ${$t(te)}`);
        }
      },
      ra = () => {
        if (Rn.length >= ns) {
          alert(`Tối đa ${ns} ảnh fix cứng (slot 10 dành cho ảnh động).`);
          return;
        }
        Zn.size > 0 || qn(Rn, Gr, ja, ns)();
      },
      yu = mo(Rn, Gr),
      Rc = () => {
        Pt.size > 0 || qn(fn, _s, Vi, 9999)();
      },
      ol = mo(fn, _s),
      ss = 15,
      cl = () => {
        if (it.length >= ss) {
          alert(`Tối đa ${ss} ảnh tham chiếu`);
          return;
        }
        Bn.size > 0 || oi();
      },
      oi = () => {
        const E = document.createElement("input");
        (E.type = "file"), (E.accept = "image/*"), (E.multiple = !0);
        let D = !1;
        const K = () => {
          setTimeout(() => {
            !D && r.current && Fa(new Set()),
              window.removeEventListener("focus", K);
          }, 300);
        };
        window.addEventListener("focus", K),
          (E.onchange = async (ee) => {
            const te = ee.target.files;
            if (
              ((D = !0),
              window.removeEventListener("focus", K),
              !te || te.length === 0)
            ) {
              Fa(new Set());
              return;
            }
            const le = ss - it.length,
              fe = Array.from(te).slice(0, le);
            te.length > le &&
              alert(
                `Chỉ upload ${le}/${te.length} ảnh (đã đạt giới hạn ${ss})`,
              );
            const xe = it.length,
              pe = new Set(fe.map((Te, Ue) => xe + Ue)),
              Oe = it.map((Te) => Te.name),
              $e = fe.map((Te) => {
                const Ue = k1(z3(Te.name), Oe);
                return Oe.push(Ue), Ue;
              });
            sn((Te) => [
              ...Te,
              ...fe.map((Ue, Xe) => ({
                mediaIds: {},
                preview: "",
                name: $e[Xe],
                uid: crypto.randomUUID(),
              })),
            ]),
              Fa(pe),
              await Qt(fe, async (Te, Ue) => {
                const Xe = xe + Ue;
                try {
                  const pt = await ii(Te);
                  sn((St) => {
                    const Ot = [...St];
                    return (
                      Xe < Ot.length &&
                        (Ot[Xe].preview?.startsWith("blob:") &&
                          pf(Ot[Xe].preview),
                        (Ot[Xe] = {
                          ...pt,
                          name: Ot[Xe].name,
                          uid: Ot[Xe].uid,
                        })),
                      Ot
                    );
                  });
                } catch (pt) {
                  console.error(`Upload error (file ${Ue + 1}):`, pt),
                    sn((St) => {
                      const Ot = [...St];
                      return Xe < Ot.length && (Ot[Xe].__failed = !0), Ot;
                    });
                } finally {
                  Fa((pt) => {
                    const St = new Set(pt);
                    return St.delete(Xe), St;
                  });
                }
              }),
              sn((Te) => {
                const Ue = Te.filter((Xe) => !Xe.__failed);
                return Ue.length !== Te.length && Ga({}), Ue;
              });
          }),
          E.click();
      },
      fo = async (E) => {
        Ga({});
        const D = it[E];
        if (!D?.mediaIds || Object.keys(D.mediaIds).length === 0) {
          sn((K) => K.filter((ee, te) => te !== E));
          return;
        }
        try {
          if (!l || !l.profiles || l.profiles.length === 0) {
            D.preview && D.preview.startsWith("blob:") && pf(D.preview),
              sn((ee) => ee.filter((te, le) => le !== E));
            return;
          }
          const K = Object.entries(D.mediaIds).map(async ([ee, te]) => {
            try {
              await Me.deleteMedia([te], ee);
            } catch (le) {
              console.error(
                `Failed to delete mediaId ${te} from profile ${ee}:`,
                le,
              );
            }
          });
          await Promise.all(K),
            D.preview &&
              D.preview.startsWith("blob:") &&
              URL.revokeObjectURL(D.preview),
            sn((ee) => ee.filter((te, le) => le !== E));
        } catch (K) {
          console.error("Delete error:", K), alert(`Lỗi xóa ảnh: ${$t(K)}`);
        }
      },
      Aa = () => {
        if (Qs.length >= 700) {
          alert("Tối đa 700 ảnh start frame");
          return;
        }
        const E = document.createElement("input");
        (E.type = "file"),
          (E.accept = "image/*"),
          (E.multiple = !0),
          (E.onchange = async (D) => {
            const K = D.target.files;
            if (!K || K.length === 0) return;
            const ee = 700 - Qs.length;
            if (K.length > ee) {
              alert(`Chỉ có thể thêm tối đa ${ee} ảnh nữa (tối đa 700 ảnh)`);
              return;
            }
            const te = Array.from(K).sort((xe, pe) =>
                xe.name.localeCompare(pe.name, void 0, {
                  numeric: !0,
                  sensitivity: "base",
                }),
              ),
              le = [],
              fe = [];
            for (const xe of te)
              try {
                (await yi(xe, M)).isValid ? le.push(xe) : fe.push(xe);
              } catch (pe) {
                console.error("Error validating image:", pe),
                  alert(`Lỗi kiểm tra ảnh ${xe.name}`);
              }
            if (le.length > 0) {
              const xe = le.map((pe) => ({
                file: pe,
                preview: URL.createObjectURL(pe),
              }));
              xn((pe) => {
                const Oe =
                    pe.length > 0
                      ? Math.max(...pe.map((Te) => Te.jobIndex))
                      : 0,
                  $e = xe.map((Te, Ue) => ({
                    file: Te.file,
                    preview: Te.preview,
                    jobIndex: Oe + Ue + 1,
                  }));
                return [...pe, ...$e].sort(
                  (Te, Ue) => Te.jobIndex - Ue.jobIndex,
                );
              });
            }
            if (fe.length > 0) {
              const xe = fe[0],
                pe = fe.slice(1),
                Oe = await yi(xe, M),
                $e = xh(Oe.imageRatio, M);
              alert(`${$e}

${fe.length} ảnh cần crop theo tỉ lệ ${M}`),
                ea({ isOpen: !0, file: xe, type: "start", pendingFiles: pe });
            }
          }),
          E.click();
      },
      la = (E) => {
        xn((D) => {
          const K = D.find((le) => le.jobIndex === E);
          return (
            K?.preview && URL.revokeObjectURL(K.preview),
            D.filter((le) => le.jobIndex !== E).map((le, fe) => ({
              ...le,
              jobIndex: fe + 1,
            }))
          );
        });
      },
      Ma = () => {
        if (an.length >= 700) {
          alert("Tối đa 700 shot reference");
          return;
        }
        const E = document.createElement("input");
        (E.type = "file"),
          (E.accept = "image/*"),
          (E.multiple = !0),
          (E.onchange = async (D) => {
            const K = D.target.files;
            if (!K || K.length === 0) return;
            const ee = 700 - an.length;
            if (K.length > ee) {
              alert(`Chỉ có thể thêm tối đa ${ee} shot nữa (tối đa 700 shot)`);
              return;
            }
            const te = Array.from(K).sort((xe, pe) =>
                xe.name.localeCompare(pe.name, void 0, {
                  numeric: !0,
                  sensitivity: "base",
                }),
              ),
              le = [],
              fe = [];
            for (const xe of te)
              try {
                (await yi(xe, M)).isValid ? le.push(xe) : fe.push(xe);
              } catch (pe) {
                console.error("Error validating image:", pe),
                  alert(`Lỗi kiểm tra ảnh ${xe.name}`);
              }
            if (le.length > 0) {
              const xe = le.map((pe) => ({
                file: pe,
                preview: URL.createObjectURL(pe),
              }));
              wn((pe) => {
                const Oe = R1(pe),
                  $e = xe.map((Te, Ue) => ({
                    jobIndex: Oe + Ue,
                    images: [{ file: Te.file, preview: Te.preview, slot: 0 }],
                  }));
                return [...pe, ...$e].sort(
                  (Te, Ue) => Te.jobIndex - Ue.jobIndex,
                );
              });
            }
            if (fe.length > 0) {
              const xe = fe[0],
                pe = await yi(xe, M),
                Oe = xh(pe.imageRatio, M);
              alert(`${Oe}

${fe.length} ảnh cần crop theo tỉ lệ ${M}`),
                ea({
                  isOpen: !0,
                  file: xe,
                  type: "reference",
                  pendingFiles: fe.slice(1),
                  targetJobIndex: void 0,
                });
            }
          }),
          E.click();
      },
      ia = (E) => {
        const D = an.find((ee) => ee.jobIndex === E);
        if (D && D.images.length >= Ph) return;
        const K = document.createElement("input");
        (K.type = "file"),
          (K.accept = "image/*"),
          (K.multiple = !1),
          (K.onchange = async (ee) => {
            const te = ee.target.files?.[0];
            if (!te) return;
            let le;
            try {
              le = await yi(te, M);
            } catch (xe) {
              console.error("Error validating image:", xe),
                alert(`Lỗi kiểm tra ảnh ${te.name}`);
              return;
            }
            if (!le.isValid) {
              const xe = xh(le.imageRatio, M);
              alert(`${xe}

Ảnh cần crop theo tỉ lệ ${M}`),
                ea({
                  isOpen: !0,
                  file: te,
                  type: "reference",
                  pendingFiles: [],
                  targetJobIndex: E,
                });
              return;
            }
            const fe = URL.createObjectURL(te);
            wn((xe) => _1(xe, E, te, fe));
          }),
          K.click();
      },
      _c = (E, D) => {
        wn((K) => {
          const ee = K.find((fe) => fe.jobIndex === E);
          if (!ee) return K;
          const te = ee.images.find((fe) => fe.slot === D);
          te?.preview && URL.revokeObjectURL(te.preview);
          const le = ee.images
            .filter((fe) => fe.slot !== D)
            .map((fe, xe) => ({ ...fe, slot: xe }));
          return le.length === 0
            ? K.filter((fe) => fe.jobIndex !== E).map((fe, xe) => ({
                ...fe,
                jobIndex: xe + 1,
              }))
            : K.map((fe) => (fe.jobIndex === E ? { ...fe, images: le } : fe));
        });
      },
      xo = (E) => {
        wn(
          (D) => (
            D.find((ee) => ee.jobIndex === E)?.images.forEach((ee) =>
              URL.revokeObjectURL(ee.preview),
            ),
            D.filter((ee) => ee.jobIndex !== E).map((ee, te) => ({
              ...ee,
              jobIndex: te + 1,
            }))
          ),
        );
      },
      dl = () => {
        const E = document.createElement("input");
        (E.type = "file"),
          (E.accept = ".xlsx,.xls"),
          (E.onchange = async (D) => {
            const K = D.target.files?.[0];
            if (K) {
              dc(!0), Ki({ current: 0, total: 0 });
              try {
                const ee = await new Promise((Xe, pt) => {
                    const St = new FileReader();
                    (St.onload = () => Xe(St.result.split(",")[1])),
                      (St.onerror = pt),
                      St.readAsDataURL(K);
                  }),
                  te = await Me.parseExcel(ee);
                if (!te.success || !te.rows?.length) {
                  alert(te.error || "Không đọc được prompt nào từ file Excel");
                  return;
                }
                const le = te.rows;
                Ki({ current: 0, total: le.length });
                const fe = new Array(le.length).fill(null),
                  xe = [];
                let pe = 0,
                  Oe = 0;
                const $e = async () => {
                  for (; pe < le.length; ) {
                    const Xe = pe++,
                      pt = le[Xe],
                      St = (pt.paths ?? []).filter(Boolean).slice(0, Ph);
                    if (St.length === 0)
                      xe.push(`Dòng ${Xe + 2}: thiếu đường dẫn ảnh`);
                    else {
                      const as = (
                        await Promise.all(
                          St.map(async (rs, vo) => {
                            const ca = await Me.readLocalImage(rs);
                            if (ca.success && ca.base64) {
                              const Yn = await (
                                await fetch(
                                  `data:${ca.mimeType};base64,${ca.base64}`,
                                )
                              ).blob();
                              return new File(
                                [Yn],
                                ca.fileName || `ref_${Xe + 1}_${vo + 1}.jpg`,
                                { type: ca.mimeType },
                              );
                            }
                            return (
                              xe.push(
                                `Dòng ${Xe + 2} ảnh ${vo + 1}: ${ca.error || "không đọc được ảnh"}`,
                              ),
                              null
                            );
                          }),
                        )
                      ).filter(Boolean);
                      as.length > 0 &&
                        (fe[Xe] = { prompt: pt.prompt, files: as });
                    }
                    (Oe += 1), Ki({ current: Oe, total: le.length });
                  }
                };
                await Promise.all(Array.from({ length: 6 }, $e));
                const Te = fe.filter(Boolean);
                if (Te.length === 0) {
                  alert(
                    `Không tải được ảnh nào.
${xe.slice(0, 5).join(`
`)}` +
                      (xe.length > 5
                        ? `
… và ${xe.length - 5} dòng khác`
                        : ""),
                  );
                  return;
                }
                const Ue = Te.map((Xe, pt) => ({
                  jobIndex: pt + 1,
                  images: Xe.files.map((St, Ot) => ({
                    file: St,
                    preview: URL.createObjectURL(St),
                    slot: Ot,
                  })),
                }));
                wn(
                  (Xe) => (
                    Xe.forEach((pt) =>
                      pt.images.forEach((St) =>
                        URL.revokeObjectURL(St.preview),
                      ),
                    ),
                    Ue
                  ),
                ),
                  C("separator"),
                  w(
                    Te.map((Xe) => Xe.prompt).join(`
=====
`),
                  ),
                  xe.length > 0 &&
                    alert(
                      `Đã import ${Te.length}/${le.length} shot. ${xe.length} ảnh lỗi:
` +
                        xe.slice(0, 8).join(`
`) +
                        (xe.length > 8
                          ? `
… và ${xe.length - 8} dòng khác`
                          : ""),
                    );
              } catch (ee) {
                console.error("Import Excel failed:", ee),
                  alert(`Lỗi import Excel: ${$t(ee)}`);
              } finally {
                dc(!1), Ki({ current: 0, total: 0 });
              }
            }
          }),
          E.click();
      },
      ci = u.useMemo(() => {
        if (A !== "REFERENCE_BATCH") return [];
        let E;
        switch (N) {
          case "blankline":
            E = /\n\s*\n/;
            break;
          case "separator":
            E = /\n=====\n|=====/;
            break;
          case "custom":
            E =
              k ||
              `
`;
            break;
          default:
            E = /\n/;
        }
        return v
          .split(E)
          .map((D) => D.trim())
          .filter(Boolean);
      }, [A, v, N, k]),
      oa = ci.length,
      {
        componentsHandleMap: Yt,
        componentsImagesByName: di,
        componentsDuplicateNames: ul,
      } = u.useMemo(() => {
        const E = new Map();
        for (const ee of it) {
          if (!ee.name) continue;
          const te = ee.name.toLowerCase();
          E.set(te, (E.get(te) ?? 0) + 1);
        }
        const D = new Map(),
          K = new Map();
        for (const ee of it) {
          if (!ee.name) continue;
          const te = ee.name.toLowerCase();
          E.get(te) === 1 &&
            (K.set(te, ee), D.set(te, { canonical: ee.name, mediaId: te }));
        }
        return {
          componentsHandleMap: D,
          componentsImagesByName: K,
          componentsDuplicateNames: new Set(
            [...E.entries()].filter(([, ee]) => ee > 1).map(([ee]) => ee),
          ),
        };
      }, [it]),
      Ns = A === "COMPONENTS" && Yt.size > 0 && P3(v),
      Vs = u.useMemo(() => {
        if (!Ns) return [];
        let E;
        switch (N) {
          case "blankline":
            E = /\n\s*\n/;
            break;
          case "separator":
            E = /\n=====\n|=====/;
            break;
          case "custom":
            E =
              k ||
              `
`;
            break;
          default:
            E = /\n/;
        }
        return v
          .split(E)
          .map((D) => D.trim())
          .filter(Boolean)
          .map((D, K) => {
            const { bound: ee, unknown: te, overflow: le } = L3(D, Yt, rn),
              fe = ee
                .map((pe) => di.get(pe.toLowerCase()))
                .filter((pe) => !!pe),
              xe =
                te.length > 0 || le ? "error" : fe.length === 0 ? "warn" : "ok";
            return {
              idx: K,
              text: D,
              resolved: fe,
              unknown: te,
              overflow: le,
              status: xe,
            };
          });
      }, [Ns, v, N, k, Yt, di, rn]),
      pn = u.useMemo(() => {
        const E = new Set();
        let D = 0,
          K = 0,
          ee = 0;
        for (const te of Vs)
          te.unknown.forEach((le) => E.add(le)),
            te.overflow && (ee += 1),
            te.status === "error" ? (D += 1) : te.status === "warn" && (K += 1);
        return {
          total: Vs.length,
          okRows: Vs.length - D - K,
          errorRows: D,
          warnRows: K,
          overflowRows: ee,
          unknownHandles: [...E],
        };
      }, [Vs]),
      Xt = A === "COMPONENTS" && (ul.size > 0 || it.some((E) => !E.name)),
      Ic = u.useMemo(() => {
        if (!(!Ns || Vs.length === 0))
          return Vs.map((E) =>
            E.resolved.map((D) => ({
              handle: D.name,
              mediaIds: D.mediaIds,
              previewUrl: D.preview || null,
            })),
          );
      }, [Ns, Vs]),
      [hr, ui] = u.useState(!1),
      hi = u.useMemo(
        () => (hr ? Vs : Vs.filter((E) => E.status !== "ok")),
        [hr, Vs],
      ),
      mr = u.useRef(null),
      fr = N1({
        count: hi.length,
        getScrollElement: () => mr.current,
        estimateSize: () => 34,
        overscan: 8,
      }),
      go = u.useRef(null),
      Dc = u.useRef(null);
    u.useEffect(() => {
      go.current = null;
    }, [A]);
    const F0 = (E) => {
        const D = `@${E} `,
          K = go.current,
          ee = K?.start ?? v.length,
          te = K?.end ?? ee,
          le = v.slice(0, ee) + D + v.slice(te);
        w(le);
        const fe = ee + D.length;
        (go.current = { start: fe, end: fe }),
          requestAnimationFrame(() => {
            const xe = Dc.current;
            xe && (xe.focus(), xe.setSelectionRange(fe, fe));
          });
      },
      wu = (E, D) => {
        sn((K) => {
          const ee = K[E];
          if (!ee) return K;
          const te = K.filter((pe, Oe) => Oe !== E)
              .map((pe) => pe.name)
              .filter(Boolean),
            le = qy(D),
            fe = le ? k1(le, te) : ee.name;
          if (fe === ee.name) return K;
          const xe = [...K];
          return (xe[E] = { ...ee, name: fe, nameError: void 0 }), xe;
        }),
          Ga((K) => {
            const ee = { ...K };
            return delete ee[E], ee;
          });
      },
      Ra = () => {
        if (Cn.length >= 700) {
          alert("Tối đa 700 ảnh end frame");
          return;
        }
        const E = document.createElement("input");
        (E.type = "file"),
          (E.accept = "image/*"),
          (E.multiple = !0),
          (E.onchange = async (D) => {
            const K = D.target.files;
            if (!K || K.length === 0) return;
            const ee = 700 - Cn.length;
            if (K.length > ee) {
              alert(`Chỉ có thể thêm tối đa ${ee} ảnh nữa (tối đa 700 ảnh)`);
              return;
            }
            const te = Array.from(K).sort((xe, pe) =>
                xe.name.localeCompare(pe.name, void 0, {
                  numeric: !0,
                  sensitivity: "base",
                }),
              ),
              le = [],
              fe = [];
            for (const xe of te)
              try {
                (await yi(xe, M)).isValid ? le.push(xe) : fe.push(xe);
              } catch (pe) {
                console.error("Error validating image:", pe),
                  alert(`Lỗi kiểm tra ảnh ${xe.name}`);
              }
            if (le.length > 0) {
              const xe = le.map((pe) => ({
                file: pe,
                preview: URL.createObjectURL(pe),
              }));
              ka((pe) => {
                const Oe =
                    pe.length > 0
                      ? Math.max(...pe.map((Te) => Te.jobIndex))
                      : 0,
                  $e = xe.map((Te, Ue) => ({
                    file: Te.file,
                    preview: Te.preview,
                    jobIndex: Oe + Ue + 1,
                  }));
                return [...pe, ...$e].sort(
                  (Te, Ue) => Te.jobIndex - Ue.jobIndex,
                );
              });
            }
            if (fe.length > 0) {
              const xe = fe[0],
                pe = fe.slice(1),
                Oe = await yi(xe, M),
                $e = xh(Oe.imageRatio, M);
              alert(`${$e}

${fe.length} ảnh cần crop theo tỉ lệ ${M}`),
                ea({ isOpen: !0, file: xe, type: "end", pendingFiles: pe });
            }
          }),
          E.click();
      },
      Oc = (E) => {
        ka((D) => {
          const K = D.find((le) => le.jobIndex === E);
          return (
            K?.preview && URL.revokeObjectURL(K.preview),
            D.filter((le) => le.jobIndex !== E).map((le, fe) => ({
              ...le,
              jobIndex: fe + 1,
            }))
          );
        });
      },
      po = async (E) => {
        const { type: D, pendingFiles: K } = Wa;
        if (!D) {
          ea({ isOpen: !1, file: null, type: null, pendingFiles: [] });
          return;
        }
        if (D === "start") {
          const ee = URL.createObjectURL(E);
          xn((te) => {
            const le =
                te.length > 0 ? Math.max(...te.map((xe) => xe.jobIndex)) : 0,
              fe = { file: E, preview: ee, jobIndex: le + 1 };
            return [...te, fe].sort((xe, pe) => xe.jobIndex - pe.jobIndex);
          });
        } else if (D === "end") {
          const ee = URL.createObjectURL(E);
          ka((te) => {
            const le =
                te.length > 0 ? Math.max(...te.map((xe) => xe.jobIndex)) : 0,
              fe = { file: E, preview: ee, jobIndex: le + 1 };
            return [...te, fe].sort((xe, pe) => xe.jobIndex - pe.jobIndex);
          });
        } else if (D === "reference") {
          const { targetJobIndex: ee } = Wa,
            te = URL.createObjectURL(E);
          wn((le) =>
            ee !== void 0
              ? _1(le, ee, E, te)
              : [
                  ...le,
                  {
                    jobIndex: R1(le),
                    images: [{ file: E, preview: te, slot: 0 }],
                  },
                ].sort((fe, xe) => fe.jobIndex - xe.jobIndex),
          );
        }
        if (K.length > 0) {
          const ee = K[0],
            te = K.slice(1);
          ea({
            isOpen: !0,
            file: ee,
            type: D,
            pendingFiles: te,
            targetJobIndex: Wa.targetJobIndex,
          });
        } else ea({ isOpen: !1, file: null, type: null, pendingFiles: [] });
      },
      ju = () => {
        ea({ isOpen: !1, file: null, type: null, pendingFiles: [] });
      },
      xr = l?.status === "GENERATING",
      mi = jc.length > 0,
      fi = [...new Set(B0.map((E) => E.profileId))],
      ks = fi
        .filter((E) => !Yi.has(E))
        .map(
          (E) => l?.profiles.find((D) => D.profileId === E)?.profile.name ?? E,
        ),
      Nu =
        ks.length <= 3
          ? ks.join(", ")
          : `${ks.slice(0, 2).join(", ")} và ${ks.length - 2} khác`,
      ku = ks.length > 0,
      gr = () => {
        Xi((E) => new Set([...E, ...fi]));
      },
      Dn = du
        .filter((E) => !Yi.has(E))
        .map(
          (E) => l?.profiles.find((D) => D.profileId === E)?.profile.name ?? E,
        ),
      Su =
        Dn.length <= 3
          ? Dn.join(", ")
          : `${Dn.slice(0, 2).join(", ")} và ${Dn.length - 2} khác`,
      Eu = Dn.length > 0,
      pr = u.useMemo(
        () => l?.status === "PAUSED" && b.some((E) => E.error?.startsWith(lx)),
        [l?.status, b],
      ),
      xi = () => {
        Xi((E) => new Set([...E, ...du]));
      },
      bo = async () => {
        if (!Ze) {
          ze(!0);
          try {
            await Me.resetCaptchaAndRetry(t), await c();
          } catch (E) {
            console.error("Reset captcha failed:", E),
              alert(`Lỗi reset captcha: ${$t(E)}`);
          } finally {
            ze(!1);
          }
        }
      },
      hl = async () => {
        if (Mt.length === 0) {
          alert("Không có job nào để bắt đầu gen");
          return;
        }
        const E = A,
          D = M;
        try {
          if ((He(!0), Vn))
            try {
              await Me.deleteAllCompletedJobs(t),
                console.log(
                  "✅ Deleted all completed jobs before starting reuse generation",
                );
            } catch (ee) {
              console.warn("Failed to delete completed jobs:", ee);
            }
          const K =
            A === "IMAGE_GENERATION" || A === "IMAGE_GENERATION_BATCH_REFS";
          await Me.startGeneration(
            t,
            ce,
            K ? void 0 : _,
            Q,
            we,
            K ? _ : void 0,
            Fn ? z : void 0,
          ),
            Qa(!0),
            Ul(Date.now()),
            ws(0),
            Vn && (Ja(!1), Wi([])),
            await p(),
            await c(),
            T(E),
            S(D);
        } catch (K) {
          console.error("Failed to start generation:", K);
          const ee = K ?? {};
          console.error("Error details:", {
            message: ee.message,
            status: ee.status,
            data: ee.data,
            name: ee.name,
          });
          let te = $t(K) || "Không thể bắt đầu gen";
          const le = ee.data;
          if (le)
            if (typeof le == "object" && le !== null) {
              const fe = le;
              typeof fe.message == "string" && fe.message
                ? (te = fe.message)
                : typeof fe.error == "string" && fe.error && (te = fe.error);
            } else typeof le == "string" && le && (te = le);
          te.includes("requires") || te.includes("Validation failed")
            ? alert(`Validation failed:
${te}

Vui lòng kiểm tra lại các job và thêm đủ ảnh cần thiết.`)
            : alert(te),
            T(E),
            S(D);
        } finally {
          He(!1);
        }
      };
    return e.jsxs("div", {
      className: "h-screen flex flex-col bg-slate-50 relative",
      children: [
        Xr &&
          e.jsx("div", {
            className:
              "absolute inset-0 bg-black/50 z-50 flex items-center justify-center",
            children: e.jsx("div", {
              className: "bg-white rounded-xl shadow-xl p-8 max-w-md mx-4",
              children: e.jsxs("div", {
                className: "flex flex-col items-center gap-4",
                children: [
                  e.jsxs("div", {
                    className: "relative",
                    children: [
                      e.jsx("div", {
                        className:
                          "w-16 h-16 border-4 border-indigo-200 rounded-full",
                      }),
                      e.jsx("div", {
                        className:
                          "absolute top-0 left-0 w-16 h-16 border-4 border-indigo-600 rounded-full border-t-transparent animate-spin",
                      }),
                    ],
                  }),
                  e.jsxs("div", {
                    className: "text-center",
                    children: [
                      e.jsx("h3", {
                        className: "text-lg font-semibold text-slate-900 mb-2",
                        children: "Đang khởi tạo...",
                      }),
                      e.jsx("p", {
                        className: "text-sm text-slate-600 mb-3",
                        children:
                          "Jobs đã được tạo, đang chờ reCAPTCHA verification",
                      }),
                      e.jsxs("div", {
                        className:
                          "flex items-center justify-center gap-2 text-indigo-600",
                        children: [
                          e.jsx(Ri, { className: "h-5 w-5" }),
                          e.jsxs("span", {
                            className: "font-medium",
                            children: [Bl, "s"],
                          }),
                        ],
                      }),
                      e.jsx("p", {
                        className: "text-xs text-slate-500 mt-3",
                        children: "Quá trình này có thể mất 30-60 giây...",
                      }),
                    ],
                  }),
                  e.jsx("button", {
                    onClick: () => {
                      Qa(!1), Ul(null), ws(0);
                    },
                    className:
                      "mt-2 text-sm text-slate-500 hover:text-slate-700 underline",
                    children: "Ẩn thông báo này",
                  }),
                ],
              }),
            }),
          }),
        e.jsx("div", {
          className: "px-4 pt-3 empty:hidden",
          children: e.jsx(Zy, { autoStart: !0, variant: "compact" }),
        }),
        e.jsxs("div", {
          className:
            "bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between sticky top-0 z-10 shadow-sm",
          children: [
            e.jsxs("div", {
              className: "flex items-center gap-2",
              children: [
                e.jsx("button", {
                  onClick: el,
                  className:
                    "p-1 -ml-1 hover:bg-slate-100 rounded-md text-slate-500 hover:text-slate-700 transition-colors",
                  title: "Quay lại",
                  children: e.jsx(Hd, { className: "h-4 w-4" }),
                }),
                e.jsx("h1", {
                  className:
                    "text-sm font-semibold text-slate-900 flex items-center gap-2 min-w-0",
                  children: h
                    ? e.jsx("span", {
                        className:
                          "inline-block h-4 w-40 bg-slate-200 rounded animate-pulse",
                      })
                    : e.jsxs(e.Fragment, {
                        children: [
                          e.jsx("span", {
                            className: "truncate",
                            children: l?.name,
                          }),
                          e.jsx("span", {
                            className:
                              "text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 flex-shrink-0",
                            children: l?.mode || "Normal",
                          }),
                        ],
                      }),
                }),
              ],
            }),
            e.jsx("div", {
              className: "flex items-center gap-1.5",
              children:
                xr && sr
                  ? e.jsxs(e.Fragment, {
                      children: [
                        e.jsxs("button", {
                          onClick: fu,
                          className:
                            "inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50",
                          children: [
                            e.jsx(ik, { className: "h-3.5 w-3.5" }),
                            "Tạm dừng",
                          ],
                        }),
                        e.jsxs("button", {
                          onClick: xu,
                          className:
                            "inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50",
                          children: [
                            e.jsx(tt, { className: "h-3.5 w-3.5" }),
                            "Dừng hẳn",
                          ],
                        }),
                        tl.length > 0 &&
                          jc.length === 0 &&
                          e.jsxs("span", {
                            className:
                              "inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md",
                            children: [
                              e.jsx(Fe, { className: "h-3 w-3 animate-spin" }),
                              "Đang upscale ",
                              tl.length,
                              " jobs",
                            ],
                          }),
                      ],
                    })
                  : l?.status === "PAUSED" && sr && !pr
                    ? e.jsxs("button", {
                        onClick: Cc,
                        disabled: Ge,
                        className:
                          "inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50",
                        children: [
                          e.jsx(ga, { className: "h-3.5 w-3.5" }),
                          "Tiếp tục",
                        ],
                      })
                    : sr && !xr && !vc && l?.status !== "PAUSED"
                      ? e.jsxs("button", {
                          onClick: Cc,
                          className:
                            "inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700",
                          children: [
                            e.jsx(ga, { className: "h-3.5 w-3.5" }),
                            "Tiếp tục gen",
                          ],
                        })
                      : null,
            }),
          ],
        }),
        pr &&
          e.jsxs("div", {
            role: "alert",
            "aria-atomic": "true",
            className:
              "mx-4 mb-2 flex flex-wrap items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-2.5",
            children: [
              e.jsx(Ri, {
                className: "h-5 w-5 flex-shrink-0 text-orange-500 mt-0.5",
                "aria-hidden": "true",
              }),
              e.jsxs("div", {
                className: "flex-1 min-w-0 text-sm text-orange-800",
                children: [
                  e.jsx("p", {
                    className: "font-semibold",
                    children:
                      "Veo3 đang quá tải (quá nhiều traffic) — đã tạm dừng gen.",
                  }),
                  e.jsx("p", {
                    className: "mt-0.5",
                    children:
                      'Nghỉ vài phút cho Veo3 reset rồi bấm "Tiếp tục gen". Job chưa xong vẫn được giữ, không mất.',
                  }),
                ],
              }),
              e.jsxs("button", {
                type: "button",
                onClick: Cc,
                disabled: Ge,
                "aria-label": "Tiếp tục gen sau khi Veo3 reset",
                className:
                  "flex-shrink-0 self-center inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50",
                children: [
                  Ge
                    ? e.jsx(Fe, { className: "h-3.5 w-3.5 animate-spin" })
                    : e.jsx(ga, { className: "h-3.5 w-3.5" }),
                  Ge ? "Đang tiếp tục..." : "Tiếp tục gen",
                ],
              }),
            ],
          }),
        ku &&
          e.jsxs("div", {
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
            className:
              "mx-4 mb-2 flex flex-wrap items-start gap-3 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2.5",
            children: [
              e.jsx(_i, {
                className: "h-5 w-5 flex-shrink-0 text-indigo-500 mt-0.5",
                "aria-hidden": "true",
              }),
              e.jsxs("div", {
                className: "flex-1 min-w-0 text-sm text-indigo-800",
                children: [
                  e.jsx("span", {
                    className: "font-medium",
                    children:
                      ks.length === 1
                        ? `Profile "${ks[0]}" đã hết quota ngày của Veo3.`
                        : `${ks.length} profiles đã hết quota ngày của Veo3 (${Nu}).`,
                  }),
                  " ",
                  "Gen đã dừng cho các job liên quan. Veo3 tự reset sau ~24h — không cần thao tác gì thêm.",
                ],
              }),
              e.jsxs("button", {
                type: "button",
                onClick: gr,
                "aria-label": "Đóng thông báo hết quota ngày Veo3",
                className:
                  "flex-shrink-0 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-100 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 transition-colors",
                children: [
                  e.jsx(at, {
                    className: "h-3.5 w-3.5",
                    "aria-hidden": "true",
                  }),
                  "Hiểu rồi",
                ],
              }),
            ],
          }),
        Eu &&
          e.jsxs("div", {
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
            className:
              "mx-4 mb-2 flex flex-wrap items-start gap-3 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2.5",
            children: [
              e.jsx(_i, {
                className: "h-5 w-5 flex-shrink-0 text-indigo-500 mt-0.5",
                "aria-hidden": "true",
              }),
              e.jsxs("div", {
                className: "flex-1 min-w-0 text-sm text-indigo-800",
                children: [
                  e.jsx("span", {
                    className: "font-medium",
                    children:
                      Dn.length === 1
                        ? `Profile "${Dn[0]}" cần nâng cấp gói Veo3 để tiếp tục.`
                        : `${Dn.length} profiles cần nâng cấp gói Veo3 (${Su}).`,
                  }),
                  " ",
                  "Gen đã dừng cho các job liên quan. Vui lòng thay hoặc nâng cấp tài khoản để gen tiếp.",
                ],
              }),
              e.jsxs("button", {
                type: "button",
                onClick: xi,
                "aria-label": "Đóng thông báo cần nâng cấp tài khoản Veo3",
                className:
                  "flex-shrink-0 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-100 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 transition-colors",
                children: [
                  e.jsx(at, {
                    className: "h-3.5 w-3.5",
                    "aria-hidden": "true",
                  }),
                  "Hiểu rồi",
                ],
              }),
            ],
          }),
        Nc >= I4 &&
          e.jsxs("div", {
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
            className:
              "mx-4 mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5",
            children: [
              e.jsx(Mn, { className: "h-5 w-5 flex-shrink-0 text-amber-600" }),
              e.jsxs("div", {
                className: "flex-1 min-w-0 text-sm text-amber-800",
                children: [
                  e.jsxs("span", {
                    className: "font-medium",
                    children: [Nc, " job đang bị lỗi captcha (403) nhiều lần."],
                  }),
                  " ",
                  "Nhấn Reset để xoá giới hạn và gen tiếp ngay.",
                ],
              }),
              e.jsxs("button", {
                type: "button",
                onClick: bo,
                disabled: Ze,
                className:
                  "inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50",
                children: [
                  e.jsx(Fe, {
                    className: `h-3.5 w-3.5 ${Ze ? "animate-spin" : ""}`,
                  }),
                  Ze ? "Đang reset..." : "Reset & tiếp tục",
                ],
              }),
            ],
          }),
        ta &&
          na > 0 &&
          !D0 &&
          e.jsxs("div", {
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
            className:
              "mx-4 mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5",
            children: [
              e.jsx(Mn, { className: "h-5 w-5 flex-shrink-0 text-amber-600" }),
              e.jsxs("div", {
                className: "flex-1 min-w-0 text-sm text-amber-800",
                children: [
                  e.jsxs("span", {
                    className: "font-medium",
                    children: [na, " video không tải được tự động."],
                  }),
                  " ",
                  "Link có thể đã hết hạn — tải lại sẽ tự làm mới link.",
                ],
              }),
              e.jsxs("button", {
                type: "button",
                onClick: uo,
                disabled: Ie,
                className:
                  "inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50",
                children: [
                  e.jsx(Fe, { className: "h-3.5 w-3.5" }),
                  "Tải lại ngay",
                ],
              }),
              e.jsx("button", {
                type: "button",
                onClick: () => mc(!0),
                "aria-label": "Đóng thông báo",
                className:
                  "text-amber-600 hover:text-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded",
                children: e.jsx(tt, { className: "h-4 w-4" }),
              }),
            ],
          }),
        e.jsxs("div", {
          className: "flex-1 flex gap-4 p-4 overflow-hidden",
          children: [
            e.jsxs("div", {
              className: `flex flex-col min-h-0 transition-all duration-300 ${sr || bt.length > 0 || gn.length > 0 ? "w-[320px] flex-shrink-0" : "w-[400px] flex-shrink-0"}`,
              children: [
                e.jsxs("div", {
                  className:
                    "flex-1 flex flex-col gap-3 min-h-0 relative overflow-y-auto custom-scrollbar pr-1",
                  children: [
                    e.jsxs("div", {
                      className: "flex items-stretch gap-2 flex-shrink-0",
                      children: [
                        e.jsxs("div", {
                          className:
                            "flex-1 bg-white rounded-lg border border-slate-200 px-2 py-1.5 min-w-0",
                          children: [
                            e.jsx("label", {
                              className:
                                "block text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate",
                              children: "Chế độ",
                            }),
                            e.jsxs("select", {
                              value: A,
                              onChange: (E) => rr(E.target.value),
                              disabled: Ta,
                              title: Ta
                                ? 'Đã khoá vì đang có job chờ xử lý. "Bắt đầu gen" hoặc "Xóa tất cả draft" để đổi chế độ.'
                                : "",
                              className:
                                "w-full bg-transparent text-xs font-semibold text-slate-900 focus:outline-none cursor-pointer truncate disabled:cursor-not-allowed disabled:opacity-60",
                              children: [
                                e.jsx("option", {
                                  value: "TEXT",
                                  children: "📝 Văn bản (T2V)",
                                }),
                                e.jsx("option", {
                                  value: "IMAGE",
                                  children: "🖼️ Khung hình (I2V)",
                                }),
                                e.jsx("option", {
                                  value: "COMPONENTS",
                                  children: "🎭 Thành phần",
                                }),
                                e.jsxs("option", {
                                  value: "IMAGE_GENERATION",
                                  disabled: Fn,
                                  children: [
                                    "🎨 Tạo ảnh (T2I)",
                                    Fn ? " — Omni Flash không hỗ trợ" : "",
                                  ],
                                }),
                                e.jsxs("option", {
                                  value: "IMAGE_GENERATION_BATCH_REFS",
                                  disabled: Fn,
                                  children: [
                                    "🖼️➕ Ảnh hàng loạt (fix + động)",
                                    Fn ? " — Omni Flash không hỗ trợ" : "",
                                  ],
                                }),
                                e.jsx("option", {
                                  value: "COMPONENTS_AUDIO",
                                  children: "🎙️ Reference Video + Voice",
                                }),
                                e.jsx("option", {
                                  value: "REFERENCE_BATCH",
                                  children: "🎞️ Reference hàng loạt (R2V)",
                                }),
                              ],
                            }),
                          ],
                        }),
                        e.jsxs("div", {
                          className:
                            "bg-white rounded-lg border border-slate-200 px-2 py-1.5 flex flex-col justify-center min-w-0 flex-shrink-0",
                          children: [
                            e.jsx("label", {
                              className:
                                "block text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5",
                              children: "Tỉ lệ",
                            }),
                            (() => {
                              const E =
                                A === "IMAGE_GENERATION" ||
                                A === "IMAGE_GENERATION_BATCH_REFS"
                                  ? ["1:1", "3:4", "4:3", "16:9", "9:16"]
                                  : ["16:9", "9:16"];
                              return e.jsx("div", {
                                className:
                                  "flex items-center gap-0.5 flex-wrap",
                                title: Ta
                                  ? "Đã khoá vì đang có job chờ xử lý"
                                  : "",
                                children: E.map((D) =>
                                  e.jsx(
                                    "button",
                                    {
                                      onClick: () => !Ta && S(D),
                                      disabled: Ta,
                                      className: `px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${M === D ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`,
                                      children: D,
                                    },
                                    D,
                                  ),
                                ),
                              });
                            })(),
                          ],
                        }),
                        e.jsx("button", {
                          onClick: () => We(!0),
                          className:
                            "bg-white rounded-lg border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 text-slate-600 hover:text-indigo-700 transition-colors flex items-center justify-center w-10 flex-shrink-0",
                          title: "Cài đặt nâng cao (Model · Luồng · Delimiter)",
                          children: e.jsx(Xo, { className: "h-4 w-4" }),
                        }),
                      ],
                    }),
                    e.jsxs("div", {
                      className:
                        "flex items-center gap-1.5 text-[10px] text-slate-500 -mt-1 px-1 flex-shrink-0",
                      children: [
                        m &&
                          e.jsxs(e.Fragment, {
                            children: [
                              e.jsx("span", {
                                className: `px-1.5 py-0.5 rounded font-semibold flex-shrink-0 ${m.userPaygateTier === "PAYGATE_TIER_TWO" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`,
                                title: `Hạng tài khoản: ${m.userPaygateTier === "PAYGATE_TIER_TWO" ? "Ultra" : "Pro"}`,
                                children:
                                  m.userPaygateTier === "PAYGATE_TIER_TWO"
                                    ? "Ultra"
                                    : "Pro",
                              }),
                              e.jsx("span", {
                                className: `px-1.5 py-0.5 rounded font-semibold flex-shrink-0 ${m.credits < 50 ? "bg-amber-100 text-amber-800 border border-amber-300" : "bg-emerald-50 text-emerald-700 border border-emerald-200"}`,
                                title:
                                  m.credits < 50
                                    ? m.userPaygateTier === "PAYGATE_TIER_TWO"
                                      ? `Credit thấp (${m.credits}): Hệ thống tự dùng Lite [Lower Priority] miễn phí.`
                                      : `Credit thấp (${m.credits}): Tài khoản Pro không có chế độ miễn phí, vui lòng nạp thêm credit.`
                                    : `Credit còn lại: ${m.credits}`,
                                children: `💎 ${m.credits ?? 0} cr`,
                              }),
                            ],
                          }),
                        e.jsx("span", {
                          className: "font-medium text-slate-400",
                          children: "Model:",
                        }),
                        e.jsx("span", {
                          className:
                            "truncate flex-1 text-slate-700 font-medium",
                          title: zs.find((E) => E.value === _)?.label || _,
                          children:
                            zs.find((E) => E.value === _)?.label ||
                            _ ||
                            "(chưa chọn)",
                        }),
                        e.jsx("span", {
                          className: "text-slate-300",
                          children: "·",
                        }),
                        e.jsxs("span", {
                          className: "font-medium text-indigo-600",
                          children: [ce, " luồng"],
                        }),
                        we > 1 &&
                          e.jsxs(e.Fragment, {
                            children: [
                              e.jsx("span", {
                                className: "text-slate-300",
                                children: "·",
                              }),
                              e.jsxs("span", {
                                className: "font-medium text-emerald-600",
                                children: [
                                  we,
                                  " ",
                                  A === "IMAGE_GENERATION" ||
                                  A === "IMAGE_GENERATION_BATCH_REFS"
                                    ? "ảnh"
                                    : "video",
                                  "/đợt",
                                ],
                              }),
                            ],
                          }),
                        Fn &&
                          e.jsxs(e.Fragment, {
                            children: [
                              e.jsx("span", {
                                className: "text-slate-300",
                                children: "·",
                              }),
                              e.jsxs("span", {
                                className: "font-medium text-amber-600",
                                children: [z, "s"],
                              }),
                            ],
                          }),
                      ],
                    }),
                    Fn &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-amber-200 px-2 py-1.5 flex flex-col gap-1 flex-shrink-0",
                        children: [
                          e.jsx("label", {
                            className:
                              "block text-[10px] font-medium text-slate-500 uppercase tracking-wider",
                            children: "Độ dài video (Omni Flash)",
                          }),
                          e.jsx("div", {
                            className: "flex items-center gap-1 flex-wrap",
                            children: ou.map((E) => {
                              const D = cu?.[E],
                                K = z === E;
                              return e.jsxs(
                                "button",
                                {
                                  type: "button",
                                  onClick: () => {
                                    Ta ||
                                      (P(E),
                                      Me.updateProject(t, {
                                        videoDurationSeconds: E,
                                      }).catch((ee) =>
                                        console.error(
                                          "Failed to persist videoDurationSeconds:",
                                          ee,
                                        ),
                                      ));
                                  },
                                  disabled: Ta,
                                  className: `px-2 py-0.5 rounded text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${K ? "bg-amber-500 text-white" : "bg-slate-50 text-slate-600 hover:bg-amber-50"}`,
                                  title: D != null ? `${D} credits` : void 0,
                                  children: [
                                    E,
                                    "s",
                                    D != null ? ` · ${D}💎` : "",
                                  ],
                                },
                                E,
                              );
                            }),
                          }),
                        ],
                      }),
                    e.jsxs("div", {
                      className:
                        "bg-white rounded-lg border border-slate-200 p-3 flex flex-col flex-1 shadow-sm hover:border-indigo-300 transition-colors",
                      children: [
                        e.jsxs("div", {
                          className: "flex items-center justify-between mb-2",
                          children: [
                            e.jsx("label", {
                              className:
                                "block text-xs font-medium text-slate-700 uppercase tracking-wider",
                              children: "Prompts",
                            }),
                            e.jsxs("div", {
                              className: "flex items-center gap-2",
                              children: [
                                e.jsxs("select", {
                                  value: N,
                                  onChange: (E) => C(E.target.value),
                                  className:
                                    "text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border-0 focus:ring-1 focus:ring-indigo-400",
                                  title: "Ký tự phân tách prompt",
                                  children: [
                                    e.jsx("option", {
                                      value: "newline",
                                      children: "Xuống dòng",
                                    }),
                                    e.jsx("option", {
                                      value: "blankline",
                                      children: "Dòng trống",
                                    }),
                                    e.jsx("option", {
                                      value: "separator",
                                      children: "=====",
                                    }),
                                    e.jsx("option", {
                                      value: "custom",
                                      children: "Tùy chỉnh",
                                    }),
                                  ],
                                }),
                                N === "custom" &&
                                  e.jsx("input", {
                                    type: "text",
                                    value: k,
                                    onChange: (E) => j(E.target.value),
                                    className:
                                      "text-[10px] w-16 bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border-0 focus:ring-1 focus:ring-indigo-400",
                                    placeholder: "|||",
                                  }),
                                e.jsxs("span", {
                                  className:
                                    "text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full",
                                  children: [
                                    (() => {
                                      let E;
                                      switch (N) {
                                        case "newline":
                                          E = /\n/;
                                          break;
                                        case "blankline":
                                          E = /\n\s*\n/;
                                          break;
                                        case "separator":
                                          E = /\n=====\n|=====/;
                                          break;
                                        case "custom":
                                          E =
                                            k ||
                                            `
`;
                                          break;
                                        default:
                                          E = /\n/;
                                      }
                                      return v.split(E).filter((D) => D.trim())
                                        .length;
                                    })(),
                                    " ",
                                    "jobs",
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                        A === "COMPONENTS" &&
                          Yt.size > 0 &&
                          e.jsxs("div", {
                            className:
                              "flex flex-wrap gap-1 mb-1.5 flex-shrink-0",
                            children: [
                              e.jsx("span", {
                                className:
                                  "text-[10px] text-slate-400 self-center",
                                children: "📎 Chèn:",
                              }),
                              it
                                .filter(
                                  (E) =>
                                    E.name && !ul.has(E.name.toLowerCase()),
                                )
                                .map((E) =>
                                  e.jsxs(
                                    "button",
                                    {
                                      type: "button",
                                      onClick: () => F0(E.name),
                                      className:
                                        "text-[10px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 rounded px-1.5 py-0.5 hover:bg-indigo-100",
                                      title: `Chèn @${E.name} vào vị trí con trỏ`,
                                      children: ["@", E.name],
                                    },
                                    E.name,
                                  ),
                                ),
                            ],
                          }),
                        e.jsxs("div", {
                          className:
                            "mb-2 flex items-center justify-between gap-2 rounded border border-teal-200 bg-teal-50/70 px-2.5 py-1.5 text-xs",
                          children: [
                            e.jsx("span", {
                              className: "font-medium text-teal-800 truncate",
                              children: "Truyện tranh / Manga Nhật 60+ (5 góc + cảnh)",
                            }),
                            e.jsx("button", {
                              type: "button",
                              className: "manga-trigger-btn",
                              style: { padding: "3px 9px", fontSize: "11px" },
                              onClick: () =>
                                window.dispatchEvent(
                                  new CustomEvent("manga-story-open"),
                                ),
                              children: "Mở cấu hình Manga 60+",
                            }),
                          ],
                        }),
                        e.jsx(StoryCapcutSync,{key:t,projectId:t,disabled:xt||ar||Qr>0}),
                        e.jsx(InlineStoryPrompts,{projectId:t,outputDir:V,disabled:xt||ar||Qr>0,onFill:(result,folder)=>{w(result.prompts.join('\n=====\n'));C('separator');T('IMAGE_GENERATION');vs(zn);bs(result.images.map(image=>({...image,preview:Lr(image.preview)})));q(folder);}}),
                        e.jsx(Ir, {
                          ref: Dc,
                          value: v,
                          onChange: (E) => w(E),
                          onSelect: (E) => {
                            const D = E.target;
                            go.current = {
                              start: D.selectionStart,
                              end: D.selectionEnd,
                            };
                          },
                          className:
                            "flex-1 w-full border-none p-0 text-sm resize-none focus:ring-0 leading-relaxed custom-scrollbar",
                          placeholder:
                            N === "newline"
                              ? "Nhập prompts, mỗi dòng là 1 job..."
                              : N === "blankline"
                                ? `Nhập prompts,
phân tách bằng dòng trống...

Prompt 2 ở đây...`
                                : N === "separator"
                                  ? `Prompt 1
=====
Prompt 2
=====
Prompt 3`
                                  : `Prompt 1
${k}
Prompt 2
${k}
Prompt 3`,
                          style: { minHeight: "100px" },
                        }),
                      ],
                    }),
                    A === "IMAGE_GENERATION" &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-3 flex-shrink-0 animate-in slide-in-from-top-2",
                        children: [
                          e.jsxs("div", {
                            className: "flex items-center justify-between mb-2",
                            children: [
                              e.jsxs("label", {
                                className:
                                  "block text-xs font-medium text-slate-700",
                                children: [
                                  "Ảnh tham chiếu (",
                                  zn.length,
                                  "/",
                                  ur,
                                  ")",
                                ],
                              }),
                              e.jsx("button", {
                                onClick: () => ho(),
                                disabled: zn.length >= ur || Un.size > 0,
                                className:
                                  "text-[10px] font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition-colors disabled:opacity-50",
                                children: "+ Thêm ảnh",
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className:
                              "flex gap-2 overflow-x-auto pb-1 custom-scrollbar",
                            children: [
                              zn.map((E, D) =>
                                e.jsx(
                                  "div",
                                  {
                                    className: "relative flex-shrink-0 group",
                                    children: e.jsxs("div", {
                                      className:
                                        "w-16 h-16 bg-slate-100 border border-slate-200 rounded overflow-hidden flex items-center justify-center relative",
                                      children: [
                                        E.preview
                                          ? e.jsx("img", {
                                              src: E.preview,
                                              className:
                                                "w-full h-full object-cover",
                                              alt: "",
                                            })
                                          : e.jsx("span", {
                                              className:
                                                "text-[9px] text-slate-400",
                                              children: "Loading...",
                                            }),
                                        !Un.has(D) &&
                                          e.jsx("button", {
                                            onClick: () => ct(D),
                                            className:
                                              "absolute top-0.5 right-0.5 bg-black/50 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
                                            children: e.jsx(tt, {
                                              className: "h-3 w-3",
                                            }),
                                          }),
                                      ],
                                    }),
                                  },
                                  D,
                                ),
                              ),
                              zn.length === 0 &&
                                e.jsx("div", {
                                  onClick: ho,
                                  className:
                                    "w-16 h-16 border-2 border-dashed border-slate-200 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 text-slate-300 hover:text-indigo-500 transition-colors",
                                  children: e.jsx("span", {
                                    className: "text-[10px]",
                                    children: "+",
                                  }),
                                }),
                            ],
                          }),
                        ],
                      }),
                    A === "IMAGE_GENERATION_BATCH_REFS" &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-3 flex-shrink-0 space-y-3 animate-in slide-in-from-top-2",
                        children: [
                          e.jsxs("div", {
                            className: "grid grid-cols-2 gap-3",
                            children: [
                              e.jsxs("div", {
                                className:
                                  "border border-slate-200 rounded-md p-2.5 bg-slate-50/50",
                                children: [
                                  e.jsxs("div", {
                                    className:
                                      "flex items-center justify-between mb-1.5",
                                    children: [
                                      e.jsxs("label", {
                                        className:
                                          "text-xs font-medium text-slate-700",
                                        children: [
                                          "Ảnh fix cứng (",
                                          Rn.length,
                                          "/",
                                          ns,
                                          ")",
                                          e.jsx("span", {
                                            className:
                                              "text-[10px] text-slate-400 font-normal ml-1",
                                            children: "· chung mọi job",
                                          }),
                                        ],
                                      }),
                                      e.jsx("button", {
                                        onClick: ra,
                                        disabled:
                                          Rn.length >= ns || Zn.size > 0,
                                        className:
                                          "text-[10px] font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded transition-colors disabled:opacity-50",
                                        children: "+ Thêm",
                                      }),
                                    ],
                                  }),
                                  e.jsxs("div", {
                                    className:
                                      "flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar min-h-[64px]",
                                    children: [
                                      Rn.map((E, D) =>
                                        e.jsx(
                                          "div",
                                          {
                                            className:
                                              "relative flex-shrink-0 group",
                                            children: e.jsxs("div", {
                                              className:
                                                "w-14 h-14 bg-slate-100 border border-slate-200 rounded overflow-hidden flex items-center justify-center relative",
                                              children: [
                                                E.preview
                                                  ? e.jsx("img", {
                                                      src: E.preview,
                                                      className:
                                                        "w-full h-full object-cover",
                                                      alt: "",
                                                    })
                                                  : e.jsx("span", {
                                                      className:
                                                        "text-[9px] text-slate-400",
                                                      children: "…",
                                                    }),
                                                Zn.has(D) &&
                                                  e.jsx("div", {
                                                    className:
                                                      "absolute inset-0 bg-indigo-500/80 flex items-center justify-center",
                                                    children: e.jsxs("svg", {
                                                      className:
                                                        "animate-spin h-4 w-4 text-white",
                                                      viewBox: "0 0 24 24",
                                                      children: [
                                                        e.jsx("circle", {
                                                          className:
                                                            "opacity-25",
                                                          cx: "12",
                                                          cy: "12",
                                                          r: "10",
                                                          stroke:
                                                            "currentColor",
                                                          strokeWidth: "4",
                                                          fill: "none",
                                                        }),
                                                        e.jsx("path", {
                                                          className:
                                                            "opacity-75",
                                                          fill: "currentColor",
                                                          d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z",
                                                        }),
                                                      ],
                                                    }),
                                                  }),
                                                !Zn.has(D) &&
                                                  e.jsx("button", {
                                                    onClick: () => yu(D),
                                                    className:
                                                      "absolute top-0.5 right-0.5 bg-black/50 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
                                                    children: e.jsx(tt, {
                                                      className: "h-3 w-3",
                                                    }),
                                                  }),
                                              ],
                                            }),
                                          },
                                          D,
                                        ),
                                      ),
                                      Rn.length === 0 &&
                                        e.jsx("div", {
                                          onClick: ra,
                                          className:
                                            "w-14 h-14 border-2 border-dashed border-slate-200 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 text-slate-300 hover:text-indigo-500 transition-colors",
                                          children: e.jsx("span", {
                                            className: "text-[10px]",
                                            children: "+",
                                          }),
                                        }),
                                    ],
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className:
                                  "border border-indigo-200 rounded-md p-2.5 bg-indigo-50/30",
                                children: [
                                  e.jsxs("div", {
                                    className:
                                      "flex items-center justify-between mb-1.5",
                                    children: [
                                      e.jsxs("label", {
                                        className:
                                          "text-xs font-medium text-slate-700",
                                        children: [
                                          "Ảnh động (",
                                          fn.length,
                                          ")",
                                          e.jsxs("span", {
                                            className:
                                              "text-[10px] text-indigo-600 font-normal ml-1",
                                            children: ["· ", fn.length, " job"],
                                          }),
                                        ],
                                      }),
                                      e.jsx("button", {
                                        onClick: Rc,
                                        disabled: Pt.size > 0,
                                        className:
                                          "text-[10px] font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-2 py-0.5 rounded transition-colors disabled:opacity-50",
                                        children: "+ Thêm nhiều",
                                      }),
                                    ],
                                  }),
                                  e.jsxs("div", {
                                    className:
                                      "flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar min-h-[64px]",
                                    children: [
                                      fn.map((E, D) =>
                                        e.jsx(
                                          "div",
                                          {
                                            className:
                                              "relative flex-shrink-0 group",
                                            children: e.jsxs("div", {
                                              className:
                                                "w-14 h-14 bg-slate-100 border border-indigo-200 rounded overflow-hidden flex items-center justify-center relative",
                                              children: [
                                                E.preview
                                                  ? e.jsx("img", {
                                                      src: E.preview,
                                                      className:
                                                        "w-full h-full object-cover",
                                                      alt: "",
                                                    })
                                                  : e.jsx("span", {
                                                      className:
                                                        "text-[9px] text-slate-400",
                                                      children: "…",
                                                    }),
                                                Pt.has(D) &&
                                                  e.jsx("div", {
                                                    className:
                                                      "absolute inset-0 bg-indigo-500/80 flex items-center justify-center",
                                                    children: e.jsxs("svg", {
                                                      className:
                                                        "animate-spin h-4 w-4 text-white",
                                                      viewBox: "0 0 24 24",
                                                      children: [
                                                        e.jsx("circle", {
                                                          className:
                                                            "opacity-25",
                                                          cx: "12",
                                                          cy: "12",
                                                          r: "10",
                                                          stroke:
                                                            "currentColor",
                                                          strokeWidth: "4",
                                                          fill: "none",
                                                        }),
                                                        e.jsx("path", {
                                                          className:
                                                            "opacity-75",
                                                          fill: "currentColor",
                                                          d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z",
                                                        }),
                                                      ],
                                                    }),
                                                  }),
                                                e.jsxs("span", {
                                                  className:
                                                    "absolute bottom-0.5 left-0.5 text-[8px] bg-indigo-600 text-white px-0.5 rounded font-mono",
                                                  children: ["#", D + 1],
                                                }),
                                                !Pt.has(D) &&
                                                  e.jsx("button", {
                                                    onClick: () => ol(D),
                                                    className:
                                                      "absolute top-0.5 right-0.5 bg-black/50 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
                                                    children: e.jsx(tt, {
                                                      className: "h-3 w-3",
                                                    }),
                                                  }),
                                              ],
                                            }),
                                          },
                                          D,
                                        ),
                                      ),
                                      fn.length === 0 &&
                                        e.jsx("div", {
                                          onClick: Rc,
                                          className:
                                            "w-14 h-14 border-2 border-dashed border-indigo-200 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 text-indigo-300 hover:text-indigo-500 transition-colors",
                                          children: e.jsx("span", {
                                            className: "text-[10px]",
                                            children: "+",
                                          }),
                                        }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className:
                              "flex items-center gap-3 pt-1.5 border-t border-slate-100",
                            children: [
                              e.jsx("span", {
                                className:
                                  "text-[11px] font-medium text-slate-600 uppercase tracking-wider",
                                children: "Prompt:",
                              }),
                              e.jsxs("label", {
                                className:
                                  "flex items-center gap-1 cursor-pointer",
                                children: [
                                  e.jsx("input", {
                                    type: "radio",
                                    name: "batchRefsPromptMode",
                                    checked: Ka === "ALL",
                                    onChange: () => Is("ALL"),
                                    className: "w-3 h-3 accent-indigo-600",
                                  }),
                                  e.jsx("span", {
                                    className: "text-[11px] text-slate-700",
                                    children: "1 prompt cho tất cả",
                                  }),
                                ],
                              }),
                              e.jsxs("label", {
                                className:
                                  "flex items-center gap-1 cursor-pointer",
                                children: [
                                  e.jsx("input", {
                                    type: "radio",
                                    name: "batchRefsPromptMode",
                                    checked: Ka === "PER_LINE",
                                    onChange: () => Is("PER_LINE"),
                                    className: "w-3 h-3 accent-indigo-600",
                                  }),
                                  e.jsxs("span", {
                                    className: "text-[11px] text-slate-700",
                                    children: [
                                      "Mỗi dòng 1 prompt",
                                      Ka === "PER_LINE" &&
                                        fn.length > 0 &&
                                        e.jsxs("span", {
                                          className:
                                            "ml-1 text-indigo-600 font-medium",
                                          children: [
                                            "(cần ",
                                            fn.length,
                                            " dòng)",
                                          ],
                                        }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    A === "COMPONENTS_AUDIO" &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-3 flex-shrink-0 space-y-3 animate-in slide-in-from-top-2",
                        children: [
                          e.jsxs("div", {
                            children: [
                              e.jsxs("div", {
                                className:
                                  "flex items-center justify-between mb-1.5",
                                children: [
                                  e.jsxs("label", {
                                    className:
                                      "text-xs font-medium text-slate-700",
                                    children: [
                                      "Reference images (",
                                      Math.min(it.length, rn),
                                      "/",
                                      rn,
                                      ")",
                                    ],
                                  }),
                                  e.jsx("button", {
                                    onClick: () => cl(),
                                    disabled: Bn.size > 0 || it.length >= 10,
                                    className:
                                      "text-[10px] font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded transition-colors disabled:opacity-50",
                                    children: "+ Thêm ảnh",
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className:
                                  "flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar",
                                children: [
                                  it.map((E, D) =>
                                    e.jsx(
                                      "div",
                                      {
                                        className:
                                          "relative flex-shrink-0 group",
                                        children: e.jsxs("div", {
                                          className: `w-14 h-14 bg-slate-100 border rounded overflow-hidden flex items-center justify-center relative ${D < 3 ? "border-indigo-300" : "border-slate-200 opacity-50"}`,
                                          children: [
                                            E.preview &&
                                              e.jsx("img", {
                                                src: E.preview,
                                                className:
                                                  "w-full h-full object-cover",
                                                alt: "",
                                              }),
                                            Bn.has(D) &&
                                              e.jsx("div", {
                                                className:
                                                  "absolute inset-0 bg-indigo-500/80 flex items-center justify-center",
                                                children: e.jsxs("svg", {
                                                  className:
                                                    "animate-spin h-4 w-4 text-white",
                                                  viewBox: "0 0 24 24",
                                                  children: [
                                                    e.jsx("circle", {
                                                      className: "opacity-25",
                                                      cx: "12",
                                                      cy: "12",
                                                      r: "10",
                                                      stroke: "currentColor",
                                                      strokeWidth: "4",
                                                      fill: "none",
                                                    }),
                                                    e.jsx("path", {
                                                      className: "opacity-75",
                                                      fill: "currentColor",
                                                      d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z",
                                                    }),
                                                  ],
                                                }),
                                              }),
                                            !Bn.has(D) &&
                                              e.jsx("button", {
                                                onClick: () => fo(D),
                                                className:
                                                  "absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                                title: "Xóa ảnh",
                                                children: e.jsx(tt, {
                                                  className: "h-2.5 w-2.5",
                                                }),
                                              }),
                                          ],
                                        }),
                                      },
                                      D,
                                    ),
                                  ),
                                  it.length === 0 &&
                                    e.jsx("div", {
                                      onClick: () => cl(),
                                      className:
                                        "w-14 h-14 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 flex-shrink-0",
                                      children: e.jsx("span", {
                                        className: "text-[10px] text-slate-400",
                                        children: "+",
                                      }),
                                    }),
                                ],
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className: "border-t border-slate-100 pt-2.5",
                            children: [
                              e.jsxs("div", {
                                className:
                                  "flex items-center justify-between mb-1.5",
                                children: [
                                  e.jsxs("label", {
                                    className:
                                      "text-xs font-medium text-slate-700",
                                    children: [
                                      "Giọng đọc (đồng nhất tone)",
                                      Na.length > 0 &&
                                        e.jsxs("span", {
                                          className:
                                            "text-[10px] text-slate-400 font-normal ml-1",
                                          children: ["· ", Na.length, " giọng"],
                                        }),
                                    ],
                                  }),
                                  Zs &&
                                    e.jsx("button", {
                                      onClick: () => zl(),
                                      className:
                                        "text-[10px] text-red-600 hover:text-red-700 font-medium",
                                      children: "↻ Thử lại",
                                    }),
                                ],
                              }),
                              qa &&
                                e.jsx("div", {
                                  className:
                                    "text-[11px] text-slate-500 italic",
                                  children: "Đang tải danh sách giọng từ Flow…",
                                }),
                              Zs &&
                                !qa &&
                                e.jsx("div", {
                                  className:
                                    "text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5",
                                  children: Zs,
                                }),
                              !qa &&
                                !Zs &&
                                Na.length > 0 &&
                                e.jsxs("div", {
                                  className: "flex items-center gap-2",
                                  children: [
                                    e.jsxs("select", {
                                      value: _n,
                                      onChange: (E) => In(E.target.value),
                                      className:
                                        "flex-1 min-w-0 text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400",
                                      children: [
                                        e.jsx("option", {
                                          value: "",
                                          children: "— Chọn giọng —",
                                        }),
                                        Na.map((E) =>
                                          e.jsxs(
                                            "option",
                                            {
                                              value: E.mediaId,
                                              children: [
                                                E.displayName,
                                                " — ",
                                                E.description,
                                              ],
                                            },
                                            E.mediaId,
                                          ),
                                        ),
                                      ],
                                    }),
                                    e.jsx("button", {
                                      onClick: () => {
                                        const E = Na.find(
                                          (K) => K.mediaId === _n,
                                        );
                                        if (!E) return;
                                        qr.current && qr.current.pause();
                                        const D = new Audio(E.audioSamplePath);
                                        (qr.current = D),
                                          D.play().catch((K) =>
                                            console.warn(
                                              "Voice preview play failed:",
                                              K,
                                            ),
                                          );
                                      },
                                      disabled: !_n,
                                      className:
                                        "text-[11px] font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 whitespace-nowrap",
                                      title: "Phát thử giọng đã chọn",
                                      children: "▶ Nghe thử",
                                    }),
                                  ],
                                }),
                              e.jsx("p", {
                                className:
                                  "mt-1.5 text-[10px] leading-snug text-slate-400",
                                children:
                                  "Giọng chỉ quyết định chất giọng — lời thoại vẫn phải viết trong prompt.",
                              }),
                            ],
                          }),
                        ],
                      }),
                    A === "COMPONENTS" &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-3 flex-shrink-0 space-y-2.5",
                        children: [
                          e.jsxs("div", {
                            className:
                              "flex items-center justify-between gap-2",
                            children: [
                              e.jsxs("div", {
                                className: "flex items-center gap-2 min-w-0",
                                children: [
                                  e.jsxs("label", {
                                    className:
                                      "text-xs font-medium text-slate-700 whitespace-nowrap",
                                    children: [
                                      "Thư viện ảnh (",
                                      it.length,
                                      "/",
                                      ss,
                                      ")",
                                    ],
                                  }),
                                  e.jsx("span", {
                                    role: "status",
                                    "aria-live": "polite",
                                    title: Ns
                                      ? `Mỗi prompt dùng đúng ảnh nó gọi tên, tối đa ${rn} ảnh.`
                                      : `Chưa có @tên trong prompt — ${rn} ảnh đầu áp cho mọi prompt.`,
                                    className: `text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${Ns ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-slate-50 text-slate-500 border-slate-200"}`,
                                    children: Ns
                                      ? "🔗 Ghép theo @tên"
                                      : `📋 ${rn} ảnh đầu · tất cả`,
                                  }),
                                ],
                              }),
                              it.length < ss &&
                                e.jsx("button", {
                                  onClick: () => cl(),
                                  disabled: Bn.size > 0,
                                  className:
                                    "text-xs text-indigo-600 hover:text-indigo-700 px-2 py-1 rounded hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
                                  children: "+ Thêm ảnh",
                                }),
                            ],
                          }),
                          it.length === 0
                            ? e.jsx("div", {
                                onClick: () => cl(),
                                className:
                                  "h-16 bg-slate-50 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400",
                                children: e.jsx("span", {
                                  className: "text-[11px] text-slate-400",
                                  children: "+ Thêm ảnh tham chiếu",
                                }),
                              })
                            : e.jsx("div", {
                                role: "list",
                                "aria-label": `Thư viện ảnh tham chiếu — ${it.length} ảnh`,
                                className: "grid grid-cols-5 gap-2",
                                children: it.map((E, D) => {
                                  const K = Bn.has(D),
                                    ee =
                                      !!E.name && ul.has(E.name.toLowerCase());
                                  return e.jsxs(
                                    "div",
                                    {
                                      role: "listitem",
                                      className: "flex flex-col gap-1",
                                      children: [
                                        e.jsxs("div", {
                                          className: "relative",
                                          children: [
                                            e.jsxs("div", {
                                              className:
                                                "w-full aspect-square bg-slate-100 border border-slate-300 rounded overflow-hidden flex items-center justify-center",
                                              children: [
                                                E.preview &&
                                                  !K &&
                                                  e.jsx("img", {
                                                    src: E.preview,
                                                    alt:
                                                      E.name || `Ảnh ${D + 1}`,
                                                    className:
                                                      "w-full h-full object-cover",
                                                    onError: (te) => {
                                                      te.target.style.display =
                                                        "none";
                                                    },
                                                  }),
                                                K &&
                                                  e.jsxs("div", {
                                                    className:
                                                      "absolute inset-0 bg-indigo-500 bg-opacity-90 flex flex-col items-center justify-center z-[100] pointer-events-none",
                                                    children: [
                                                      e.jsxs("svg", {
                                                        className:
                                                          "motion-safe:animate-spin h-4 w-4 text-white mb-0.5",
                                                        viewBox: "0 0 24 24",
                                                        "aria-hidden": "true",
                                                        children: [
                                                          e.jsx("circle", {
                                                            className:
                                                              "opacity-25",
                                                            cx: "12",
                                                            cy: "12",
                                                            r: "10",
                                                            stroke:
                                                              "currentColor",
                                                            strokeWidth: "4",
                                                            fill: "none",
                                                          }),
                                                          e.jsx("path", {
                                                            className:
                                                              "opacity-75",
                                                            fill: "currentColor",
                                                            d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                                          }),
                                                        ],
                                                      }),
                                                      e.jsx("span", {
                                                        className:
                                                          "text-[8px] text-white font-medium",
                                                        children: "Đang tải",
                                                      }),
                                                    ],
                                                  }),
                                                !K &&
                                                  !E.preview &&
                                                  e.jsx("span", {
                                                    className:
                                                      "text-[10px] text-slate-400",
                                                    children: D + 1,
                                                  }),
                                              ],
                                            }),
                                            Bn.size === 0 &&
                                              e.jsx("button", {
                                                onClick: () => fo(D),
                                                className:
                                                  "absolute -top-2 -right-2 p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                                "aria-label": `Xóa ảnh ${E.name || D + 1}`,
                                                title: "Xóa ảnh",
                                                children: e.jsx(tt, {
                                                  className: "h-2.5 w-2.5",
                                                }),
                                              }),
                                          ],
                                        }),
                                        e.jsx("input", {
                                          type: "text",
                                          value: cc[D] ?? E.name,
                                          "aria-label": `Tên @handle cho ảnh ${D + 1}`,
                                          "aria-invalid": ee,
                                          title: `Dùng @${E.name} trong prompt`,
                                          onChange: (te) =>
                                            Ga((le) => ({
                                              ...le,
                                              [D]: te.target.value,
                                            })),
                                          onBlur: (te) =>
                                            wu(D, te.target.value),
                                          onKeyDown: (te) => {
                                            (te.key === "Enter" ||
                                              te.key === "Escape") &&
                                              te.target.blur();
                                          },
                                          className: `w-full text-[10px] font-mono text-center border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 ${ee ? "border-red-400 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-700"}`,
                                        }),
                                        ee &&
                                          e.jsx("span", {
                                            role: "alert",
                                            className:
                                              "text-[9px] text-red-500 text-center leading-tight",
                                            children: "Tên trùng",
                                          }),
                                      ],
                                    },
                                    E.uid,
                                  );
                                }),
                              }),
                          e.jsx("p", {
                            className:
                              "text-[10px] text-slate-500 leading-relaxed",
                            children: Ns
                              ? e.jsxs(e.Fragment, {
                                  children: [
                                    "Mỗi prompt dùng đúng ảnh nó gọi bằng ",
                                    e.jsx("code", { children: "@tên" }),
                                    ", tối đa ",
                                    rn,
                                    " ảnh/prompt.",
                                  ],
                                })
                              : e.jsxs(e.Fragment, {
                                  children: [
                                    Fn ? "⚡ Omni Flash dùng" : "Đang dùng",
                                    " ",
                                    rn,
                                    " ảnh đầu cho mọi prompt. Thêm",
                                    " ",
                                    e.jsx("code", { children: "@tên" }),
                                    " vào prompt để ghép ảnh riêng từng cảnh.",
                                  ],
                                }),
                          }),
                          ul.size > 0 &&
                            e.jsxs("div", {
                              role: "alert",
                              className:
                                "text-[11px] px-2 py-1.5 rounded border text-red-700 bg-red-50 border-red-200",
                              children: [
                                "✗ Tên bị trùng:",
                                " ",
                                [...ul].map((E) => `@${E}`).join(", "),
                                " ",
                                "— đổi tên để mỗi ảnh là duy nhất.",
                              ],
                            }),
                          Ns &&
                            pn.total > 0 &&
                            e.jsx("div", {
                              role: "status",
                              "aria-live": "polite",
                              className: `text-[11px] px-2 py-1.5 rounded border ${pn.errorRows > 0 ? "text-red-700 bg-red-50 border-red-200" : pn.warnRows > 0 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-green-700 bg-green-50 border-green-200"}`,
                              children:
                                pn.errorRows > 0
                                  ? `✗ ${pn.errorRows}/${pn.total} prompt lỗi${
                                      pn.unknownHandles.length > 0
                                        ? ` — không có ảnh tên ${pn.unknownHandles
                                            .slice(0, 3)
                                            .map((E) => `@${E}`)
                                            .join(", ")}`
                                        : ""
                                    }${pn.overflowRows > 0 ? ` — ${pn.overflowRows} prompt gọi quá ${rn} ảnh` : ""}`
                                  : pn.warnRows > 0
                                    ? `⚠ ${pn.warnRows}/${pn.total} prompt không có @tên — sẽ dùng ${rn} ảnh đầu`
                                    : `✓ ${pn.total} prompt đã ghép đủ ảnh`,
                            }),
                          Ns &&
                            pn.total > 0 &&
                            e.jsxs("div", {
                              children: [
                                e.jsxs("div", {
                                  className:
                                    "flex items-center justify-between mb-1",
                                  children: [
                                    e.jsx("span", {
                                      className:
                                        "text-[10px] font-medium text-slate-600",
                                      children: "Preview ghép ảnh",
                                    }),
                                    e.jsx("button", {
                                      onClick: () => ui((E) => !E),
                                      className:
                                        "text-[10px] text-indigo-600 hover:text-indigo-700",
                                      children: hr
                                        ? "Chỉ hiện lỗi"
                                        : `Xem tất cả ${pn.total}`,
                                    }),
                                  ],
                                }),
                                hi.length === 0 &&
                                  e.jsx("p", {
                                    className:
                                      "text-[10px] text-slate-400 italic py-1",
                                    children: "Không có dòng nào lỗi.",
                                  }),
                                e.jsx("div", {
                                  ref: mr,
                                  className:
                                    "max-h-32 overflow-y-auto custom-scrollbar",
                                  children: e.jsx("div", {
                                    style: {
                                      height: `${fr.getTotalSize()}px`,
                                      position: "relative",
                                    },
                                    children: fr.getVirtualItems().map((E) => {
                                      const D = hi[E.index];
                                      return D
                                        ? e.jsxs(
                                            "div",
                                            {
                                              style: {
                                                position: "absolute",
                                                top: 0,
                                                left: 0,
                                                width: "100%",
                                                transform: `translateY(${E.start}px)`,
                                              },
                                              className:
                                                "flex items-start gap-1.5 py-1 pr-1",
                                              children: [
                                                e.jsxs("span", {
                                                  className:
                                                    "text-[10px] text-slate-400 w-7 text-right flex-shrink-0 tabular-nums",
                                                  children: ["#", D.idx + 1],
                                                }),
                                                e.jsx("span", {
                                                  "aria-hidden": "true",
                                                  className: `text-[10px] flex-shrink-0 ${D.status === "ok" ? "text-green-500" : D.status === "warn" ? "text-amber-500" : "text-red-500"}`,
                                                  children:
                                                    D.status === "ok"
                                                      ? "✓"
                                                      : D.status === "warn"
                                                        ? "⚠"
                                                        : "✗",
                                                }),
                                                e.jsxs("div", {
                                                  className:
                                                    "flex gap-0.5 flex-shrink-0",
                                                  children: [
                                                    D.resolved.map((K) =>
                                                      e.jsx(
                                                        "div",
                                                        {
                                                          title: `@${K.name}`,
                                                          className:
                                                            "w-5 h-5 rounded overflow-hidden border border-green-300 bg-slate-50",
                                                          children:
                                                            K.preview &&
                                                            e.jsx("img", {
                                                              src: K.preview,
                                                              alt: "",
                                                              className:
                                                                "w-full h-full object-cover",
                                                            }),
                                                        },
                                                        K.name,
                                                      ),
                                                    ),
                                                    D.unknown.map((K) =>
                                                      e.jsx(
                                                        "div",
                                                        {
                                                          title: `@${K} không tồn tại`,
                                                          className:
                                                            "w-5 h-5 rounded border border-red-300 bg-red-50 flex items-center justify-center",
                                                          children: e.jsx(
                                                            "span",
                                                            {
                                                              className:
                                                                "text-[8px] text-red-400",
                                                              children: "?",
                                                            },
                                                          ),
                                                        },
                                                        K,
                                                      ),
                                                    ),
                                                  ],
                                                }),
                                                e.jsxs("div", {
                                                  className: "flex-1 min-w-0",
                                                  children: [
                                                    e.jsx("p", {
                                                      className:
                                                        "text-[10px] text-slate-600 truncate",
                                                      title: D.text,
                                                      children: D.text,
                                                    }),
                                                    D.status !== "ok" &&
                                                      e.jsx("p", {
                                                        className: `text-[9px] leading-tight ${D.status === "warn" ? "text-amber-600" : "text-red-500"}`,
                                                        children:
                                                          D.unknown.length > 0
                                                            ? `${D.unknown.map((K) => `@${K}`).join(", ")} không tồn tại`
                                                            : D.overflow
                                                              ? `Gọi quá ${rn} ảnh`
                                                              : `Không có @tên — dùng ${rn} ảnh đầu`,
                                                      }),
                                                  ],
                                                }),
                                              ],
                                            },
                                            E.key,
                                          )
                                        : null;
                                    }),
                                  }),
                                }),
                              ],
                            }),
                        ],
                      }),
                    A === "IMAGE" &&
                      Vn &&
                      e.jsx("div", {
                        className:
                          "bg-amber-50 border border-amber-200 rounded-lg p-4 flex-shrink-0",
                        children: e.jsxs("div", {
                          className: "flex items-start gap-2",
                          children: [
                            e.jsx(Cd, {
                              className:
                                "h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5",
                            }),
                            e.jsxs("div", {
                              className: "flex-1",
                              children: [
                                e.jsxs("p", {
                                  className:
                                    "text-sm font-medium text-amber-900",
                                  children: [
                                    "Đã sử dụng ",
                                    Zd.length,
                                    " ảnh từ gen hình ảnh làm start frame",
                                  ],
                                }),
                                e.jsx("p", {
                                  className: "text-xs text-amber-700 mt-1",
                                  children:
                                    'Vui lòng nhập prompt (mỗi dòng = 1 prompt) và ấn "Auto Fill Prompt" để điền vào các job DRAFT.',
                                }),
                              ],
                            }),
                          ],
                        }),
                      }),
                    A === "IMAGE" &&
                      !Vn &&
                      e.jsxs("div", {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-4 space-y-4 flex-shrink-0",
                        children: [
                          e.jsxs("div", {
                            children: [
                              e.jsxs("div", {
                                className: "flex items-center gap-2 mb-1.5",
                                children: [
                                  e.jsx("label", {
                                    className:
                                      "text-xs font-medium text-slate-700",
                                    children: "Start Frame",
                                  }),
                                  e.jsx("span", {
                                    className:
                                      "text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded",
                                    children: Qs.length,
                                  }),
                                  e.jsx("span", {
                                    className: "text-slate-300 cursor-help",
                                    title:
                                      "Mỗi ảnh start frame tương ứng với 1 prompt (dòng). Ảnh chỉ được upload khi tạo job.",
                                    children: "ⓘ",
                                  }),
                                  e.jsx("button", {
                                    onClick: Aa,
                                    className:
                                      "ml-auto text-[10px] text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-1.5 py-0.5 rounded",
                                    children: "+ Thêm",
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className: "flex gap-1.5 overflow-x-auto pb-1",
                                children: [
                                  Qs.sort(
                                    (E, D) => E.jobIndex - D.jobIndex,
                                  ).map((E) =>
                                    e.jsxs(
                                      "div",
                                      {
                                        className: "relative flex-shrink-0",
                                        children: [
                                          e.jsx("div", {
                                            className:
                                              "w-14 h-14 bg-slate-100 border border-slate-300 rounded overflow-hidden",
                                            children: e.jsx("img", {
                                              src: E.preview,
                                              alt: `Start ${E.jobIndex}`,
                                              className:
                                                "w-full h-full object-cover",
                                            }),
                                          }),
                                          e.jsx("button", {
                                            onClick: () => la(E.jobIndex),
                                            className:
                                              "absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                            title: "Xóa",
                                            children: e.jsx(tt, {
                                              className: "h-2 w-2",
                                            }),
                                          }),
                                          e.jsxs("div", {
                                            className:
                                              "text-[8px] text-center text-slate-500 mt-0.5",
                                            children: ["#", E.jobIndex],
                                          }),
                                        ],
                                      },
                                      E.jobIndex,
                                    ),
                                  ),
                                  Qs.length === 0 &&
                                    e.jsx("div", {
                                      onClick: Aa,
                                      className:
                                        "w-14 h-14 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 flex-shrink-0",
                                      children: e.jsx("span", {
                                        className: "text-[10px] text-slate-400",
                                        children: "+",
                                      }),
                                    }),
                                ],
                              }),
                            ],
                          }),
                          !Fn &&
                            e.jsxs("div", {
                              children: [
                                e.jsxs("div", {
                                  className: "flex items-center gap-2 mb-1.5",
                                  children: [
                                    e.jsx("label", {
                                      className:
                                        "text-xs font-medium text-slate-700",
                                      children: "End Frame",
                                    }),
                                    e.jsx("span", {
                                      className:
                                        "text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded",
                                      children: Cn.length,
                                    }),
                                    e.jsx("span", {
                                      className: "text-slate-300 cursor-help",
                                      title:
                                        "End frame tùy chọn. Số lượng phải bằng start frame hoặc để trống hết.",
                                      children: "ⓘ",
                                    }),
                                    e.jsx("button", {
                                      onClick: Ra,
                                      className:
                                        "ml-auto text-[10px] text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-1.5 py-0.5 rounded",
                                      children: "+ Thêm",
                                    }),
                                  ],
                                }),
                                e.jsxs("div", {
                                  className:
                                    "flex gap-1.5 overflow-x-auto pb-1",
                                  children: [
                                    Cn.sort(
                                      (E, D) => E.jobIndex - D.jobIndex,
                                    ).map((E) =>
                                      e.jsxs(
                                        "div",
                                        {
                                          className: "relative flex-shrink-0",
                                          children: [
                                            e.jsx("div", {
                                              className:
                                                "w-14 h-14 bg-slate-100 border border-slate-300 rounded overflow-hidden",
                                              children: E.preview
                                                ? e.jsx("img", {
                                                    src: E.preview,
                                                    alt: `End ${E.jobIndex}`,
                                                    className:
                                                      "w-full h-full object-cover",
                                                  })
                                                : e.jsx("div", {
                                                    className:
                                                      "w-full h-full flex items-center justify-center",
                                                    children: e.jsx("span", {
                                                      className:
                                                        "text-[8px] text-slate-400",
                                                      children: "-",
                                                    }),
                                                  }),
                                            }),
                                            e.jsx("button", {
                                              onClick: () => Oc(E.jobIndex),
                                              className:
                                                "absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                              title: "Xóa",
                                              children: e.jsx(tt, {
                                                className: "h-2 w-2",
                                              }),
                                            }),
                                            e.jsxs("div", {
                                              className:
                                                "text-[8px] text-center text-slate-500 mt-0.5",
                                              children: ["#", E.jobIndex],
                                            }),
                                          ],
                                        },
                                        E.jobIndex,
                                      ),
                                    ),
                                    Cn.length === 0 &&
                                      e.jsx("div", {
                                        onClick: Ra,
                                        className:
                                          "w-14 h-14 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 flex-shrink-0",
                                        children: e.jsx("span", {
                                          className:
                                            "text-[10px] text-slate-400",
                                          children: "+",
                                        }),
                                      }),
                                  ],
                                }),
                              ],
                            }),
                        ],
                      }),
                    A === "REFERENCE_BATCH" &&
                      (() => {
                        const E = an.length,
                          D = an.reduce((xe, pe) => xe + pe.images.length, 0),
                          K = oa,
                          ee = an.some((xe) => xe.images.length === 0),
                          te = K > 0 && E === K && !ee,
                          le = E < K || ee,
                          fe = E > K;
                        return e.jsxs("div", {
                          className:
                            "bg-white rounded-lg border border-green-200 p-3 space-y-2 flex-shrink-0",
                          children: [
                            e.jsxs("div", {
                              className: "flex items-center gap-2",
                              children: [
                                e.jsx("span", {
                                  className:
                                    "text-xs font-medium text-slate-700",
                                  children: "🎞️ Ảnh Reference",
                                }),
                                e.jsxs("span", {
                                  className:
                                    "text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium",
                                  children: [E, " shot · ", D, " ảnh"],
                                }),
                                e.jsx("button", {
                                  type: "button",
                                  className:
                                    "text-slate-300 cursor-help text-xs leading-none rounded focus:outline-none focus:ring-1 focus:ring-slate-400",
                                  "aria-label":
                                    "Hướng dẫn: Mỗi shot = 1 prompt, đính kèm 1–3 ảnh reference. Excel: cột A = prompt, B = ảnh 1, C = ảnh 2 (tuỳ chọn), D = ảnh 3 (tuỳ chọn).",
                                  title:
                                    "Mỗi shot = 1 prompt, đính kèm 1–3 ảnh reference. Excel: cột A = prompt, B = ảnh 1, C = ảnh 2 (tuỳ chọn), D = ảnh 3 (tuỳ chọn).",
                                  children: "ⓘ",
                                }),
                                e.jsxs("div", {
                                  className:
                                    "ml-auto flex items-center gap-1.5",
                                  children: [
                                    e.jsx("button", {
                                      type: "button",
                                      onClick: dl,
                                      disabled: Gi,
                                      className:
                                        "text-[10px] text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 px-2 py-0.5 rounded font-medium border border-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed",
                                      title:
                                        "Import Excel: cột A = prompt, B/C/D = tối đa 3 ảnh",
                                      children: Gi
                                        ? `Đang import ${Xa.current}/${Xa.total}…`
                                        : "📥 Import Excel",
                                    }),
                                    e.jsx("button", {
                                      type: "button",
                                      onClick: Ma,
                                      disabled: Gi,
                                      className:
                                        "text-[10px] text-green-700 hover:text-green-800 hover:bg-green-50 px-2 py-0.5 rounded font-medium border border-green-200 disabled:opacity-50 disabled:cursor-not-allowed",
                                      title:
                                        "Thêm shot mới (mỗi ảnh chọn = 1 shot mới)",
                                      children: "+ Thêm shot",
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            K > 0 &&
                              e.jsxs("div", {
                                role: "alert",
                                "aria-live": "polite",
                                className: `text-xs px-2 py-1.5 rounded border ${te ? "text-green-700 bg-green-50 border-green-200" : le ? "text-red-600 bg-red-50 border-red-200" : "text-amber-700 bg-amber-50 border-amber-200"}`,
                                children: [
                                  te && `✓ Sẵn sàng — ${K} shot, ${D} ảnh`,
                                  le &&
                                    E === 0 &&
                                    `⚠️ Chưa có shot. Cần ${K} shot (1–3 ảnh/shot).`,
                                  le &&
                                    E > 0 &&
                                    ee &&
                                    "⚠️ Có shot chưa có ảnh — thêm ảnh hoặc xóa shot trống.",
                                  le &&
                                    E > 0 &&
                                    !ee &&
                                    E < K &&
                                    `⚠️ Thiếu ${K - E} shot — có ${E}/${K}.`,
                                  fe &&
                                    `⚠️ ${E - K} shot thừa — xóa bớt để còn ${K} shot.`,
                                ],
                              }),
                            K > 0 &&
                              e.jsxs("ul", {
                                role: "list",
                                "aria-label":
                                  "Danh sách shot — prompt và ảnh reference",
                                className:
                                  "space-y-1 max-h-56 overflow-y-auto pr-1 list-none",
                                children: [
                                  ci.map((xe, pe) => {
                                    const Oe =
                                        an.find(
                                          (Ue) => Ue.jobIndex === pe + 1,
                                        ) ?? null,
                                      $e = Oe?.images ?? [],
                                      Te = $e.length < Ph;
                                    return e.jsxs(
                                      "li",
                                      {
                                        className:
                                          "flex items-center gap-1.5 py-0.5",
                                        children: [
                                          e.jsxs("span", {
                                            className:
                                              "text-[10px] font-medium text-slate-400 w-6 text-right flex-shrink-0",
                                            children: ["#", pe + 1],
                                          }),
                                          e.jsxs("div", {
                                            className:
                                              "flex items-center gap-0.5 flex-shrink-0",
                                            role: "group",
                                            "aria-label": `Ảnh cho shot ${pe + 1}`,
                                            children: [
                                              $e.map((Ue) =>
                                                e.jsxs(
                                                  "div",
                                                  {
                                                    className:
                                                      "relative w-9 h-9 flex-shrink-0",
                                                    children: [
                                                      e.jsx("div", {
                                                        className:
                                                          "w-full h-full rounded overflow-hidden border border-green-300 bg-slate-50",
                                                        children: e.jsx("img", {
                                                          src: Ue.preview,
                                                          alt: `Reference ${pe + 1}-${Ue.slot + 1}`,
                                                          className:
                                                            "w-full h-full object-cover",
                                                        }),
                                                      }),
                                                      e.jsx("button", {
                                                        type: "button",
                                                        onClick: () =>
                                                          _c(pe + 1, Ue.slot),
                                                        className:
                                                          "absolute -top-1.5 -right-1.5 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                                        title: `Xóa ảnh ${Ue.slot + 1} của shot ${pe + 1}`,
                                                        "aria-label": `Xóa ảnh ${Ue.slot + 1} của shot ${pe + 1}`,
                                                        children: e.jsx(tt, {
                                                          className: "h-3 w-3",
                                                        }),
                                                      }),
                                                    ],
                                                  },
                                                  Ue.slot,
                                                ),
                                              ),
                                              Te &&
                                                e.jsx("button", {
                                                  type: "button",
                                                  onClick: () => ia(pe + 1),
                                                  className:
                                                    "w-9 h-9 bg-slate-50 border-2 border-dashed border-slate-300 rounded flex items-center justify-center hover:border-green-400 hover:bg-green-50 transition-colors flex-shrink-0",
                                                  title:
                                                    $e.length === 0
                                                      ? `Thêm ảnh cho shot ${pe + 1}`
                                                      : `Thêm ảnh thứ ${$e.length + 1}`,
                                                  "aria-label":
                                                    $e.length === 0
                                                      ? `Thêm ảnh cho shot ${pe + 1}`
                                                      : `Thêm ảnh thứ ${$e.length + 1} cho shot ${pe + 1}`,
                                                  children: e.jsx("span", {
                                                    className:
                                                      "text-slate-400 text-[10px] font-medium",
                                                    children: "＋",
                                                  }),
                                                }),
                                            ],
                                          }),
                                          e.jsx("span", {
                                            className: `text-[11px] flex-1 truncate min-w-0 ${$e.length > 0 ? "text-slate-600" : "text-slate-400 italic"}`,
                                            title: xe,
                                            children: xe.slice(0, 70),
                                          }),
                                          Oe &&
                                            e.jsx("button", {
                                              type: "button",
                                              onClick: () => xo(pe + 1),
                                              className:
                                                "p-1 text-slate-400 hover:text-red-500 flex-shrink-0 transition-colors ml-0.5",
                                              title: `Xóa toàn bộ shot ${pe + 1}`,
                                              "aria-label": `Xóa toàn bộ shot ${pe + 1}`,
                                              children: e.jsx(tt, {
                                                className: "h-3 w-3",
                                              }),
                                            }),
                                        ],
                                      },
                                      pe + 1,
                                    );
                                  }),
                                  an
                                    .filter((xe) => xe.jobIndex > K)
                                    .map((xe) =>
                                      e.jsxs(
                                        "li",
                                        {
                                          className:
                                            "flex items-center gap-1.5 opacity-60",
                                          children: [
                                            e.jsxs("span", {
                                              className:
                                                "text-[10px] text-amber-600 w-6 text-right flex-shrink-0",
                                              children: ["#", xe.jobIndex],
                                            }),
                                            e.jsx("div", {
                                              className:
                                                "flex items-center gap-0.5 flex-shrink-0",
                                              children: xe.images.map((pe) =>
                                                e.jsx(
                                                  "div",
                                                  {
                                                    className:
                                                      "w-9 h-9 rounded overflow-hidden flex-shrink-0 border border-amber-200",
                                                    children: e.jsx("img", {
                                                      src: pe.preview,
                                                      alt: `Ảnh reference thừa ${xe.jobIndex}-${pe.slot + 1}`,
                                                      className:
                                                        "w-full h-full object-cover",
                                                    }),
                                                  },
                                                  pe.slot,
                                                ),
                                              ),
                                            }),
                                            e.jsxs("span", {
                                              className:
                                                "text-[10px] text-amber-600 italic flex-1",
                                              children: [
                                                "Thừa — không có prompt #",
                                                xe.jobIndex,
                                              ],
                                            }),
                                            e.jsx("button", {
                                              type: "button",
                                              onClick: () => xo(xe.jobIndex),
                                              className:
                                                "p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 flex-shrink-0",
                                              title: `Xóa shot thừa #${xe.jobIndex}`,
                                              "aria-label": `Xóa shot thừa ${xe.jobIndex}`,
                                              children: e.jsx(tt, {
                                                className: "h-3 w-3",
                                              }),
                                            }),
                                          ],
                                        },
                                        xe.jobIndex,
                                      ),
                                    ),
                                ],
                              }),
                            K === 0 &&
                              E > 0 &&
                              e.jsxs("div", {
                                className: "text-[11px] text-slate-500",
                                children: [
                                  "Nhập prompt (mỗi dòng 1 prompt) để ghép với ",
                                  E,
                                  " shot đã chọn (",
                                  D,
                                  " ảnh).",
                                ],
                              }),
                          ],
                        });
                      })(),
                  ],
                }),
                e.jsxs("div", {
                  className:
                    "flex-shrink-0 bg-white p-3 border-t border-slate-200 rounded-b-lg",
                  children: [
                    l && l.profiles && l.profiles.length > 0 && !1,
                    e.jsx("button", {
                      onClick: lr,
                      disabled:
                        xt ||
                        ie ||
                        Js ||
                        !v.trim() ||
                        !1 ||
                        mi ||
                        (A === "REFERENCE_BATCH" &&
                          oa > 0 &&
                          (an.length !== oa ||
                            an.some((E) => E.images.length === 0))) ||
                        Xt ||
                        (Ns && pn.errorRows > 0),
                      className:
                        "w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                      title: mi
                        ? "Đang có job chờ xử lý, vui lòng đợi hoàn thành"
                        : "",
                      children:
                        xt || ie || Js
                          ? e.jsxs("span", {
                              className:
                                "flex items-center justify-center gap-2",
                              children: [
                                e.jsxs("svg", {
                                  className: "animate-spin h-4 w-4",
                                  viewBox: "0 0 24 24",
                                  children: [
                                    e.jsx("circle", {
                                      className: "opacity-25",
                                      cx: "12",
                                      cy: "12",
                                      r: "10",
                                      stroke: "currentColor",
                                      strokeWidth: "4",
                                      fill: "none",
                                    }),
                                    e.jsx("path", {
                                      className: "opacity-75",
                                      fill: "currentColor",
                                      d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                    }),
                                  ],
                                }),
                                ie || Js
                                  ? "Đang upload..."
                                  : Vn && Mt.length > 0
                                    ? "Đang điền prompt..."
                                    : "Đang tạo job...",
                              ],
                            })
                          : mi
                            ? e.jsxs("span", {
                                className:
                                  "flex items-center justify-center gap-2",
                                children: [
                                  e.jsxs("svg", {
                                    className: "animate-spin h-4 w-4",
                                    viewBox: "0 0 24 24",
                                    children: [
                                      e.jsx("circle", {
                                        className: "opacity-25",
                                        cx: "12",
                                        cy: "12",
                                        r: "10",
                                        stroke: "currentColor",
                                        strokeWidth: "4",
                                        fill: "none",
                                      }),
                                      e.jsx("path", {
                                        className: "opacity-75",
                                        fill: "currentColor",
                                        d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                      }),
                                    ],
                                  }),
                                  "Đang xử lý (",
                                  Yl.length + Xl.length,
                                  " jobs)",
                                ],
                              })
                            : Vn && Mt.length > 0
                              ? "Auto Fill Prompt"
                              : ar
                                ? `+ Thêm vào danh sách chờ (đang có ${Mt.length})`
                                : "Tạo job",
                    }),
                  ],
                }),
              ],
            }),
            (Mt.length > 0 || sr || bt.length > 0 || gn.length > 0) &&
              e.jsxs("div", {
                className: `${Mt.length > 0 ? "w-[300px]" : "w-[220px]"} flex-shrink-0 flex flex-col min-h-0 transition-[width] duration-200`,
                children: [
                  e.jsx("div", {
                    className:
                      "bg-white rounded-lg border border-slate-200 p-3 mb-2",
                    children: e.jsxs("div", {
                      className: "flex items-center justify-between gap-2",
                      children: [
                        e.jsx("h3", {
                          className:
                            "font-medium text-slate-900 text-sm truncate",
                          children:
                            Mt.length > 0
                              ? `📝 Chờ xử lý (${Mt.length})`
                              : `⏳ Chờ xử lý (${Xl.length + Yl.length})`,
                        }),
                        Mt.length > 0 &&
                          e.jsx("button", {
                            onClick: sl,
                            disabled: xt,
                            className:
                              "flex-shrink-0 text-[11px] font-medium text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
                            title: "Xóa tất cả job đang chờ xử lý",
                            children: "🗑 Xóa tất cả",
                          }),
                      ],
                    }),
                  }),
                  e.jsx("div", {
                    className:
                      "flex-1 bg-white rounded-lg border border-slate-200 overflow-auto min-h-0 flex flex-col",
                    children: e.jsx("div", {
                      className: "flex-1 overflow-auto",
                      children: e.jsx("div", {
                        className: "divide-y divide-slate-200",
                        children:
                          Mt.length === 0 && Xl.length === 0 && Yl.length === 0
                            ? e.jsx("div", {
                                className:
                                  "p-6 text-center text-slate-400 text-sm",
                                children: "Không có job nào đang chờ",
                              })
                            : e.jsxs(e.Fragment, {
                                children: [
                                  Mt.map((E) =>
                                    e.jsx(
                                      MangaDraftCard, /* MANGA_DRAFT_REFERENCES */
                                      {
                                        projectId: t,
                                        job: E,
                                        inputMethod: A,
                                        onUpdate: async (D) => {
                                          try {
                                            await Me.updateJob(E.id, D),
                                              await p();
                                          } catch (K) {
                                            console.error(
                                              "Failed to update job:",
                                              K,
                                            );
                                          }
                                        },
                                        onDelete: () => Jn(E.id),
                                      },
                                      E.id,
                                    ),
                                  ),
                                  Xl.map((E) =>
                                    e.jsx(
                                      C1,
                                      { job: E, onCancel: () => si(E.id) },
                                      E.id,
                                    ),
                                  ),
                                  Yl.map((E) =>
                                    e.jsx(
                                      C1,
                                      { job: E, onCancel: () => si(E.id) },
                                      E.id,
                                    ),
                                  ),
                                ],
                              }),
                      }),
                    }),
                  }),
                  Mt.length > 0 &&
                    e.jsx("div", {
                      className: "flex-shrink-0 mt-2",
                      children: e.jsx("button", {
                        onClick: uu,
                        disabled: xt,
                        className:
                          "w-full rounded-lg bg-green-600 px-3 py-3 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-lg",
                        children: xt
                          ? e.jsxs(e.Fragment, {
                              children: [
                                e.jsxs("svg", {
                                  className: "animate-spin h-4 w-4",
                                  viewBox: "0 0 24 24",
                                  children: [
                                    e.jsx("circle", {
                                      className: "opacity-25",
                                      cx: "12",
                                      cy: "12",
                                      r: "10",
                                      stroke: "currentColor",
                                      strokeWidth: "4",
                                      fill: "none",
                                    }),
                                    e.jsx("path", {
                                      className: "opacity-75",
                                      fill: "currentColor",
                                      d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                    }),
                                  ],
                                }),
                                "Đang validate...",
                              ],
                            })
                          : e.jsxs(e.Fragment, {
                              children: [
                                e.jsx(ga, { className: "h-5 w-5" }),
                                "Bắt đầu gen (",
                                Mt.length,
                                " jobs)",
                              ],
                            }),
                      }),
                    }),
                ],
              }),
            e.jsxs("div", {
              className: "flex-1 flex flex-col min-h-0 min-w-[300px]",
              children: [
                e.jsxs("div", {
                  className:
                    "bg-white rounded-lg border border-slate-200 p-3 mb-2",
                  children: [
                    e.jsxs("div", {
                      className: "flex items-center justify-between mb-2 gap-4",
                      children: [
                        e.jsxs("h3", {
                          className:
                            "font-medium text-slate-900 text-sm whitespace-nowrap",
                          children: [
                            "✅ (",
                            bt.length,
                            ") / ❌ (",
                            gn.length,
                            ")",
                          ],
                        }),
                        e.jsxs("div", {
                          className:
                            "flex items-center gap-2 flex-1 justify-end min-w-0 max-w-[550px]",
                          children: [
                            e.jsxs("label", {
                              className:
                                "flex items-center gap-1.5 cursor-pointer select-none",
                              title: "Tự động tải file khi gen xong",
                              children: [
                                e.jsx("input", {
                                  type: "checkbox",
                                  checked: ta,
                                  onChange: async (E) => {
                                    const D = E.target.checked;
                                    Wr(D);
                                    try {
                                      await Me.updateProject(t, {
                                        autoDownload: D,
                                      });
                                    } catch (K) {
                                      console.error(
                                        "Failed to save autoDownload:",
                                        K,
                                      ),
                                        Wr(!D);
                                    }
                                  },
                                  className:
                                    "h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer",
                                }),
                                e.jsx("span", {
                                  className:
                                    "text-xs text-slate-600 font-medium whitespace-nowrap",
                                  children: "Tự động tải",
                                }),
                              ],
                            }),
                            e.jsxs("button", {
                              type: "button",
                              "aria-label": "Cài đặt tên file tải về",
                              "aria-expanded": Zr,
                              "aria-controls": "file-naming-panel",
                              onClick: () => {
                                const E = !Zr;
                                Jd(E),
                                  localStorage.setItem(
                                    "genNormal:fileNamingPanelOpen",
                                    String(E),
                                  );
                              },
                              title: "Cài đặt tên file tải về",
                              className:
                                "relative flex items-center justify-center h-6 w-6 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                              children: [
                                e.jsx(Xo, { className: "h-4 w-4" }),
                                Os !== Mr &&
                                  e.jsx("span", {
                                    className:
                                      "absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500",
                                  }),
                              ],
                            }),
                            e.jsxs("div", {
                              className:
                                "flex items-center gap-1.5 select-none",
                              children: [
                                e.jsxs("label", {
                                  className:
                                    "flex items-center gap-1.5 cursor-pointer",
                                  title:
                                    "Tự động upscale khi gen xong — lưu persistent, server sẽ tự upscale ngay cả khi tắt giao diện",
                                  children: [
                                    e.jsx("input", {
                                      type: "checkbox",
                                      checked: js,
                                      onChange: async (E) => {
                                        const D = E.target.checked;
                                        Fl(D);
                                        try {
                                          await Me.updateProject(t, {
                                            autoUpscaleVideo: D,
                                            autoUpscaleImage: D,
                                          }),
                                            c();
                                        } catch (K) {
                                          console.error(
                                            "Failed to save autoUpscale:",
                                            K,
                                          ),
                                            Fl(!D);
                                        }
                                      },
                                      className:
                                        "h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-600 cursor-pointer",
                                    }),
                                    e.jsx("span", {
                                      className:
                                        "text-xs text-slate-600 font-medium whitespace-nowrap",
                                      children: "Tự động upscale",
                                    }),
                                  ],
                                }),
                                js &&
                                  e.jsx("select", {
                                    value: Jr,
                                    onChange: async (E) => {
                                      const D = E.target.value;
                                      Sa(D);
                                      const K =
                                        A === "IMAGE_GENERATION" ||
                                        A === "IMAGE_GENERATION_BATCH_REFS";
                                      try {
                                        await Me.updateProject(
                                          t,
                                          K
                                            ? { imageUpscaleRes: D }
                                            : { videoUpscaleRes: D },
                                        );
                                      } catch (ee) {
                                        console.error(
                                          "Failed to save upscale resolution:",
                                          ee,
                                        );
                                      }
                                    },
                                    className:
                                      "text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200 focus:ring-1 focus:ring-emerald-400",
                                    children:
                                      A === "IMAGE_GENERATION" ||
                                      A === "IMAGE_GENERATION_BATCH_REFS"
                                        ? e.jsxs(e.Fragment, {
                                            children: [
                                              e.jsx("option", {
                                                value: "2K",
                                                children: "2K",
                                              }),
                                              e.jsx("option", {
                                                value: "4K",
                                                children: "4K",
                                              }),
                                            ],
                                          })
                                        : e.jsxs(e.Fragment, {
                                            children: [
                                              e.jsx("option", {
                                                value: "1080P",
                                                children: "1080P",
                                              }),
                                              e.jsx("option", {
                                                value: "4K",
                                                children: "4K",
                                              }),
                                            ],
                                          }),
                                  }),
                              ],
                            }),
                            e.jsx("input", {
                              type: "text",
                              value: V,
                              readOnly: !0,
                              className:
                                "flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs bg-slate-50 text-slate-600 truncate",
                              placeholder: "Chưa chọn thư mục",
                              title: V,
                            }),
                            e.jsxs("button", {
                              onClick: Us,
                              className:
                                "inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap",
                              title: "Chọn thư mục",
                              children: [
                                e.jsx(As, { className: "h-3 w-3" }),
                                "Chọn",
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                    Zr &&
                      e.jsx(M4, {
                        id: "file-naming-panel",
                        template: Os,
                        onChange: (E) => {
                          Vl(E),
                            jn.current && clearTimeout(jn.current),
                            (jn.current = setTimeout(() => {
                              Me.updateProject(t, {
                                fileNamingTemplate: E === Mr ? null : E,
                              }).catch((D) =>
                                console.error(
                                  "Failed to save fileNamingTemplate:",
                                  D,
                                ),
                              );
                            }, 600));
                        },
                        samplePrompt:
                          bt.find((E) => E.prompt)?.prompt ??
                          Mt[0]?.prompt ??
                          "",
                        aspectRatio: M,
                        isImageMode:
                          A === "IMAGE_GENERATION" ||
                          A === "IMAGE_GENERATION_BATCH_REFS",
                      }),
                    e.jsxs("div", {
                      className: "flex gap-1.5 flex-wrap",
                      children: [
                        gn.length > 0 &&
                          !Ji &&
                          e.jsxs("button", {
                            onClick: ro,
                            className:
                              "px-2 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md transition-colors flex items-center gap-1",
                            children: [
                              e.jsx(Fe, { className: "h-3 w-3" }),
                              "Gen lại (",
                              gn.length,
                              ")",
                            ],
                          }),
                        (bt.length > 0 || gn.length > 0) &&
                          (Ji
                            ? e.jsxs("div", {
                                className:
                                  "flex items-center gap-1 rounded-md text-xs font-medium border border-emerald-200 bg-emerald-50 overflow-hidden",
                                children: [
                                  e.jsx("button", {
                                    onClick: Tc,
                                    className:
                                      "px-2 py-1 text-emerald-700 hover:bg-emerald-100 transition-colors",
                                    children: "Chọn tất cả",
                                  }),
                                  e.jsx("button", {
                                    onClick: lo,
                                    className:
                                      "px-2 py-1 text-emerald-700 hover:bg-emerald-100 transition-colors border-l border-emerald-200",
                                    children: "Bỏ chọn",
                                  }),
                                  e.jsxs("button", {
                                    onClick: io,
                                    disabled: Ca.size === 0 || vc,
                                    className:
                                      "px-2 py-1 text-white bg-emerald-600 hover:bg-emerald-700 transition-colors flex items-center gap-1 disabled:opacity-50",
                                    children: [
                                      vc
                                        ? e.jsxs("svg", {
                                            className: "animate-spin h-3 w-3",
                                            viewBox: "0 0 24 24",
                                            children: [
                                              e.jsx("circle", {
                                                className: "opacity-25",
                                                cx: "12",
                                                cy: "12",
                                                r: "10",
                                                stroke: "currentColor",
                                                strokeWidth: "4",
                                                fill: "none",
                                              }),
                                              e.jsx("path", {
                                                className: "opacity-75",
                                                fill: "currentColor",
                                                d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                              }),
                                            ],
                                          })
                                        : e.jsx(Fe, { className: "h-3 w-3" }),
                                      "Gen lại (",
                                      Ca.size,
                                      ")",
                                    ],
                                  }),
                                  e.jsx("button", {
                                    onClick: () => {
                                      pc(!1), Kl(new Set());
                                    },
                                    className:
                                      "px-1.5 py-1 text-emerald-700 hover:bg-emerald-100 transition-colors border-l border-emerald-200",
                                    children: "✕",
                                  }),
                                ],
                              })
                            : e.jsxs("button", {
                                onClick: () => {
                                  pc(!0), xc(!1), Zi(new Set());
                                },
                                className:
                                  "px-2 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md transition-colors flex items-center gap-1",
                                children: [
                                  e.jsx(at, { className: "h-3 w-3" }),
                                  "Chọn để gen lại",
                                ],
                              })),
                        e.jsx(MangaStoryPanel,{key:"manga-"+t,projectId:t,onUpdated:p}),
e.jsx(PolicyPromptRewrite,{key:t,projectId:t,jobs:b,onUpdated:p}),
                        bt.length > 0 &&
                          e.jsxs(e.Fragment, {
                            children: [
                              A !== "IMAGE_GENERATION" &&
                                e.jsx("div", {
                                  className:
                                    "flex items-center rounded-md text-xs font-medium border border-purple-200 bg-purple-50 overflow-hidden",
                                  children: eu
                                    ? e.jsxs(e.Fragment, {
                                        children: [
                                          e.jsx("button", {
                                            onClick: yc,
                                            disabled: Et || tr.size < 2,
                                            className:
                                              "px-2 py-1 text-purple-700 hover:bg-purple-100 transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed border-r border-purple-200",
                                            children: Et
                                              ? e.jsxs(e.Fragment, {
                                                  children: [
                                                    e.jsxs("svg", {
                                                      className:
                                                        "animate-spin h-3 w-3",
                                                      viewBox: "0 0 24 24",
                                                      children: [
                                                        e.jsx("circle", {
                                                          className:
                                                            "opacity-25",
                                                          cx: "12",
                                                          cy: "12",
                                                          r: "10",
                                                          stroke:
                                                            "currentColor",
                                                          strokeWidth: "4",
                                                          fill: "none",
                                                        }),
                                                        e.jsx("path", {
                                                          className:
                                                            "opacity-75",
                                                          fill: "currentColor",
                                                          d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                                        }),
                                                      ],
                                                    }),
                                                    "Ghép (",
                                                    tr.size,
                                                    ")",
                                                  ],
                                                })
                                              : e.jsxs(e.Fragment, {
                                                  children: [
                                                    e.jsx(Sn, {
                                                      className: "h-3 w-3",
                                                    }),
                                                    "Ghép (",
                                                    tr.size,
                                                    ")",
                                                  ],
                                                }),
                                          }),
                                          e.jsx("button", {
                                            onClick: () => {
                                              xc(!1), Zi(new Set());
                                            },
                                            disabled: Et,
                                            className:
                                              "px-2 py-1 text-purple-700 hover:bg-purple-100 transition-colors",
                                            title: "Hủy chọn",
                                            children: e.jsx(tt, {
                                              className: "h-3 w-3",
                                            }),
                                          }),
                                        ],
                                      })
                                    : e.jsxs(e.Fragment, {
                                        children: [
                                          e.jsx("button", {
                                            onClick: () => Qn(),
                                            disabled: Et,
                                            className:
                                              "px-2 py-1 text-purple-700 hover:bg-purple-100 transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed border-r border-purple-200",
                                            title:
                                              "Ghép tất cả video hoàn thành",
                                            children: Et
                                              ? e.jsxs(e.Fragment, {
                                                  children: [
                                                    e.jsxs("svg", {
                                                      className:
                                                        "animate-spin h-3 w-3",
                                                      viewBox: "0 0 24 24",
                                                      children: [
                                                        e.jsx("circle", {
                                                          className:
                                                            "opacity-25",
                                                          cx: "12",
                                                          cy: "12",
                                                          r: "10",
                                                          stroke:
                                                            "currentColor",
                                                          strokeWidth: "4",
                                                          fill: "none",
                                                        }),
                                                        e.jsx("path", {
                                                          className:
                                                            "opacity-75",
                                                          fill: "currentColor",
                                                          d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                                        }),
                                                      ],
                                                    }),
                                                    "Ghép tất cả",
                                                  ],
                                                })
                                              : e.jsxs(e.Fragment, {
                                                  children: [
                                                    e.jsx(Sn, {
                                                      className: "h-3 w-3",
                                                    }),
                                                    "Ghép tất cả",
                                                  ],
                                                }),
                                          }),
                                          e.jsx("button", {
                                            onClick: () => xc(!0),
                                            disabled: Et,
                                            className:
                                              "px-1.5 py-1 text-purple-700 hover:bg-purple-100 transition-colors bg-purple-100/50",
                                            title: "Chọn video để ghép",
                                            children: e.jsx("span", {
                                              className:
                                                "text-[10px] uppercase font-bold px-0.5",
                                              children: "Chọn",
                                            }),
                                          }),
                                          e.jsx("button", {
                                            onClick: () => gt(!0),
                                            disabled: Et || qt,
                                            className:
                                              "px-1.5 py-1 text-purple-700 hover:bg-purple-100 transition-colors border-l border-purple-200 disabled:opacity-50",
                                            title:
                                              "Chia thành nhiều file — theo số lượng hoặc theo batch gốc",
                                            children: e.jsx("span", {
                                              className:
                                                "text-[10px] uppercase font-bold px-0.5",
                                              children: "Batch",
                                            }),
                                          }),
                                        ],
                                      }),
                                }),
                              e.jsxs("button", {
                                onClick: bu,
                                className:
                                  "px-2 py-1 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-md transition-colors flex items-center gap-1",
                                children: [
                                  e.jsx(_y, { className: "h-3 w-3" }),
                                  "Tải",
                                ],
                              }),
                              ln > 0 &&
                                e.jsxs("button", {
                                  onClick: uo,
                                  disabled: Ie,
                                  className:
                                    "px-2 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50",
                                  title:
                                    "Tải lại các video chưa lưu vào máy — tự làm mới link hết hạn",
                                  children: [
                                    e.jsx(Fe, { className: "h-3 w-3" }),
                                    "Tải lại ",
                                    ln,
                                    " file thiếu",
                                  ],
                                }),
                              bt.filter((E) => cr(E)).length > 0 &&
                                (() => {
                                  const E = bt.find((ee) => cr(ee)),
                                    K =
                                      E && Yy(E)
                                        ? ["2K", "4K"]
                                        : ["1080P", "4K"];
                                  return e.jsx(Xy, {
                                    onSelect: (ee) => dr(ee),
                                    options: K,
                                    disabled: xt,
                                  });
                                })(),
                              e.jsx("button", {
                                onClick: Ac,
                                className:
                                  "px-2 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md transition-colors flex items-center gap-1",
                                children: e.jsx(qs, { className: "h-3 w-3" }),
                              }),
                              bt.filter(
                                (E) =>
                                  E.mode === "IMAGE_GENERATION" &&
                                  E.status === "COMPLETED" &&
                                  E.resultUrl,
                              ).length > 0 &&
                                e.jsxs("button", {
                                  onClick: ir,
                                  className:
                                    "px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md transition-colors flex items-center gap-1",
                                  title:
                                    "Chuyển tất cả ảnh đã gen thành start frame để gen video",
                                  children: [
                                    e.jsx(Cd, { className: "h-3 w-3" }),
                                    "StartFrame (",
                                    bt.filter(
                                      (E) =>
                                        E.mode === "IMAGE_GENERATION" &&
                                        E.status === "COMPLETED" &&
                                        E.resultUrl,
                                    ).length,
                                    ")",
                                  ],
                                }),
                            ],
                          }),
                      ],
                    }),
                  ],
                }),
                (bt.length > 0 || gn.length > 0) &&
                  e.jsxs("div", {
                    className: "flex items-center gap-2 mb-2 flex-wrap",
                    children: [
                      e.jsxs("div", {
                        className: "flex gap-1",
                        children: [
                          ["all", "completed", "failed"].map((E) => {
                            const D =
                                E === "all"
                                  ? bt.length + gn.length
                                  : E === "completed"
                                    ? bt.length
                                    : gn.length,
                              K =
                                E === "all"
                                  ? "Tất cả"
                                  : E === "completed"
                                    ? "Hoàn thành"
                                    : "Thất bại";
                            return e.jsxs(
                              "button",
                              {
                                onClick: () => gc(E),
                                className: `px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${Ea === E ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`,
                                children: [K, " (", D, ")"],
                              },
                              E,
                            );
                          }),
                          ln > 0 &&
                            e.jsxs("button", {
                              onClick: () => gc("missing"),
                              className: `px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${Ea === "missing" ? "bg-red-600 text-white" : "bg-red-50 text-red-600 hover:bg-red-100"}`,
                              title:
                                "Video hoàn thành nhưng chưa lưu được vào máy",
                              children: ["Thiếu file (", ln, ")"],
                            }),
                        ],
                      }),
                      e.jsxs("div", {
                        className: "ml-auto flex items-center gap-1.5",
                        children: [
                          e.jsxs("div", {
                            className:
                              "inline-flex items-center rounded-md border border-slate-200 bg-white overflow-hidden",
                            children: [
                              e.jsxs("button", {
                                onClick: () => su("grid"),
                                className: `px-2 py-1 flex items-center gap-1 text-xs font-medium transition-colors ${Ps === "grid" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`,
                                title: "Dạng lưới",
                                children: [
                                  e.jsx(Oi, { className: "h-3.5 w-3.5" }),
                                  "Grid",
                                ],
                              }),
                              e.jsxs("button", {
                                onClick: () => su("list"),
                                className: `px-2 py-1 flex items-center gap-1 text-xs font-medium transition-colors border-l border-slate-200 ${Ps === "list" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`,
                                title: "Dạng danh sách",
                                children: [
                                  e.jsx(Ay, { className: "h-3.5 w-3.5" }),
                                  "List",
                                ],
                              }),
                            ],
                          }),
                          Ps === "grid" &&
                            e.jsx("div", {
                              className:
                                "inline-flex items-center rounded-md border border-slate-200 bg-white overflow-hidden",
                              children: [2, 3, 4, 5].map((E, D) =>
                                e.jsx(
                                  "button",
                                  {
                                    onClick: () => L0(E),
                                    className: `px-2 py-1 text-xs font-medium transition-colors ${D > 0 ? "border-l border-slate-200" : ""} ${ql === E ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`,
                                    title: `${E} cột`,
                                    children: E,
                                  },
                                  E,
                                ),
                              ),
                            }),
                        ],
                      }),
                    ],
                  }),
                e.jsx("div", {
                  ref: Sc,
                  className:
                    "flex-1 bg-white rounded-lg border border-slate-200 overflow-auto min-h-0 p-2",
                  children:
                    bt.length === 0 && gn.length === 0
                      ? e.jsx("div", {
                          className: "h-full flex items-center justify-center",
                          children: e.jsxs("div", {
                            className: "text-center text-slate-400",
                            children: [
                              e.jsx(Sn, {
                                className: "h-12 w-12 mx-auto mb-2 opacity-50",
                              }),
                              e.jsx("p", {
                                className: "text-sm",
                                children: "Chưa có kết quả",
                              }),
                              e.jsx("p", {
                                className: "text-xs mt-1",
                                children:
                                  "Tạo job và bắt đầu gen để xem kết quả",
                              }),
                            ],
                          }),
                        })
                      : e.jsx("div", {
                          style: {
                            height: Ql.getTotalSize(),
                            position: "relative",
                          },
                          children: Ql.getVirtualItems().map((E) =>
                            e.jsx(
                              "div",
                              {
                                "data-index": E.index,
                                ref: Ql.measureElement,
                                style: {
                                  position: "absolute",
                                  top: 0,
                                  left: 0,
                                  width: "100%",
                                  transform: `translateY(${E.start}px)`,
                                },
                                className:
                                  Ps === "grid"
                                    ? `grid ${$4[ql]} gap-2 pb-2`
                                    : "flex flex-col pb-2",
                                children: so[E.index].map((D) =>
                                  e.jsx(
                                    V4,
                                    {
                                      job: D,
                                      variant: Ps === "list" ? "list" : "card",
                                      onRetry: () => gu(D.id),
                                      onCancel: () => si(D.id),
                                      onDelete: () => Jn(D.id),
                                      onEdit: pu,
                                      onReuse: H0,
                                      onUpsample: oo,
                                      onPreview: Re,
                                      outputDir: V,
                                      fileNamingTemplate: Os,
                                      aspectRatio: M,
                                      canUpsample: cr(D),
                                      isSelected: Ji
                                        ? Ca.has(D.id)
                                        : tr.has(D.id),
                                      onSelect: Ji
                                        ? () => al(D.id)
                                        : eu && D.mode !== "IMAGE_GENERATION"
                                          ? () => P0(D.id)
                                          : void 0,
                                      upsampleChild: V0.get(D.id) || null,
                                      isEditingPrompt: bc === D.id,
                                      onStartEditPrompt: () => Qi(D.id),
                                      onSavePrompt: (K) => Gn(D.id, K),
                                      onCancelEditPrompt: () => Qi(null),
                                      autoDownload: ta,
                                      autoUpscale: js,
                                      isPromptEdited: eo.has(D.id),
                                    },
                                    D.id,
                                  ),
                                ),
                              },
                              E.key,
                            ),
                          ),
                        }),
                }),
              ],
            }),
          ],
        }),
        Ie &&
          e.jsx("div", {
            className:
              "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]",
            onClick: (E) => E.stopPropagation(),
            children: e.jsxs("div", {
              className:
                "bg-white rounded-lg shadow-xl p-6 min-w-[400px] max-w-[500px]",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsxs("div", {
                  className: "flex items-center gap-4 mb-4",
                  children: [
                    e.jsxs("svg", {
                      className: "animate-spin h-8 w-8 text-indigo-600",
                      viewBox: "0 0 24 24",
                      children: [
                        e.jsx("circle", {
                          className: "opacity-25",
                          cx: "12",
                          cy: "12",
                          r: "10",
                          stroke: "currentColor",
                          strokeWidth: "4",
                          fill: "none",
                        }),
                        e.jsx("path", {
                          className: "opacity-75",
                          fill: "currentColor",
                          d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                        }),
                      ],
                    }),
                    e.jsxs("div", {
                      className: "flex-1",
                      children: [
                        e.jsx("h3", {
                          className: "text-lg font-semibold text-slate-900",
                          children: "Đang tải file...",
                        }),
                        e.jsx("p", {
                          className: "text-sm text-slate-600 mt-1",
                          children: "Vui lòng đợi trong khi tải file",
                        }),
                      ],
                    }),
                  ],
                }),
                e.jsxs("div", {
                  className: "mb-4",
                  children: [
                    e.jsxs("div", {
                      className:
                        "flex items-center justify-between text-sm text-slate-600 mb-2",
                      children: [
                        e.jsxs("span", {
                          children: ["Tiến độ: ", Ve.current, "/", Ve.total],
                        }),
                        e.jsxs("span", {
                          children: [
                            Math.round((Ve.current / Ve.total) * 100),
                            "%",
                          ],
                        }),
                      ],
                    }),
                    e.jsx("div", {
                      className:
                        "w-full bg-slate-200 rounded-full h-2.5 overflow-hidden",
                      children: e.jsx("div", {
                        className:
                          "bg-indigo-600 h-full transition-all duration-300",
                        style: { width: `${(Ve.current / Ve.total) * 100}%` },
                      }),
                    }),
                  ],
                }),
                e.jsxs("div", {
                  className: "flex items-center gap-4 text-sm",
                  children: [
                    e.jsxs("div", {
                      className: "flex items-center gap-2 text-green-600",
                      children: [
                        e.jsx(at, { className: "h-5 w-5" }),
                        e.jsxs("span", {
                          children: ["Thành công: ", Ve.success],
                        }),
                      ],
                    }),
                    Ve.failed > 0 &&
                      e.jsxs("div", {
                        className: "flex items-center gap-2 text-red-600",
                        children: [
                          e.jsx(Mn, { className: "h-5 w-5" }),
                          e.jsxs("span", { children: ["Lỗi: ", Ve.failed] }),
                        ],
                      }),
                  ],
                }),
              ],
            }),
          }),
        O0 &&
          e.jsx("div", {
            className:
              "fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]",
            onClick: () => Gl(!1),
            onKeyDown: (E) => {
              E.key === "Escape" && Gl(!1);
            },
            children: e.jsxs("div", {
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "dl-failure-modal-title",
              className:
                "bg-white rounded-lg shadow-xl p-6 min-w-[420px] max-w-[560px] max-h-[70vh] flex flex-col",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsxs("div", {
                  className: "flex items-center gap-3 mb-4",
                  children: [
                    e.jsx(Mn, {
                      className: "h-6 w-6 text-red-500 flex-shrink-0",
                    }),
                    e.jsxs("h3", {
                      id: "dl-failure-modal-title",
                      className: "text-base font-semibold text-slate-900",
                      children: [Qd.length, " file chưa tải được"],
                    }),
                  ],
                }),
                e.jsx("div", {
                  className: "flex-1 overflow-auto mb-4 space-y-1.5",
                  children: Qd.map(({ job: E, error: D }) =>
                    e.jsxs(
                      "div",
                      {
                        className:
                          "flex items-start gap-2 px-3 py-2 rounded bg-red-50 border border-red-200",
                        children: [
                          e.jsx(Mn, {
                            className:
                              "h-4 w-4 text-red-400 flex-shrink-0 mt-0.5",
                          }),
                          e.jsxs("div", {
                            className: "flex-1 min-w-0",
                            children: [
                              e.jsxs("div", {
                                className:
                                  "text-[11px] font-medium text-red-800",
                                children: [
                                  "#",
                                  E.jobIndex + 1,
                                  E.prompt
                                    ? ` — ${E.prompt.slice(0, 60)}${E.prompt.length > 60 ? "…" : ""}`
                                    : "",
                                ],
                              }),
                              e.jsx("div", {
                                className: "text-[10px] text-red-600 mt-0.5",
                                children: D,
                              }),
                            ],
                          }),
                        ],
                      },
                      E.id,
                    ),
                  ),
                }),
                e.jsxs("div", {
                  className: "flex gap-2 justify-end",
                  children: [
                    e.jsxs("button", {
                      autoFocus: !0,
                      onClick: () => {
                        Gl(!1), uo();
                      },
                      className:
                        "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700",
                      children: [
                        e.jsx(Fe, { className: "h-4 w-4" }),
                        "Thử lại",
                      ],
                    }),
                    e.jsx("button", {
                      onClick: () => Gl(!1),
                      className:
                        "px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200",
                      children: "Đóng",
                    }),
                  ],
                }),
              ],
            }),
          }),
        ie &&
          e.jsx("div", {
            className:
              "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50",
            children: e.jsxs("div", {
              className: "bg-white rounded-lg p-6 max-w-md w-full mx-4",
              children: [
                e.jsx("h3", {
                  className: "text-lg font-semibold text-slate-900 mb-4",
                  children: "Đang upload ảnh...",
                }),
                e.jsxs("div", {
                  className: "space-y-3",
                  children: [
                    e.jsx("div", {
                      className: "w-full bg-slate-200 rounded-full h-2",
                      children: e.jsx("div", {
                        className:
                          "bg-indigo-600 h-2 rounded-full transition-all duration-300",
                        style: {
                          width: `${Ee.total > 0 ? (Ee.current / Ee.total) * 100 : 0}%`,
                        },
                      }),
                    }),
                    e.jsx("div", {
                      className: "text-sm text-slate-600 text-center",
                      children: Ee.message || "Đang xử lý...",
                    }),
                    e.jsxs("div", {
                      className: "text-xs text-slate-500 text-center",
                      children: [Ee.current, " / ", Ee.total],
                    }),
                  ],
                }),
              ],
            }),
          }),
        Se &&
          e.jsx("div", {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Xem media",
            className:
              "fixed inset-0 bg-black/80 flex items-center justify-center z-[10000]",
            onClick: () => Re(null),
            children: e.jsxs("div", {
              className: "max-w-[90vw] max-h-[90vh] relative",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsx("button", {
                  onClick: () => Re(null),
                  "aria-label": "Đóng",
                  autoFocus: !0,
                  className:
                    "absolute top-4 right-4 p-2 bg-black/50 hover:bg-black/70 text-white rounded-full z-10",
                  children: e.jsx(tt, { className: "h-6 w-6" }),
                }),
                Se.type === "image"
                  ? e.jsx("img", {
                      src: Se.url,
                      alt: "Preview",
                      className:
                        "max-w-full max-h-[90vh] object-contain rounded-lg",
                      onError: (E) => {
                        E.target.style.display = "none";
                      },
                    })
                  : e.jsx("video", {
                      src: Se.url,
                      className: "max-w-full max-h-[90vh] rounded-lg",
                      controls: !0,
                      autoPlay: !0,
                      loop: !0,
                      preload: "auto",
                      onError: (E) => {
                        E.target.style.display = "none";
                      },
                    }),
              ],
            }),
          }),
        ps &&
          e.jsx("div", {
            className:
              "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]",
            onClick: or,
            children: e.jsxs("div", {
              className:
                "bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsxs("div", {
                  className: "flex items-center justify-between mb-4",
                  children: [
                    e.jsxs("h3", {
                      className: "text-lg font-semibold text-slate-900",
                      children: ["Sửa ảnh - Job #", ps.jobIndex + 1],
                    }),
                    e.jsx("button", {
                      onClick: or,
                      className: "text-slate-400 hover:text-slate-600",
                      children: e.jsx(tt, { className: "h-5 w-5" }),
                    }),
                  ],
                }),
                ps.resultUrl &&
                  e.jsx("div", {
                    className:
                      "mb-4 rounded-lg overflow-hidden bg-slate-100 border border-slate-200",
                    children: e.jsx("img", {
                      src: ps.resultUrl,
                      alt: "Image to edit",
                      className: "w-full h-auto max-h-96 object-contain",
                      onError: (E) => {
                        E.target.style.display = "none";
                      },
                    }),
                  }),
                e.jsxs("div", {
                  className: "mb-4",
                  children: [
                    e.jsx("label", {
                      className:
                        "block text-sm font-medium text-slate-700 mb-2",
                      children: "Prompt sửa ảnh",
                    }),
                    e.jsx(Ir, {
                      value: Br,
                      onChange: (E) => Vr(E),
                      className:
                        "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                      rows: 4,
                      placeholder:
                        "Nhập prompt để sửa ảnh (ví dụ: sửa hình ảnh Thánh gióng cưỡi ngựa đang kéo nhổ gốc cây tre)",
                    }),
                  ],
                }),
                e.jsxs("div", {
                  className: "flex gap-2 justify-end",
                  children: [
                    e.jsx("button", {
                      onClick: or,
                      disabled: Ba,
                      className:
                        "px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed",
                      children: "Hủy",
                    }),
                    e.jsx("button", {
                      onClick: rl,
                      disabled: Ba || !Br.trim(),
                      className:
                        "px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2",
                      children: Ba
                        ? e.jsxs(e.Fragment, {
                            children: [
                              e.jsxs("svg", {
                                className: "animate-spin h-4 w-4",
                                viewBox: "0 0 24 24",
                                children: [
                                  e.jsx("circle", {
                                    className: "opacity-25",
                                    cx: "12",
                                    cy: "12",
                                    r: "10",
                                    stroke: "currentColor",
                                    strokeWidth: "4",
                                    fill: "none",
                                  }),
                                  e.jsx("path", {
                                    className: "opacity-75",
                                    fill: "currentColor",
                                    d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                  }),
                                ],
                              }),
                              "Đang xử lý...",
                            ],
                          })
                        : "Sửa ảnh",
                    }),
                  ],
                }),
              ],
            }),
          }),
        yn &&
          e.jsx("div", {
            className:
              "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]",
            onClick: ai,
            children: e.jsxs("div", {
              className:
                "bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsxs("div", {
                  className: "flex items-center justify-between mb-4",
                  children: [
                    e.jsxs("h3", {
                      className: "text-lg font-semibold text-slate-900",
                      children: [
                        "Sử dụng lại cấu hình - Job #",
                        yn.jobIndex + 1,
                      ],
                    }),
                    e.jsx("button", {
                      onClick: ai,
                      className: "text-slate-400 hover:text-slate-600",
                      children: e.jsx(tt, { className: "h-5 w-5" }),
                    }),
                  ],
                }),
                yn.resultUrl &&
                  e.jsx("div", {
                    className:
                      "mb-4 rounded-lg overflow-hidden bg-slate-900 border border-slate-200",
                    children:
                      yn.mode === "IMAGE_GENERATION"
                        ? e.jsx("img", {
                            src: yn.resultUrl,
                            alt: "Generated image",
                            className: "w-full h-auto max-h-96 object-contain",
                            onError: (E) => {
                              E.target.style.display = "none";
                            },
                          })
                        : e.jsx("video", {
                            src: yn.resultUrl,
                            className: "w-full h-auto max-h-96 object-contain",
                            controls: !0,
                            preload: "metadata",
                            children:
                              "Your browser does not support the video tag.",
                          }),
                  }),
                e.jsx("div", {
                  className:
                    "mb-4 p-3 bg-slate-50 rounded-md border border-slate-200",
                  children: e.jsxs("div", {
                    className: "text-xs text-slate-600 space-y-1",
                    children: [
                      e.jsxs("div", {
                        children: [
                          e.jsx("span", {
                            className: "font-medium",
                            children: "Profile:",
                          }),
                          " ",
                          yn.profile?.name,
                        ],
                      }),
                      e.jsxs("div", {
                        children: [
                          e.jsx("span", {
                            className: "font-medium",
                            children: "Loại:",
                          }),
                          " ",
                          Kn(yn.mode || ""),
                        ],
                      }),
                      yn.startImageMediaId &&
                        e.jsxs("div", {
                          className: "flex items-center gap-1",
                          children: [
                            e.jsx("span", {
                              className: "font-medium",
                              children: "Start Frame:",
                            }),
                            e.jsx(at, { className: "h-3 w-3 text-green-600" }),
                          ],
                        }),
                      yn.endImageMediaId &&
                        e.jsxs("div", {
                          className: "flex items-center gap-1",
                          children: [
                            e.jsx("span", {
                              className: "font-medium",
                              children: "End Frame:",
                            }),
                            e.jsx(at, { className: "h-3 w-3 text-green-600" }),
                          ],
                        }),
                      yn.referenceImageMediaIds &&
                        e.jsxs("div", {
                          className: "flex items-center gap-1",
                          children: [
                            e.jsx("span", {
                              className: "font-medium",
                              children: "Ảnh tham chiếu:",
                            }),
                            e.jsx(at, { className: "h-3 w-3 text-green-600" }),
                          ],
                        }),
                    ],
                  }),
                }),
                e.jsxs("div", {
                  className: "mb-4",
                  children: [
                    e.jsx("label", {
                      className:
                        "block text-sm font-medium text-slate-700 mb-2",
                      children: "Prompt mới",
                    }),
                    e.jsx(Ir, {
                      value: Va,
                      onChange: (E) => Hr(E),
                      className:
                        "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                      rows: 4,
                      placeholder:
                        yn.mode === "IMAGE_GENERATION"
                          ? "Nhập prompt mới (ảnh tham chiếu cũ sẽ được giữ nguyên)"
                          : "Nhập prompt mới (toàn bộ cấu hình cũ sẽ được giữ nguyên)",
                    }),
                  ],
                }),
                e.jsxs("div", {
                  className: "flex gap-2 justify-end",
                  children: [
                    e.jsx("button", {
                      onClick: ai,
                      disabled: Ha,
                      className:
                        "px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed",
                      children: "Hủy",
                    }),
                    e.jsx("button", {
                      onClick: Mc,
                      disabled: Ha || !Va.trim(),
                      className:
                        "px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2",
                      children: Ha
                        ? e.jsxs(e.Fragment, {
                            children: [
                              e.jsxs("svg", {
                                className: "animate-spin h-4 w-4",
                                viewBox: "0 0 24 24",
                                children: [
                                  e.jsx("circle", {
                                    className: "opacity-25",
                                    cx: "12",
                                    cy: "12",
                                    r: "10",
                                    stroke: "currentColor",
                                    strokeWidth: "4",
                                    fill: "none",
                                  }),
                                  e.jsx("path", {
                                    className: "opacity-75",
                                    fill: "currentColor",
                                    d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                  }),
                                ],
                              }),
                              "Đang xử lý...",
                            ],
                          })
                        : "Tạo job mới",
                    }),
                  ],
                }),
              ],
            }),
          }),
        bc &&
          (() => {
            const E = b.find((D) => D.id === bc);
            return E
              ? e.jsx(y4, {
                  job: E,
                  onSave: async (D) => {
                    await Gn(E.id, D);
                  },
                  onClose: () => Qi(null),
                })
              : null;
          })(),
        Wa.isOpen &&
          Wa.file &&
          e.jsx(q3, {
            imageFile: Wa.file,
            aspectRatio: M === "9:16" ? "9:16" : "16:9",
            onCropComplete: po,
            onCancel: ju,
          }),
        Ye &&
          e.jsx("div", {
            className:
              "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4",
            onClick: () => We(!1),
            children: e.jsxs("div", {
              className:
                "bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col",
              onClick: (E) => E.stopPropagation(),
              children: [
                e.jsxs("div", {
                  className:
                    "px-5 py-3 border-b border-slate-200 flex items-center justify-between",
                  children: [
                    e.jsxs("div", {
                      className: "flex items-center gap-2",
                      children: [
                        e.jsx(Xo, { className: "h-5 w-5 text-indigo-600" }),
                        e.jsx("h3", {
                          className: "text-sm font-semibold text-slate-800",
                          children: "Cài đặt nâng cao",
                        }),
                      ],
                    }),
                    e.jsx("button", {
                      onClick: () => We(!1),
                      className: "p-1 hover:bg-slate-100 rounded",
                      title: "Đóng",
                      children: e.jsx(tt, {
                        className: "h-4 w-4 text-slate-500",
                      }),
                    }),
                  ],
                }),
                e.jsxs("div", {
                  className: "px-5 py-4 space-y-4 overflow-y-auto",
                  children: [
                    e.jsx(PromptRewriteSettings,{}),
                    e.jsxs("div", {
                      children: [
                        e.jsx("label", {
                          className:
                            "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                          children: "Model",
                        }),
                        e.jsx("select", {
                          value: _,
                          onChange: (E) => L(E.target.value),
                          disabled: I,
                          className:
                            "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          children: zs.map((E) =>
                            e.jsx(
                              "option",
                              { value: E.value, children: E.label },
                              E.value,
                            ),
                          ),
                        }),
                      ],
                    }),
                    e.jsxs("div", {
                      children: [
                        e.jsx("label", {
                          className:
                            "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                          children: "Số luồng song song / profile",
                        }),
                        e.jsx("select", {
                          value: ce,
                          onChange: (E) => O(Number(E.target.value)),
                          className:
                            "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          children: Array.from(
                            { length: de },
                            (E, D) => D + 1,
                          ).map((E) =>
                            e.jsxs(
                              "option",
                              { value: E, children: [E, " luồng"] },
                              E,
                            ),
                          ),
                        }),
                        (() => {
                          const E = l?.profiles?.length || 1,
                            D = ce * E,
                            K = Ae.maxConcurrentGlobal,
                            ee = Ae.totalMemGB
                              ? ` (RAM ${Ae.totalMemGB}GB)`
                              : "";
                          if (D > K)
                            return e.jsxs("p", {
                              className: "text-[11px] text-red-500 mt-1.5",
                              children: [
                                D,
                                " jobs (",
                                E,
                                " profiles ×",
                                " ",
                                ce,
                                ") vượt giới hạn ",
                                K,
                                ee,
                                ". Hệ thống sẽ tự giới hạn.",
                              ],
                            });
                          const te = Math.max(10, Math.floor(K * 0.7));
                          return D > te
                            ? e.jsxs("p", {
                                className: "text-[11px] text-amber-500 mt-1.5",
                                children: [
                                  D,
                                  " concurrent jobs — gần giới hạn",
                                  " ",
                                  K,
                                  ee,
                                  ".",
                                ],
                              })
                            : e.jsxs("p", {
                                className: "text-[11px] text-slate-400 mt-1.5",
                                children: [D, " / ", K, " jobs song song", ee],
                              });
                        })(),
                      ],
                    }),
                    e.jsxs("div", {
                      children: [
                        e.jsx("label", {
                          className:
                            "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                          children: "Nghỉ sau mỗi đợt (giây)",
                        }),
                        e.jsx("select", {
                          value: Q,
                          onChange: (E) => ue(Number(E.target.value)),
                          className:
                            "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          children: od.map((E) =>
                            e.jsxs(
                              "option",
                              { value: E, children: [E, "s"] },
                              E,
                            ),
                          ),
                        }),
                        e.jsx("p", {
                          className: "text-[11px] text-slate-400 mt-1.5",
                          children:
                            "5-7s: chế độ nhanh, chỉ dùng khi extension bridge ổn (score reCAPTCHA cao). 10-25s: an toàn mặc định.",
                        }),
                      ],
                    }),
                    (() => {
                      const E =
                          A === "IMAGE_GENERATION" ||
                          A === "IMAGE_GENERATION_BATCH_REFS",
                        D = E ? "ảnh" : "video";
                      return e.jsxs("div", {
                        children: [
                          e.jsxs("label", {
                            className:
                              "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                            children: ["Số ", D, " mỗi đợt (burst)"],
                          }),
                          e.jsx("select", {
                            value: we,
                            onChange: async (K) => {
                              const ee = Number(K.target.value);
                              Le(ee);
                              try {
                                await Me.updateProject(t, { batchSize: ee });
                              } catch (te) {
                                console.error("Failed to save burstSize:", te);
                              }
                            },
                            className:
                              "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                            children: [1, 2, 3, 4].map((K) =>
                              e.jsxs(
                                "option",
                                { value: K, children: [K, " ", D] },
                                K,
                              ),
                            ),
                          }),
                          E && we === 4 && Q <= 5
                            ? e.jsxs("p", {
                                className:
                                  "text-[11px] text-amber-600 mt-1.5 flex items-start gap-1",
                                children: [
                                  e.jsx(Mn, {
                                    className:
                                      "h-3.5 w-3.5 flex-shrink-0 mt-0.5",
                                  }),
                                  e.jsx("span", {
                                    children:
                                      "Chế độ nhanh nhất — tăng nhẹ nguy cơ reCAPTCHA 403. Chỉ dùng khi extension bridge ổn và score cao.",
                                  }),
                                ],
                              })
                            : E
                              ? e.jsxs("p", {
                                  className:
                                    "text-[11px] text-slate-400 mt-1.5",
                                  children: [
                                    "Gửi ",
                                    we,
                                    " ảnh gần như song song (chung 1 batchId, mỗi ảnh 1 token), sau đó nghỉ ",
                                    Q,
                                    "s — khớp cơ chế native Veo3.",
                                  ],
                                })
                              : e.jsxs("p", {
                                  className:
                                    "text-[11px] text-slate-400 mt-1.5",
                                  children: [
                                    "Gửi ",
                                    we,
                                    " video cùng mode chung 1 batchId (server kẹp tối đa 2 để an toàn). Video async — nặng hơn ảnh, để luồng (concurrency) thấp khi test.",
                                  ],
                                }),
                        ],
                      });
                    })(),
                    A !== "IMAGE_GENERATION" &&
                      A !== "IMAGE_GENERATION_BATCH_REFS" &&
                      e.jsxs("div", {
                        children: [
                          e.jsx("label", {
                            className:
                              "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                            children: "Tạo audio cho video",
                          }),
                          e.jsxs("label", {
                            className:
                              "flex items-center gap-2 cursor-pointer select-none",
                            children: [
                              e.jsx("input", {
                                type: "checkbox",
                                checked: J,
                                onChange: async (E) => {
                                  const D = E.target.checked;
                                  Y(D), localStorage.setItem(ix, String(D));
                                  try {
                                    await Me.updateProject(t, {
                                      audioEnabled: D,
                                    });
                                  } catch (K) {
                                    console.error(
                                      "Failed to save audioEnabled:",
                                      K,
                                    ),
                                      Y(!D),
                                      localStorage.setItem(ix, String(!D));
                                  }
                                },
                                className:
                                  "h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer",
                              }),
                              e.jsx("span", {
                                className: "text-sm text-slate-700 font-medium",
                                children: J ? "Bật" : "Tắt",
                              }),
                            ],
                          }),
                          e.jsx("p", {
                            className: "text-[11px] text-slate-400 mt-1.5",
                            children: J
                              ? "Video có tiếng. Nếu Google lọc audio (nội dung nhạy cảm) thì huỷ luôn video — job FAILED."
                              : "Nếu Google lọc audio thì vẫn nhận video (không tiếng) thay vì mất trắng cả job.",
                          }),
                        ],
                      }),
                    e.jsxs("div", {
                      children: [
                        e.jsx("label", {
                          className:
                            "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                          children: "Luồng upscale ảnh / profile",
                        }),
                        e.jsx("select", {
                          value: er,
                          onChange: async (E) => {
                            const D = Number(E.target.value);
                            Hl(D);
                            try {
                              await Me.updateProject(t, {
                                imageUpscaleConcurrency: D,
                              });
                            } catch (K) {
                              console.error(
                                "Failed to save upscale concurrency:",
                                K,
                              );
                            }
                          },
                          className:
                            "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          children: [1, 2, 3, 4].map((E) =>
                            e.jsxs(
                              "option",
                              { value: E, children: [E, " luồng"] },
                              E,
                            ),
                          ),
                        }),
                        e.jsx("p", {
                          className: "text-[11px] text-slate-400 mt-1.5",
                          children:
                            "1 luồng: an toàn nhất (mặc định). 2-4 luồng: nhanh hơn nhưng tăng risk 403 reCAPTCHA, đặc biệt với 4K (~11MB/response).",
                        }),
                      ],
                    }),
                    e.jsxs("div", {
                      children: [
                        e.jsx("label", {
                          className:
                            "block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5",
                          children: "Ký tự phân tách prompts",
                        }),
                        e.jsxs("select", {
                          value: N,
                          onChange: (E) => C(E.target.value),
                          className:
                            "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          children: [
                            e.jsx("option", {
                              value: "newline",
                              children: "Mỗi dòng = 1 prompt",
                            }),
                            e.jsx("option", {
                              value: "blankline",
                              children: "Dòng trống phân tách",
                            }),
                            e.jsx("option", {
                              value: "separator",
                              children: "===== phân tách",
                            }),
                            e.jsx("option", {
                              value: "custom",
                              children: "Ký tự tùy chỉnh",
                            }),
                          ],
                        }),
                        N === "custom" &&
                          e.jsx("input", {
                            type: "text",
                            value: k,
                            onChange: (E) => j(E.target.value),
                            placeholder: "|||",
                            className:
                              "w-full mt-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500",
                          }),
                      ],
                    }),
                  ],
                }),
                e.jsx("div", {
                  className:
                    "px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl flex justify-end",
                  children: e.jsx("button", {
                    onClick: () => We(!1),
                    className:
                      "px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors",
                    children: "Xong",
                  }),
                }),
              ],
            }),
          }),
        e.jsx(r4, {
          isOpen: au,
          onClose: lu,
          onConfirm: iu,
          message: `Đang có ${Qr} tiến trình đang chạy hoặc chờ xử lý. Bạn có muốn tạm dừng project trước khi rời đi không?`,
        }),
        e.jsx(x0, {
          isOpen: uc,
          title: hc === "start" ? "Sẵn sàng bắt đầu gen?" : "Sẵn sàng tạo job?",
          description:
            hc === "start"
              ? `Sắp queue ${Mt.length} job để chạy. Captcha extension phải hoạt động và tab Flow AI phải mở.`
              : "Sắp tạo job từ prompts. Hệ thống sẽ dùng captcha extension để xác thực với Google Veo3.",
          onCancel: mu,
          onConfirm: hu,
        }),
        et &&
          (() => {
            const E = ri(Jt, Math.max(2, Math.min(50, Math.floor(ot || 5)))),
              D =
                Jt === "size"
                  ? E.batches.filter((te) => te.jobs.length < 2).length
                  : E.batches.filter((te) => te.jobs.length === 0).length,
              K = E.batches.length - D,
              ee = new Set(bt.map((te) => te.batchIndex ?? 0)).size;
            return e.jsx("div", {
              className:
                "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4",
              children: e.jsxs("div", {
                className:
                  "bg-white rounded-lg shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col",
                children: [
                  e.jsxs("div", {
                    className:
                      "px-5 py-3 border-b border-zinc-200 flex items-center justify-between",
                    children: [
                      e.jsxs("div", {
                        className: "flex items-center gap-2",
                        children: [
                          e.jsx(Sn, { className: "h-4 w-4 text-purple-600" }),
                          e.jsx("h3", {
                            className: "text-sm font-semibold text-zinc-800",
                            children: "Export theo batch",
                          }),
                        ],
                      }),
                      e.jsx("button", {
                        onClick: () => {
                          qt || (gt(!1), En([]), xs({ current: 0, total: 0 }));
                        },
                        disabled: qt,
                        className:
                          "p-1 hover:bg-zinc-100 rounded disabled:opacity-40",
                        title: qt ? "Đang chạy, không thể đóng" : "Đóng",
                        children: e.jsx(tt, {
                          className: "h-4 w-4 text-zinc-500",
                        }),
                      }),
                    ],
                  }),
                  e.jsxs("div", {
                    className: "px-5 py-4 space-y-4 overflow-y-auto",
                    children: [
                      e.jsxs("div", {
                        children: [
                          e.jsx("label", {
                            className:
                              "text-xs font-medium text-zinc-600 block mb-1.5",
                            children: "Cách chia",
                          }),
                          e.jsxs("div", {
                            className: "grid grid-cols-2 gap-2",
                            children: [
                              e.jsxs("button", {
                                type: "button",
                                onClick: () => !qt && nn("size"),
                                disabled: qt,
                                className: `px-3 py-2 text-xs rounded-md border transition-colors text-left disabled:cursor-not-allowed ${Jt === "size" ? "bg-purple-50 border-purple-400 text-purple-800 ring-1 ring-purple-300" : "bg-white border-zinc-300 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"}`,
                                children: [
                                  e.jsx("div", {
                                    className: "font-semibold",
                                    children: "Theo số lượng",
                                  }),
                                  e.jsx("div", {
                                    className:
                                      "text-[10px] text-zinc-500 mt-0.5",
                                    children: "N video mỗi file",
                                  }),
                                ],
                              }),
                              e.jsxs("button", {
                                type: "button",
                                onClick: () => !qt && nn("original"),
                                disabled: qt || ee < 1,
                                className: `px-3 py-2 text-xs rounded-md border transition-colors text-left disabled:cursor-not-allowed ${Jt === "original" ? "bg-purple-50 border-purple-400 text-purple-800 ring-1 ring-purple-300" : "bg-white border-zinc-300 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"}`,
                                title:
                                  ee < 1
                                    ? "Chưa có video hoàn thành"
                                    : `Nhóm theo ${ee} batch "Tạo job" gốc`,
                                children: [
                                  e.jsxs("div", {
                                    className: "font-semibold",
                                    children: ["Theo batch tạo (", ee, ")"],
                                  }),
                                  e.jsx("div", {
                                    className:
                                      "text-[10px] text-zinc-500 mt-0.5",
                                    children: 'Mỗi lần "Tạo job" = 1 file',
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                      Jt === "size"
                        ? e.jsxs("div", {
                            children: [
                              e.jsx("label", {
                                className:
                                  "text-xs font-medium text-zinc-600 block mb-1",
                                children: "Số video mỗi file",
                              }),
                              e.jsx("input", {
                                type: "number",
                                min: 2,
                                max: 50,
                                value: ot,
                                disabled: qt,
                                onChange: (te) =>
                                  At(
                                    Math.max(
                                      2,
                                      Math.min(
                                        50,
                                        parseInt(te.target.value, 10) || 5,
                                      ),
                                    ),
                                  ),
                                className:
                                  "w-24 px-2 py-1.5 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:bg-zinc-50",
                              }),
                              e.jsxs("p", {
                                className:
                                  "text-[11px] text-zinc-500 mt-1.5 leading-snug",
                                children: [
                                  "Chia theo khoảng jobIndex: batch 1 gồm job 1-",
                                  ot,
                                  ", batch 2 gồm job ",
                                  ot + 1,
                                  "-",
                                  ot * 2,
                                  "... Job lỗi/chưa xong trong khoảng sẽ bị bỏ qua.",
                                ],
                              }),
                            ],
                          })
                        : e.jsx("div", {
                            className:
                              "bg-zinc-50 border border-zinc-200 rounded px-3 py-2",
                            children: e.jsxs("p", {
                              className:
                                "text-[11px] text-zinc-600 leading-snug",
                              children: [
                                "Ghép theo",
                                " ",
                                e.jsx("span", {
                                  className: "font-semibold",
                                  children: "batch gốc",
                                }),
                                ' — nhóm theo từng lần bạn bấm "Tạo job". Video hoàn thành trong mỗi batch được ghép thành 1 file. Batch chỉ có 1 video sẽ được copy nguyên. Job lỗi/chưa xong bị bỏ qua.',
                              ],
                            }),
                          }),
                      e.jsxs("div", {
                        className: "grid grid-cols-3 gap-2 text-xs",
                        children: [
                          e.jsxs("div", {
                            className:
                              "bg-purple-50 border border-purple-200 rounded-md px-3 py-2",
                            children: [
                              e.jsx("div", {
                                className:
                                  "text-purple-700 font-semibold text-base",
                                children: K,
                              }),
                              e.jsx("div", {
                                className:
                                  "text-purple-600 text-[10px] uppercase tracking-wider",
                                children: "File sẽ tạo",
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className:
                              "bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2",
                            children: [
                              e.jsx("div", {
                                className:
                                  "text-emerald-700 font-semibold text-base",
                                children: E.totalValid,
                              }),
                              e.jsx("div", {
                                className:
                                  "text-emerald-600 text-[10px] uppercase tracking-wider",
                                children: "Video hợp lệ",
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className:
                              "bg-amber-50 border border-amber-200 rounded-md px-3 py-2",
                            children: [
                              e.jsx("div", {
                                className:
                                  "text-amber-700 font-semibold text-base",
                                children: D,
                              }),
                              e.jsx("div", {
                                className:
                                  "text-amber-600 text-[10px] uppercase tracking-wider",
                                children: "Batch sẽ bỏ",
                              }),
                            ],
                          }),
                        ],
                      }),
                      e.jsxs("div", {
                        className:
                          "text-[11px] text-zinc-500 bg-zinc-50 border border-zinc-200 rounded px-2 py-1.5",
                        children: [
                          "Lưu vào:",
                          " ",
                          e.jsx("span", {
                            className: "font-mono text-zinc-700",
                            children: V || "(chưa chọn)",
                          }),
                        ],
                      }),
                      (qt || Ws.length > 0) &&
                        e.jsxs("div", {
                          className: "space-y-2",
                          children: [
                            e.jsxs("div", {
                              className:
                                "flex items-center justify-between text-xs",
                              children: [
                                e.jsxs("span", {
                                  className: "font-medium text-zinc-700",
                                  children: [
                                    "Tiến trình: ",
                                    Ua.current,
                                    "/",
                                    Ua.total,
                                  ],
                                }),
                                qt &&
                                  e.jsx("span", {
                                    className: "text-purple-600 animate-pulse",
                                    children: "Đang ghép...",
                                  }),
                              ],
                            }),
                            e.jsx("div", {
                              className:
                                "w-full h-1.5 bg-zinc-200 rounded-full overflow-hidden",
                              children: e.jsx("div", {
                                className:
                                  "h-full bg-purple-500 transition-all",
                                style: {
                                  width:
                                    Ua.total > 0
                                      ? `${(Ua.current / Ua.total) * 100}%`
                                      : "0%",
                                },
                              }),
                            }),
                            e.jsxs("div", {
                              className:
                                "max-h-48 overflow-y-auto border border-zinc-200 rounded-md divide-y divide-zinc-100 bg-white",
                              children: [
                                Ws.length === 0 &&
                                  e.jsx("div", {
                                    className:
                                      "px-3 py-2 text-[11px] text-zinc-400",
                                    children: "Đang chuẩn bị...",
                                  }),
                                Ws.map((te, le) =>
                                  e.jsxs(
                                    "div",
                                    {
                                      className:
                                        "px-3 py-1.5 text-[11px] flex items-start gap-2",
                                      children: [
                                        e.jsxs("span", {
                                          className: "mt-0.5 flex-shrink-0",
                                          children: [
                                            te.status === "ok" &&
                                              e.jsx(at, {
                                                className:
                                                  "w-3.5 h-3.5 text-emerald-500",
                                              }),
                                            te.status === "skipped" &&
                                              e.jsx(Mn, {
                                                className:
                                                  "w-3.5 h-3.5 text-amber-500",
                                              }),
                                            te.status === "failed" &&
                                              e.jsx(tt, {
                                                className:
                                                  "w-3.5 h-3.5 text-red-500",
                                              }),
                                          ],
                                        }),
                                        e.jsxs("div", {
                                          className: "flex-1 min-w-0",
                                          children: [
                                            e.jsx("div", {
                                              className:
                                                "font-medium text-zinc-700 truncate",
                                              children: te.label,
                                            }),
                                            te.message &&
                                              e.jsx("div", {
                                                className:
                                                  "text-zinc-500 truncate",
                                                children: te.message,
                                              }),
                                          ],
                                        }),
                                      ],
                                    },
                                    le,
                                  ),
                                ),
                              ],
                            }),
                          ],
                        }),
                    ],
                  }),
                  e.jsx("div", {
                    className:
                      "px-5 py-3 border-t border-zinc-200 bg-zinc-50 rounded-b-lg flex justify-end gap-2",
                    children: qt
                      ? e.jsx("button", {
                          onClick: ts,
                          className:
                            "px-4 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md",
                          children: "Hủy (dừng sau batch hiện tại)",
                        })
                      : e.jsxs(e.Fragment, {
                          children: [
                            e.jsx("button", {
                              onClick: () => {
                                gt(!1), En([]), xs({ current: 0, total: 0 });
                              },
                              className:
                                "px-4 py-1.5 text-xs font-medium text-zinc-700 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-md",
                              children: "Đóng",
                            }),
                            e.jsx("button", {
                              onClick: es,
                              disabled: K === 0,
                              className:
                                "px-4 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed",
                              children: Ws.length > 0 ? "Chạy lại" : "Bắt đầu",
                            }),
                          ],
                        }),
                  }),
                ],
              }),
            });
          })(),
      ],
    });
  };
function ox(t, s) {
  return t === s
    ? !0
    : !t || !s
      ? !1
      : t.id === s.id &&
        t.updatedAt === s.updatedAt &&
        t.status === s.status &&
        t.progress === s.progress &&
        t.error === s.error &&
        t.resultUrl === s.resultUrl &&
        t.isUpsampled === s.isUpsampled &&
        t.upsamplingJobId === s.upsamplingJobId &&
        t.downloadedAt === s.downloadedAt &&
        t.lastDownloadError === s.lastDownloadError &&
        t.prompt === s.prompt &&
        t.mode === s.mode &&
        t.jobIndex === s.jobIndex &&
        t.profile?.name === s.profile?.name;
}
const z4 = ({
    job: t,
    projectId: s,
    inputMethod: r,
    onUpdate: l,
    onDelete: o,
  }) => {
    const [c, h] = u.useState(t.prompt || ""),
      [m, f] = u.useState(null),
      [x, b] = u.useState(null),
      [p, v] = u.useState(!1),
      [w, N] = u.useState(!1),
      C = u.useRef(t.prompt || null);
    u.useEffect(() => {
      const S = t.prompt || "",
        _ = C.current || "";
      S !== _ && ((!c || c === _) && h(S), (C.current = S));
    }, [t.prompt, t.id, c]);
    const k = u.useMemo(() => {
      if (!t.referenceImageMediaIds) return [];
      try {
        let S = [];
        if (typeof t.referenceImageMediaIds == "string")
          try {
            let L = JSON.parse(t.referenceImageMediaIds);
            typeof L == "string" && (L = JSON.parse(L)), (S = L);
          } catch (L) {
            console.error("Error parsing mediaIds string:", L), (S = []);
          }
        else
          Array.isArray(t.referenceImageMediaIds) &&
            (S = t.referenceImageMediaIds);
        let _ = [];
        if (t.referenceImagePreviewUrls)
          try {
            if (typeof t.referenceImagePreviewUrls == "string") {
              let L = JSON.parse(t.referenceImagePreviewUrls);
              typeof L == "string" && (L = JSON.parse(L)),
                Array.isArray(L)
                  ? (_ = L)
                  : typeof L == "object" &&
                    L !== null &&
                    (_ = Object.entries(L).map(([z, P]) => ({
                      mediaId: z,
                      previewUrl: P,
                    })));
            } else
              Array.isArray(t.referenceImagePreviewUrls)
                ? (_ = t.referenceImagePreviewUrls)
                : typeof t.referenceImagePreviewUrls == "object" &&
                  t.referenceImagePreviewUrls !== null &&
                  (_ = Object.entries(t.referenceImagePreviewUrls).map(
                    ([L, z]) => ({ mediaId: L, previewUrl: z }),
                  ));
          } catch (L) {
            console.error("Error parsing preview URLs:", L);
          }
        return S.map((L) => {
          const z = _.find((P) => P.mediaId === L);
          return { mediaId: L, preview: z?.previewUrl || "" };
        });
      } catch (S) {
        return console.error("Error parsing reference images:", S), [];
      }
    }, [t.referenceImageMediaIds, t.referenceImagePreviewUrls]);
    u.useEffect(() => {
      t.startImageMediaId &&
        t.startImagePreviewUrl &&
        f(t.startImagePreviewUrl),
        t.endImageMediaId && t.endImagePreviewUrl && b(t.endImagePreviewUrl);
    }, [
      t.startImageMediaId,
      t.endImageMediaId,
      t.startImagePreviewUrl,
      t.endImagePreviewUrl,
    ]);
    const j = (S, _) => {
        const L = document.createElement("input");
        (L.type = "file"), (L.accept = "image/*");
        let z = !1;
        const P = () => {
          setTimeout(() => {
            z || (S === "start" ? v(!1) : S === "end" && N(!1)),
              window.removeEventListener("focus", P);
          }, 300);
        };
        window.addEventListener("focus", P),
          (L.onchange = async (J) => {
            const Y = J.target.files?.[0];
            if (((z = !0), window.removeEventListener("focus", P), !Y)) {
              S === "start" ? v(!1) : S === "end" && N(!1);
              return;
            }
            S === "start" ? v(!0) : S === "end" && N(!0);
            try {
              const F = new FileReader();
              (F.onload = async (W) => {
                try {
                  const $ = (W.target?.result).split(",")[1],
                    G = await Me.uploadImage($, t.profileId, void 0, s);
                  G.success && G.mediaId && G.previewUrl
                    ? S === "start"
                      ? (f(G.previewUrl),
                        v(!1),
                        await l({
                          startImageMediaId: G.mediaId,
                          startImagePreviewUrl: G.previewUrl,
                        }),
                        console.log("✅ Start image uploaded:", G.mediaId))
                      : S === "end" &&
                        (b(G.previewUrl),
                        N(!1),
                        await l({
                          endImageMediaId: G.mediaId,
                          endImagePreviewUrl: G.previewUrl,
                        }),
                        console.log("✅ End image uploaded:", G.mediaId))
                    : (S === "start"
                        ? (f(null), v(!1))
                        : S === "end" && (b(null), N(!1)),
                      alert(G.error || "Upload failed"));
                } catch ($) {
                  console.error("Upload error:", $),
                    alert(`Lỗi upload ảnh: ${$t($)}`),
                    S === "start" ? v(!1) : S === "end" && N(!1);
                }
              }),
                F.readAsDataURL(Y);
            } catch (F) {
              console.error("File read error:", F),
                alert(`Lỗi đọc file: ${$t(F)}`),
                S === "start" ? v(!1) : S === "end" && N(!1);
            }
          }),
          L.click();
      },
      A = (S, _) => {
        p ||
          w ||
          (S === "start" ? v(!0) : S === "end" && N(!0),
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              j(S);
            });
          }));
      },
      T = async (S, _, L) => {
        if (_)
          try {
            await Me.deleteMedia([_], t.profileId),
              S === "start"
                ? (m && URL.revokeObjectURL(m),
                  f(null),
                  await l({ startImageMediaId: null }))
                : S === "end" &&
                  (x && URL.revokeObjectURL(x),
                  b(null),
                  await l({ endImageMediaId: null }));
          } catch (z) {
            console.error("Delete error:", z), alert(`Lỗi xóa ảnh: ${$t(z)}`);
          }
      },
      M = (S) => {
        switch (S) {
          case "TEXT_TO_VIDEO":
            return "Văn bản";
          case "IMAGE_TO_VIDEO":
            return "Hình ảnh";
          case "REFERENCE_TO_VIDEO":
            return "Các thành phần";
          case "FRAME_TO_FRAME":
            return "Khung hình";
          default:
            return S;
        }
      };
    return e.jsxs("div", {
      className:
        "p-3 hover:bg-slate-50 transition-colors border-l-4 border-l-yellow-400",
      children: [
        e.jsxs("div", {
          className: "flex items-start justify-between mb-2",
          children: [
            e.jsxs("div", {
              className: "flex-1 min-w-0",
              children: [
                e.jsxs("div", {
                  className: "flex items-center gap-2 mb-1 flex-wrap",
                  children: [
                    e.jsxs("span", {
                      className:
                        "inline-flex items-center justify-center rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800",
                      children: ["#", t.jobIndex + 1, " - DRAFT"],
                    }),
                    (() => {
                      const info = typeof formatMangaPromptDisplay === "function" ? formatMangaPromptDisplay(t.prompt) : null;
                      return info?.isManga
                        ? e.jsx("span", {
                            className:
                              "inline-flex items-center rounded bg-teal-100 px-1.5 py-0.5 text-[11px] font-semibold text-teal-800",
                            children: `Manga · ${info.sceneId}`,
                          })
                        : null;
                    })(),
                    e.jsx("span", {
                      className: "text-xs text-slate-500",
                      children: M(t.mode || "TEXT_TO_VIDEO"),
                    }),
                  ],
                }),
                e.jsx(Ir, {
                  value: c,
                  onChange: (S) => {
                    h(S);
                  },
                  onBlur: () => {
                    c !== t.prompt && l({ prompt: c });
                  },
                  className:
                    "w-full text-sm text-slate-900 border border-slate-300 rounded px-2 py-1 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500",
                  rows: 2,
                }),
              ],
            }),
            e.jsx("div", {
              className: "ml-2 flex gap-1",
              children: e.jsx("button", {
                onClick: o,
                className:
                  "p-1 text-slate-600 hover:text-slate-700 hover:bg-slate-100 rounded",
                title: "Xóa",
                children: e.jsx(qs, { className: "h-4 w-4" }),
              }),
            }),
          ],
        }),
        t.mode === "FRAME_TO_FRAME" &&
          r !== "COMPONENTS" &&
          e.jsxs("div", {
            className: "mt-3 space-y-2",
            children: [
              e.jsx("div", {
                className: "text-xs font-medium text-slate-700",
                children: "Khung hình bắt đầu & kết thúc:",
              }),
              e.jsxs("div", {
                className: "flex gap-3",
                children: [
                  e.jsx("div", {
                    className: "relative",
                    children: e.jsxs("div", {
                      onClick: () => !p && !w && A("start"),
                      className:
                        "w-20 h-20 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 transition-colors overflow-hidden relative",
                      children: [
                        (() => {
                          const S = !!(m || t.startImageMediaId),
                            _ = p;
                          return (
                            S &&
                            e.jsxs(e.Fragment, {
                              children: [
                                e.jsx("img", {
                                  src: m || void 0,
                                  alt: "Start",
                                  className: `w-full h-full object-cover ${_ ? "opacity-0" : ""}`,
                                  style: { display: _ ? "none" : "block" },
                                  onError: (L) => {
                                    L.target.style.display = "none";
                                  },
                                }),
                                !p &&
                                  e.jsx("button", {
                                    onClick: (L) => {
                                      L.stopPropagation(),
                                        T("start", t.startImageMediaId || "");
                                    },
                                    className:
                                      "absolute top-0.5 right-0.5 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                    title: "Xóa ảnh",
                                    children: e.jsx(tt, {
                                      className: "h-2.5 w-2.5",
                                    }),
                                  }),
                              ],
                            })
                          );
                        })(),
                        p &&
                          e.jsx("div", {
                            className:
                              "absolute inset-0 bg-indigo-500 bg-opacity-90 flex flex-col items-center justify-center z-[100] pointer-events-none",
                            children: e.jsxs("svg", {
                              className: "animate-spin h-4 w-4 text-white",
                              viewBox: "0 0 24 24",
                              children: [
                                e.jsx("circle", {
                                  className: "opacity-25",
                                  cx: "12",
                                  cy: "12",
                                  r: "10",
                                  stroke: "currentColor",
                                  strokeWidth: "4",
                                  fill: "none",
                                }),
                                e.jsx("path", {
                                  className: "opacity-75",
                                  fill: "currentColor",
                                  d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                }),
                              ],
                            }),
                          }),
                        !p &&
                          !m &&
                          !t.startImageMediaId &&
                          e.jsx("span", {
                            className: "text-[10px] text-slate-400",
                            children: "Start",
                          }),
                      ],
                    }),
                  }),
                  e.jsx("div", {
                    className: "relative",
                    children: e.jsxs("div", {
                      onClick: () => !p && !w && A("end"),
                      className:
                        "w-20 h-20 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 transition-colors overflow-hidden relative",
                      children: [
                        (() => {
                          const S = !!(x || t.endImageMediaId),
                            _ = w;
                          return (
                            S &&
                            e.jsxs(e.Fragment, {
                              children: [
                                e.jsx("img", {
                                  src: x || void 0,
                                  alt: "End",
                                  className: `w-full h-full object-cover ${_ ? "opacity-0" : ""}`,
                                  style: { display: _ ? "none" : "block" },
                                  onError: (L) => {
                                    L.target.style.display = "none";
                                  },
                                }),
                                !w &&
                                  e.jsx("button", {
                                    onClick: (L) => {
                                      L.stopPropagation(),
                                        T("end", t.endImageMediaId || "");
                                    },
                                    className:
                                      "absolute top-0.5 right-0.5 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                                    title: "Xóa ảnh",
                                    children: e.jsx(tt, {
                                      className: "h-2.5 w-2.5",
                                    }),
                                  }),
                              ],
                            })
                          );
                        })(),
                        w &&
                          e.jsx("div", {
                            className:
                              "absolute inset-0 bg-indigo-500 bg-opacity-90 flex flex-col items-center justify-center z-[100] pointer-events-none",
                            children: e.jsxs("svg", {
                              className: "animate-spin h-4 w-4 text-white",
                              viewBox: "0 0 24 24",
                              children: [
                                e.jsx("circle", {
                                  className: "opacity-25",
                                  cx: "12",
                                  cy: "12",
                                  r: "10",
                                  stroke: "currentColor",
                                  strokeWidth: "4",
                                  fill: "none",
                                }),
                                e.jsx("path", {
                                  className: "opacity-75",
                                  fill: "currentColor",
                                  d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                                }),
                              ],
                            }),
                          }),
                        !w &&
                          !x &&
                          !t.endImageMediaId &&
                          e.jsx("span", {
                            className: "text-[10px] text-slate-400",
                            children: "End",
                          }),
                      ],
                    }),
                  }),
                ],
              }),
            ],
          }),
        t.mode === "IMAGE_TO_VIDEO" &&
          r !== "COMPONENTS" &&
          e.jsxs("div", {
            className: "mt-3 space-y-2",
            children: [
              e.jsx("div", {
                className: "text-xs font-medium text-slate-700",
                children: "Ảnh bắt đầu:",
              }),
              e.jsx("div", {
                className: "relative",
                children: e.jsxs("div", {
                  onClick: () => !p && !w && A("start"),
                  className:
                    "w-32 h-32 bg-slate-100 border-2 border-dashed border-slate-300 rounded flex items-center justify-center cursor-pointer hover:border-indigo-400 transition-colors overflow-hidden relative",
                  children: [
                    (m || t.startImageMediaId) &&
                      e.jsxs(e.Fragment, {
                        children: [
                          e.jsx("img", {
                            src: m || void 0,
                            alt: "Start",
                            className: `w-full h-full object-cover ${p ? "opacity-0" : ""}`,
                            style: { display: p ? "none" : "block" },
                            onError: (S) => {
                              S.target.style.display = "none";
                            },
                          }),
                          !p &&
                            e.jsx("button", {
                              onClick: (S) => {
                                S.stopPropagation(),
                                  T("start", t.startImageMediaId || "");
                              },
                              className:
                                "absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm z-10",
                              title: "Xóa ảnh",
                              children: e.jsx(tt, { className: "h-3 w-3" }),
                            }),
                        ],
                      }),
                    p &&
                      e.jsxs("div", {
                        className:
                          "absolute inset-0 bg-indigo-500 bg-opacity-90 flex flex-col items-center justify-center z-[100] pointer-events-none",
                        children: [
                          e.jsxs("svg", {
                            className: "animate-spin h-6 w-6 text-white mb-2",
                            viewBox: "0 0 24 24",
                            children: [
                              e.jsx("circle", {
                                className: "opacity-25",
                                cx: "12",
                                cy: "12",
                                r: "10",
                                stroke: "currentColor",
                                strokeWidth: "4",
                                fill: "none",
                              }),
                              e.jsx("path", {
                                className: "opacity-75",
                                fill: "currentColor",
                                d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                              }),
                            ],
                          }),
                          e.jsx("span", {
                            className: "text-xs text-white font-medium",
                            children: "Đang upload...",
                          }),
                        ],
                      }),
                    !p &&
                      !m &&
                      !t.startImageMediaId &&
                      e.jsx("span", {
                        className: "text-xs text-slate-400",
                        children: "Chọn ảnh bắt đầu",
                      }),
                  ],
                }),
              }),
            ],
          }),
        t.mode === "REFERENCE_TO_VIDEO" &&
          (() => {
            const S = k;
            return e.jsxs("div", {
              className: "mt-3 space-y-2",
              children: [
                e.jsx("div", {
                  className: "text-xs font-medium text-slate-700",
                  children: "Ảnh tham chiếu đã chọn:",
                }),
                e.jsx("div", {
                  className: "flex gap-2",
                  children: S.map((_, L) =>
                    e.jsx(
                      "div",
                      {
                        className: "relative w-12 h-12",
                        children: e.jsxs("div", {
                          className:
                            "w-full h-full bg-slate-100 border border-green-300 rounded overflow-hidden flex items-center justify-center relative",
                          children: [
                            _.preview
                              ? e.jsx("img", {
                                  src: _.preview,
                                  alt: `Reference ${L + 1}`,
                                  className: "w-full h-full object-cover",
                                  onError: (z) => {
                                    console.log(
                                      "❌ Image load error for:",
                                      _.mediaId,
                                    ),
                                      (z.target.style.display = "none");
                                  },
                                })
                              : e.jsx("div", {
                                  className: "text-[8px] text-slate-400",
                                  children: "No preview",
                                }),
                            e.jsx("div", {
                              className:
                                "absolute bottom-0 right-0 bg-green-500 text-white text-[6px] px-0.5 py-0 rounded",
                              children: "✓",
                            }),
                          ],
                        }),
                      },
                      _.mediaId,
                    ),
                  ),
                }),
                S.length === 0 &&
                  e.jsx("div", {
                    className: "text-xs text-red-500 italic",
                    children:
                      "❌ Chưa có ảnh tham chiếu nào được gán cho job này",
                  }),
              ],
            });
          })(),
      ],
    });
  },
  U4 = Nt.memo(
    z4,
    (t, s) =>
      ox(t.job, s.job) &&
      t.projectId === s.projectId &&
      t.inputMethod === s.inputMethod,
  ),
  B4 = ({
    job: t,
    onRetry: s,
    onCancel: r,
    onDelete: l,
    onEdit: o,
    onReuse: c,
    onUpsample: h,
    onPreview: m,
    outputDir: f,
    fileNamingTemplate: x,
    aspectRatio: b,
    canUpsample: p,
    isSelected: v,
    onSelect: w,
    upsampleChild: N,
    onStartEditPrompt: C,
    isPromptEdited: k,
    variant: j = "card",
    autoDownload: A = !1,
    autoUpscale: T = !1,
  }) => {
    const M = j === "list",
      [S, _] = u.useState(!1),
      [savedNow, setSavedNow] = u.useState(!1),
      { ref: L, inView: z } = a4(),
      P = z ? "metadata" : "none",
      J = async () => {
        if (!t.resultUrl && !t.lastDownloadError) {
          alert(
            t.mode === "IMAGE_GENERATION"
              ? "Job chưa có ảnh"
              : "Job chưa có video",
          );
          return;
        }
        if (!f || f.trim() === "") {
          alert("Vui lòng chọn thư mục lưu file trước khi tải");
          return;
        }
        if (
          !(
            T &&
            !t.isUpsampled &&
            !t.parentJobId &&
            t.mode !== "IMAGE_GENERATION" &&
            !confirm(
              "Video này chưa upscale xong — tải bây giờ là bản thường. Vẫn tải?",
            )
          )
        ) {
          _(!0);
          try {
            const I = t.mode === "IMAGE_GENERATION" ? ".jpg" : ".mp4",
              U = Go(x || Mr, t, { aspectRatio: b }, I);
            let V = t.resultUrl;
            if (t.lastDownloadError && !t.downloadedAt) {
              const O = await Me.refreshResultUrl(t.id).catch(() => null);
              if (O?.success && O.freshUrl) {
                if (
                  O.resolution === "original" &&
                  !confirm("Link mới là bản CHƯA upscale (job cũ). Vẫn tải?")
                )
                  return;
                V = O.freshUrl;
              } else if (O?.error === "MEDIA_DELETED") {
                alert(
                  "Không lấy được link mới — media có thể đã bị xóa khỏi Google, hoặc mạng lỗi. Thử lại sau.",
                );
                return;
              } else if (O?.error === "EXPIRED_COOKIES") {
                alert(
                  "Cookie profile đã hết hạn. Vui lòng mở Profiles → Login lại.",
                );
                return;
              }
            }
            if (!V) {
              alert("Chưa lấy được link video — thử lại sau ít phút.");
              return;
            }
            const q = (O) => Me.downloadFile(O, f, U, t.id);
            let X;
            try {
              X = await q(V);
            } catch (O) {
              const H = $t(O);
              if (!H.includes("HTTP 403") && !H.includes("HTTP 404")) throw O;
              const ae = await Me.refreshResultUrl(t.id).catch(() => null);
              if (!ae?.success || !ae.freshUrl) throw O;
              if (
                ae.resolution === "original" &&
                !confirm("Link mới là bản CHƯA upscale (job cũ). Vẫn tải?")
              )
                return;
              X = await q(ae.freshUrl);
            }
            X.success
              ? setSavedNow(!0)
              : alert(
                  `Lỗi tải ${t.mode === "IMAGE_GENERATION" ? "ảnh" : "video"}`,
                );
          } catch (I) {
            console.error("Download error:", I),
              alert(
                `Lỗi tải ${t.mode === "IMAGE_GENERATION" ? "ảnh" : "video"}: ${$t(I)}`,
              );
          } finally {
            _(!1);
          }
        }
      },
      Y = (I) => {
        switch (I) {
          case "COMPLETED":
            return "bg-green-100 text-green-800 border-green-200";
          case "PROCESSING":
            return "bg-blue-100 text-blue-800 border-blue-200";
          case "FAILED":
            return "bg-red-100 text-red-800 border-red-200";
          case "CANCELLED":
            return "bg-slate-100 text-slate-600 border-slate-200";
          default:
            return "bg-slate-100 text-slate-600 border-slate-200";
        }
      },
      F = (I) => {
        switch (I) {
          case "COMPLETED":
            return e.jsx(at, { className: "h-3 w-3 text-green-600" });
          case "PROCESSING":
            return e.jsxs("svg", {
              className: "animate-spin h-3 w-3 text-blue-600",
              viewBox: "0 0 24 24",
              children: [
                e.jsx("circle", {
                  className: "opacity-25",
                  cx: "12",
                  cy: "12",
                  r: "10",
                  stroke: "currentColor",
                  strokeWidth: "4",
                  fill: "none",
                }),
                e.jsx("path", {
                  className: "opacity-75",
                  fill: "currentColor",
                  d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                }),
              ],
            });
          case "FAILED":
            return e.jsx(Mn, { className: "h-3 w-3 text-red-600" });
          case "QUEUED":
            return e.jsx(Ri, { className: "h-3 w-3 text-slate-400" });
          default:
            return null;
        }
      },
      mangaPromptInfo = typeof formatMangaPromptDisplay === "function" ? formatMangaPromptDisplay(t.prompt) : { isManga: false, sceneId: "", cleanPrompt: t.prompt },
      W = e.jsxs("div", {
        className: `text-xs text-slate-900 ${M ? "line-clamp-3" : "line-clamp-2"} cursor-pointer hover:bg-slate-50 rounded px-0.5 ${k ? "border-l-2 border-emerald-400 pl-1" : ""}`,
        onClick: () => C?.(),
        title: "Click để sửa prompt",
        children: [
          mangaPromptInfo.isManga &&
            e.jsx("span", {
              className:
                "inline-block mr-1 rounded bg-teal-100 px-1 py-0 text-[10px] font-semibold text-teal-800",
              children: mangaPromptInfo.sceneId,
            }),
          mangaPromptInfo.cleanPrompt,
        ],
      }),
      $ = e.jsxs("div", {
        className: `flex gap-0.5 flex-shrink-0 ${M ? "flex-wrap items-start justify-end" : ""}`,
        children: [
          t.status === "COMPLETED" &&
            (t.resultUrl || t.lastDownloadError) &&
            (() => {
              const I = t.lastDownloadError === "URL_PENDING",
                U = !!t.lastDownloadError && !t.downloadedAt && !savedNow,
                V = !!t.downloadedAt || savedNow,
                q = S
                  ? "text-indigo-400 cursor-wait"
                  : U
                    ? "text-red-500 hover:text-red-600 hover:bg-red-50"
                    : V
                      ? "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                      : "text-green-600 hover:text-green-700 hover:bg-green-50",
                X = I
                  ? "Lấy lại link (video đã gen xong)"
                  : U
                    ? "Tải lại (link có thể hết hạn – sẽ làm mới tự động)"
                    : V
                      ? "Đã lưu – bấm để tải lại"
                      : "Tải về";
              return e.jsx("button", {
                onClick: J,
                disabled: S,
                className: `p-0.5 rounded ${q}`,
                title: X,
                "aria-label": X,
                children: S
                  ? e.jsx(Fe, { className: "h-3 w-3 motion-safe:animate-spin" })
                  : U
                    ? e.jsx(Fe, { className: "h-3 w-3" })
                    : e.jsx(_y, { className: "h-3 w-3" }),
              });
            })(),
          p &&
            h &&
            e.jsx(Xy, {
              onSelect: (I) => h(t, I),
              options: Yy(t) ? ["2K", "4K"] : ["1080P", "4K"],
            }),
          t.status === "COMPLETED" &&
            t.mode === "IMAGE_GENERATION" &&
            t.resultUrl &&
            o &&
            e.jsx("button", {
              onClick: () => o(t),
              className:
                "p-0.5 text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded",
              title: "Sửa ảnh",
              children: e.jsx(m0, { className: "h-3 w-3" }),
            }),
          t.status === "COMPLETED" &&
            t.resultUrl &&
            c &&
            e.jsx("button", {
              onClick: () => c(t),
              className:
                "p-0.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded",
              title: "Sử dụng lại",
              children: e.jsx(Cd, { className: "h-3 w-3" }),
            }),
          (t.status === "FAILED" || t.status === "COMPLETED") &&
            e.jsx("button", {
              onClick: s,
              className:
                "p-0.5 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded",
              title: "Gen lại",
              children: e.jsx(Fe, { className: "h-3 w-3" }),
            }),
          (t.status === "QUEUED" || t.status === "PROCESSING") &&
            e.jsx("button", {
              onClick: r,
              className:
                "p-0.5 text-red-600 hover:text-red-700 hover:bg-red-50 rounded",
              title: "Cancel",
              children: e.jsx(tt, { className: "h-3 w-3" }),
            }),
          (t.status === "COMPLETED" ||
            t.status === "FAILED" ||
            t.status === "CANCELLED") &&
            e.jsx("button", {
              onClick: l,
              className:
                "p-0.5 text-slate-600 hover:text-slate-700 hover:bg-slate-100 rounded",
              title: "Delete",
              children: e.jsx(qs, { className: "h-3 w-3" }),
            }),
        ],
      }),
      G = e.jsxs(e.Fragment, {
        children: [
          t.status === "PROCESSING" &&
            t.progress > 0 &&
            e.jsxs("div", {
              className: "flex items-center gap-1.5 mt-1",
              children: [
                e.jsx("div", {
                  className:
                    "flex-1 bg-slate-200 rounded-full h-1 overflow-hidden",
                  children: e.jsx("div", {
                    className: "bg-blue-600 h-full transition-all duration-300",
                    style: { width: `${t.progress}%` },
                  }),
                }),
                e.jsxs("span", {
                  className: "text-[10px] text-slate-500 w-8 text-right",
                  children: [t.progress, "%"],
                }),
              ],
            }),
          t.status === "PROCESSING" &&
            t.progress >= 95 &&
            e.jsx("p", {
              className: "text-[9px] text-slate-400 italic mt-0.5",
              children: "Đang lấy link video…",
            }),
          t.status !== "PROCESSING" &&
            e.jsxs("div", {
              className: "mt-1",
              children: [
                e.jsxs("div", {
                  className: `inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${Y(t.status)}`,
                  children: [
                    F(t.status),
                    e.jsx("span", {
                      className: "truncate",
                      children: t.status,
                    }),
                  ],
                }),
                t.status === "COMPLETED" &&
                  (A || t.downloadedAt || t.lastDownloadError) &&
                  e.jsx("span", {
                    className: "ml-1",
                    children: e.jsx(R4, {
                      downloadedAt: t.downloadedAt,
                      lastDownloadError: t.lastDownloadError,
                      autoDownload: A,
                    }),
                  }),
                t.status === "QUEUED" &&
                  t.error &&
                  (() => {
                    const I = t.error.startsWith(wd)
                        ? wd
                        : t.error.startsWith(wi)
                          ? wi
                          : null,
                      U =
                        !!I ||
                        t.error.includes("DAILY_QUOTA") ||
                        t.error.includes("hết quota") ||
                        t.error.includes("hết hạn"),
                      V =
                        t.error.startsWith("RATE_LIMIT_RETRY:") ||
                        t.error.startsWith("RETRY:") ||
                        t.error.includes("Rate limited") ||
                        t.error.includes("Retrying after") ||
                        t.error.includes("429") ||
                        t.error.includes("HIGH_TRAFFIC");
                    if (t.error.startsWith(lx))
                      return e.jsx("div", {
                        className:
                          "mt-1 text-[10px] rounded px-2 py-1 bg-orange-50 border border-orange-200",
                        children: e.jsxs("div", {
                          className:
                            "flex items-center gap-1 text-orange-700 font-medium",
                          children: [
                            e.jsx(Ri, {
                              className: "h-3 w-3 flex-shrink-0",
                              "aria-hidden": "true",
                            }),
                            e.jsx("span", {
                              children: "Veo3 quá tải — đang tạm dừng",
                            }),
                          ],
                        }),
                      });
                    if (U) {
                      const X = I ? t.error.slice(I.length).trim() : void 0;
                      return e.jsxs("div", {
                        className:
                          "mt-1 text-[10px] rounded px-2 py-1 bg-indigo-50 border border-indigo-200",
                        children: [
                          e.jsxs("div", {
                            className:
                              "font-medium flex items-center gap-1 text-indigo-700",
                            children: [
                              e.jsx(_i, {
                                className: "h-3 w-3 flex-shrink-0",
                                "aria-hidden": "true",
                              }),
                              I === wi
                                ? "Cần nâng cấp tài khoản Veo3"
                                : "Hết quota ngày Veo3",
                            ],
                          }),
                          e.jsx("div", {
                            className: "mt-0.5 text-indigo-600",
                            children:
                              X ??
                              "Profile đã hết quota ngày của Veo3. Chờ ~24h để reset.",
                          }),
                        ],
                      });
                    }
                    return V
                      ? e.jsx("div", {
                          className:
                            "mt-1 text-[10px] rounded px-2 py-1 text-blue-600 bg-blue-50 border border-blue-200",
                          children: e.jsxs("div", {
                            className: "flex items-center gap-1",
                            children: [
                              e.jsx(Fe, {
                                className: "h-3 w-3 flex-shrink-0 animate-spin",
                              }),
                              e.jsx("span", { children: "Đang chờ xử lý..." }),
                            ],
                          }),
                        })
                      : e.jsx("div", {
                          className:
                            "mt-1 text-[10px] rounded px-2 py-1 text-red-600 bg-red-50 border border-red-200",
                          children: e.jsxs("div", {
                            className: "space-y-0.5",
                            children: [
                              e.jsx("div", {
                                className: "font-medium",
                                children: "Lỗi:",
                              }),
                              e.jsx("span", {
                                className: "line-clamp-2",
                                children: t.error,
                              }),
                            ],
                          }),
                        });
                  })(),
                t.status === "FAILED" &&
                  t.error &&
                  (() => {
                    const I = t.error.startsWith(wd)
                        ? wd
                        : t.error.startsWith(wi)
                          ? wi
                          : null,
                      U =
                        !!I ||
                        t.error.includes("DAILY_QUOTA") ||
                        t.error.includes("hết quota") ||
                        t.error.includes("hết hạn"),
                      V =
                        t.error.includes("Rate limited") ||
                        t.error.includes("429") ||
                        t.error.includes("HIGH_TRAFFIC") ||
                        t.error.startsWith("RATE_LIMIT_RETRY:");
                    if (t.error.startsWith(lx)) return null;
                    if (t.error.startsWith("FLOW_VERIFICATION_REQUIRED:") ||
                        /PUBLIC_ERROR_UNUSUAL_ACTIVITY(?![A-Z_])|reCAPTCHA evaluation failed/.test(t.error)) {
                      return e.jsxs("div", {
                        className: "mt-1 text-[10px] bg-amber-50 border border-amber-200 rounded px-2 py-1.5",
                        children: [
                          e.jsx("div", { className: "font-medium text-amber-800", children: "Cần xác minh trên Google Flow" }),
                          e.jsx("div", { className: "text-amber-700", children: "Google từ chối xác minh reCAPTCHA (403). Mở Google Flow, kiểm tra đăng nhập và hoàn tất xác minh nếu được yêu cầu, sau đó bấm Gen lại." }),
                        ],
                      });
                    }
                    if (U) {
                      const q = I ? t.error.slice(I.length).trim() : void 0;
                      return e.jsxs("div", {
                        className:
                          "mt-1 text-[10px] bg-indigo-50 border border-indigo-200 rounded px-2 py-1.5",
                        children: [
                          e.jsxs("div", {
                            className:
                              "text-indigo-700 font-medium mb-0.5 flex items-center gap-1",
                            children: [
                              e.jsx(_i, {
                                className: "h-3 w-3 flex-shrink-0",
                                "aria-hidden": "true",
                              }),
                              I === wi
                                ? "Cần nâng cấp tài khoản Veo3"
                                : "Hết quota ngày Veo3",
                            ],
                          }),
                          e.jsx("div", {
                            className: "text-indigo-600",
                            children:
                              q ??
                              "Profile đã hết quota ngày của Veo3. Gen tự dừng, chờ ~24h để reset.",
                          }),
                        ],
                      });
                    }
                    return V
                      ? null
                      : e.jsxs("div", {
                          className:
                            "mt-1 text-[10px] bg-red-50 border border-red-200 rounded px-2 py-1.5",
                          children: [
                            e.jsx("div", {
                              className: "text-red-700 font-medium mb-0.5",
                              children: "Lỗi generation",
                            }),
                            e.jsx("div", {
                              className: "text-red-600 line-clamp-2",
                              children: t.error,
                            }),
                            e.jsx("div", {
                              className: "text-red-500 mt-1 italic",
                              children: "Hãy sửa prompt/ảnh và bấm Gen lại",
                            }),
                          ],
                        });
                  })(),
              ],
            }),
        ],
      });
    if (M) {
      const I = t.status === "COMPLETED" && t.resultUrl ? t.resultUrl : null;
      return e.jsxs("div", {
        className: `flex gap-2 p-2 hover:bg-slate-50 transition-colors rounded border ${v ? "border-indigo-500 ring-1 ring-indigo-500 bg-indigo-50/10" : "border-slate-200 bg-white"}`,
        children: [
          w &&
            e.jsx("div", {
              className: "flex-shrink-0 flex items-start pt-0.5",
              onClick: (U) => {
                U.stopPropagation(), w();
              },
              children: e.jsx("input", {
                type: "checkbox",
                checked: v || !1,
                onChange: () => {},
                className:
                  "h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer",
              }),
            }),
          e.jsxs("div", {
            className:
              "flex-shrink-0 w-40 aspect-video rounded overflow-hidden bg-slate-900 relative group",
            children: [
              I
                ? t.mode === "IMAGE_GENERATION"
                  ? e.jsxs(e.Fragment, {
                      children: [
                        e.jsx("img", {
                          src: I,
                          alt: "Generated image",
                          className: "w-full h-full object-contain",
                          loading: "lazy",
                          decoding: "async",
                          onError: (U) => {
                            U.target.style.display = "none";
                          },
                        }),
                        e.jsx("button", {
                          onClick: () => m?.({ url: I ?? "", type: "image" }),
                          className:
                            "absolute top-1.5 right-1.5 p-1 bg-black/50 hover:bg-black/70 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity z-20",
                          title: "Xem ảnh lớn",
                          children: e.jsx(yd, { className: "h-3 w-3" }),
                        }),
                      ],
                    })
                  : e.jsxs(e.Fragment, {
                      children: [
                        e.jsx("video", {
                          ref: L,
                          src: I,
                          className: "w-full h-full object-contain",
                          controls: !0,
                          preload: P,
                        }),
                        e.jsx("button", {
                          onClick: () => m?.({ url: I ?? "", type: "video" }),
                          className:
                            "absolute top-1.5 right-1.5 p-1 bg-black/50 hover:bg-black/70 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity z-20",
                          title: "Xem video lớn",
                          children: e.jsx(yd, { className: "h-3 w-3" }),
                        }),
                      ],
                    })
                : e.jsx("div", {
                    className:
                      "w-full h-full flex items-center justify-center text-slate-500",
                    children: e.jsx(Mn, { className: "h-6 w-6" }),
                  }),
              ((N && N.status === "COMPLETED") || (!N && t.isUpsampled)) &&
                e.jsx("div", {
                  className: "absolute top-1 left-1 z-10",
                  children: e.jsxs("span", {
                    className:
                      "inline-flex items-center gap-0.5 rounded bg-emerald-500 px-1 py-0.5 text-[9px] font-bold text-white shadow-sm",
                    children: [e.jsx(at, { className: "h-2.5 w-2.5" }), "HD"],
                  }),
                }),
              N &&
                (N.status === "QUEUED" || N.status === "PROCESSING") &&
                e.jsx("div", {
                  className:
                    "absolute inset-0 bg-black/40 flex items-center justify-center z-10 pointer-events-none",
                  children: e.jsxs("svg", {
                    className: "animate-spin h-5 w-5 text-white",
                    viewBox: "0 0 24 24",
                    children: [
                      e.jsx("circle", {
                        className: "opacity-25",
                        cx: "12",
                        cy: "12",
                        r: "10",
                        stroke: "currentColor",
                        strokeWidth: "4",
                        fill: "none",
                      }),
                      e.jsx("path", {
                        className: "opacity-75",
                        fill: "currentColor",
                        d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                      }),
                    ],
                  }),
                }),
            ],
          }),
          e.jsxs("div", {
            className: "flex-1 min-w-0 flex flex-col",
            children: [
              e.jsxs("div", {
                className: "flex items-center gap-1.5 mb-1",
                children: [
                  e.jsxs("span", {
                    className:
                      "inline-flex items-center justify-center rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800",
                    children: ["#", t.jobIndex + 1],
                  }),
                  e.jsx("span", {
                    className: "text-[10px] text-slate-500 truncate flex-1",
                    children: t.profile?.name,
                  }),
                ],
              }),
              W,
              G,
            ],
          }),
          e.jsx("div", {
            className: "flex-shrink-0 flex flex-col items-end gap-1",
            children: $,
          }),
        ],
      });
    }
    return e.jsxs("div", {
      className: `p-2 hover:bg-slate-50 transition-colors rounded border ${v ? "border-indigo-500 ring-1 ring-indigo-500 bg-indigo-50/10" : "border-slate-200 bg-white"}`,
      children: [
        w &&
          t.status === "FAILED" &&
          e.jsxs("div", {
            className:
              "flex items-center gap-2 px-2 py-1.5 border-b border-slate-100",
            onClick: (I) => {
              I.stopPropagation(), w();
            },
            children: [
              e.jsx("input", {
                type: "checkbox",
                checked: v || !1,
                onChange: () => {},
                className:
                  "h-3.5 w-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-600 cursor-pointer",
              }),
              e.jsx("span", {
                className: "text-[10px] text-slate-400",
                children: "Chọn để gen lại",
              }),
            ],
          }),
        t.status === "COMPLETED" &&
          t.resultUrl &&
          e.jsxs("div", {
            className:
              "mb-1.5 rounded overflow-hidden bg-slate-900 aspect-video relative group",
            children: [
              w &&
                e.jsx("div", {
                  className: "absolute top-2 left-2 z-20",
                  onClick: (I) => {
                    I.stopPropagation(), w();
                  },
                  children: e.jsx("input", {
                    type: "checkbox",
                    checked: v || !1,
                    onChange: () => {},
                    className:
                      "h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer shadow-sm bg-white",
                  }),
                }),
              t.mode === "IMAGE_GENERATION"
                ? e.jsxs(e.Fragment, {
                    children: [
                      e.jsx("img", {
                        src: t.resultUrl,
                        alt: "Generated image",
                        className: "w-full h-full object-contain",
                        loading: "lazy",
                        decoding: "async",
                        onError: (I) => {
                          I.target.style.display = "none";
                        },
                      }),
                      e.jsx("button", {
                        onClick: () =>
                          m?.({ url: t.resultUrl ?? "", type: "image" }),
                        className:
                          "absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-20",
                        title: "Xem ảnh lớn",
                        children: e.jsx(yd, { className: "h-4 w-4" }),
                      }),
                    ],
                  })
                : e.jsxs(e.Fragment, {
                    children: [
                      e.jsx("video", {
                        ref: L,
                        src: t.resultUrl,
                        className: "w-full h-full object-contain",
                        controls: !0,
                        preload: P,
                        onLoadedMetadata: (I) => {
                          const U = I.target;
                          U.style.transform = "scale(1)";
                        },
                        children:
                          "Your browser does not support the video tag.",
                      }),
                      e.jsx("button", {
                        onClick: () =>
                          m?.({ url: t.resultUrl ?? "", type: "video" }),
                        className:
                          "absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-20",
                        title: "Xem video lớn",
                        children: e.jsx(yd, { className: "h-4 w-4" }),
                      }),
                    ],
                  }),
              N &&
                (N.status === "QUEUED" || N.status === "PROCESSING") &&
                e.jsx("div", {
                  className:
                    "absolute inset-0 bg-black/40 flex items-center justify-center z-10 pointer-events-none",
                  children: e.jsxs("div", {
                    className:
                      "flex flex-col items-center gap-1 bg-black/60 rounded-lg px-3 py-2",
                    children: [
                      e.jsxs("svg", {
                        className: "animate-spin h-5 w-5 text-white",
                        viewBox: "0 0 24 24",
                        children: [
                          e.jsx("circle", {
                            className: "opacity-25",
                            cx: "12",
                            cy: "12",
                            r: "10",
                            stroke: "currentColor",
                            strokeWidth: "4",
                            fill: "none",
                          }),
                          e.jsx("path", {
                            className: "opacity-75",
                            fill: "currentColor",
                            d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
                          }),
                        ],
                      }),
                      e.jsx("span", {
                        className: "text-[10px] text-white font-medium",
                        children:
                          N.status === "QUEUED"
                            ? "Chờ upscale..."
                            : `Đang upscale${N.progress ? ` ${N.progress}%` : "..."}`,
                      }),
                    ],
                  }),
                }),
              ((N && N.status === "COMPLETED") || (!N && t.isUpsampled)) &&
                e.jsx("div", {
                  className: "absolute top-1.5 left-1.5 z-10",
                  children: e.jsxs("span", {
                    className:
                      "inline-flex items-center gap-0.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm",
                    children: [e.jsx(at, { className: "h-2.5 w-2.5" }), "HD"],
                  }),
                }),
              N &&
                N.status === "FAILED" &&
                e.jsx("div", {
                  className: "absolute top-1.5 left-1.5 z-10",
                  children: e.jsxs("span", {
                    className:
                      "inline-flex items-center gap-0.5 rounded bg-red-500 px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm",
                    title: `Upscale lỗi: ${N.error}`,
                    children: [e.jsx(Mn, { className: "h-2.5 w-2.5" }), "HD"],
                  }),
                }),
            ],
          }),
        e.jsxs("div", {
          className: "flex items-start justify-between gap-1 mb-1",
          children: [
            e.jsxs("div", {
              className: "flex-1 min-w-0",
              children: [
                e.jsxs("div", {
                  className: "flex items-center gap-1.5 mb-0.5",
                  children: [
                    e.jsxs("span", {
                      className:
                        "inline-flex items-center justify-center rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800",
                      children: ["#", t.jobIndex + 1],
                    }),
                    e.jsx("span", {
                      className: "text-[10px] text-slate-500 truncate",
                      children: t.profile?.name,
                    }),
                  ],
                }),
                W,
              ],
            }),
            $,
          ],
        }),
        G,
      ],
    });
  },
  V4 = Nt.memo(
    B4,
    (t, s) =>
      ox(t.job, s.job) &&
      ox(t.upsampleChild ?? null, s.upsampleChild ?? null) &&
      t.variant === s.variant &&
      t.outputDir === s.outputDir &&
      t.fileNamingTemplate === s.fileNamingTemplate &&
      t.aspectRatio === s.aspectRatio &&
      t.canUpsample === s.canUpsample &&
      t.isSelected === s.isSelected &&
      t.isPromptEdited === s.isPromptEdited &&
      t.isEditingPrompt === s.isEditingPrompt &&
      t.autoDownload === s.autoDownload &&
      t.autoUpscale === s.autoUpscale &&
      (t.onSelect === void 0) == (s.onSelect === void 0) &&
      (t.onEdit === void 0) == (s.onEdit === void 0) &&
      (t.onReuse === void 0) == (s.onReuse === void 0) &&
      (t.onUpsample === void 0) == (s.onUpsample === void 0) &&
      (t.onPreview === void 0) == (s.onPreview === void 0) &&
      (t.onStartEditPrompt === void 0) == (s.onStartEditPrompt === void 0),
  );
