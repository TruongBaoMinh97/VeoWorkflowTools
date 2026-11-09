/* Recovered GenNormal project home from the Veo3Studio renderer. */
const StudioGenHome = ({ onOpenDetail: t, projectSource = "normal" }) => {
    const [s, r] = u.useState([]),
      [l, o] = u.useState(!0),
      [c, h] = u.useState(!1),
      [m, f] = u.useState(null),
      [x, b] = u.useState(!1),
      [p, v] = u.useState(!1),
      w = s.filter((T) => !T.profiles || T.profiles.length === 0).length,
      { setHeaderContent: N } = ms(),
      C = u.useCallback(async () => {
        try {
          const T = await Me.listProjects(projectSource);
          r(T);
        } catch (T) {
          console.error("Failed to load projects:", T);
        } finally {
          o(!1);
        }
      }, [projectSource]),
      k = u.useCallback(async () => {
        if (
          !(x || s.length === 0) &&
          confirm(`Bạn có chắc chắn muốn xóa tất cả ${s.length} project?`)
        )
          try {
            b(!0), await Me.deleteAllProjects(projectSource), await C();
          } catch (T) {
            console.error("Failed to delete all projects:", T),
              alert("Không thể xóa tất cả project");
          } finally {
            b(!1);
          }
      }, [x, s.length, C, projectSource]),
      j = u.useCallback(async () => {
        if (
          !(p || w === 0) &&
          confirm(`Xóa ${w} project không còn profile nào đính kèm?

Những project này không thể chạy job do profile đã bị xóa.`)
        )
          try {
            v(!0);
            const T = await Me.cleanupOrphanProjects(projectSource);
            await C(),
              T.failedIds.length > 0 &&
                alert(
                  `Đã xóa ${T.deletedCount}/${T.orphanIds.length} project orphan. ${T.failedIds.length} project không xóa được.`,
                );
          } catch (T) {
            console.error("Failed to cleanup orphan projects:", T),
              alert("Không thể dọn project orphan");
          } finally {
            v(!1);
          }
      }, [p, w, C, projectSource]);
    u.useEffect(
      () => (
        N(
          e.jsxs("div", {
            className: "flex items-center justify-between w-full",
            children: [
              e.jsxs("div", {
                children: [
                  e.jsx("h1", {
                    className: "text-xl font-semibold text-slate-900",
                    children: projectSource === "studio" ? "Veo3 Gen Studio" : "GenNormal",
                  }),
                  e.jsx("p", {
                    className: "text-xs text-slate-500",
                    children: "Batch video generation từ prompts",
                  }),
                ],
              }),
              e.jsxs("div", {
                className: "flex items-center gap-2",
                children: [
                  w > 0 &&
                    e.jsxs("button", {
                      onClick: j,
                      disabled: p,
                      title: p
                        ? "Đang dọn..."
                        : `Dọn ${w} orphan project (không có profile)`,
                      "aria-label": `Dọn ${w} orphan project`,
                      className:
                        "inline-flex h-7 items-center justify-center gap-1 rounded-full bg-amber-500 px-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50",
                      children: [e.jsx(qs, { className: "h-3.5 w-3.5" }), w],
                    }),
                  e.jsx("button", {
                    onClick: k,
                    disabled: x || s.length === 0,
                    title: x ? "Đang xóa..." : "Xóa tất cả project",
                    "aria-label": "Xóa tất cả project",
                    className:
                      "inline-flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50",
                    children: e.jsx(qs, { className: "h-3.5 w-3.5" }),
                  }),
                  e.jsx("button", {
                    onClick: () => h(!0),
                    title: "Tạo project mới",
                    "aria-label": "Tạo project mới",
                    className:
                      "inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm transition-colors hover:bg-indigo-700",
                    children: e.jsx(Ii, { className: "h-3.5 w-3.5" }),
                  }),
                ],
              }),
            ],
          }),
        ),
        () => N(null)
      ),
      [N, x, s.length, k, j, p, w],
    ),
      u.useEffect(() => {
        C();
        const T = setInterval(C, 5e3);
        return () => clearInterval(T);
      }, [C]);
    const A = async (T) => {
      if (!m && confirm("Bạn có chắc chắn muốn xóa project này?"))
        try {
          f(T), await Me.deleteProject(T), await C();
        } catch (M) {
          console.error("Failed to delete project:", M),
            alert("Không thể xóa project");
        } finally {
          f(null);
        }
    };
    return e.jsxs("div", {
      className: "h-full flex flex-col",
      children: [
        x &&
          e.jsx("div", {
            className:
              "fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm",
            children: e.jsxs("div", {
              className:
                "bg-white rounded-xl shadow-2xl p-8 flex flex-col items-center gap-4 max-w-sm",
              children: [
                e.jsxs("svg", {
                  className: "animate-spin h-10 w-10 text-red-600",
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
                e.jsx("div", {
                  className: "text-lg font-semibold text-slate-900",
                  children: "Đang xóa tất cả project...",
                }),
                e.jsx("p", {
                  className: "text-sm text-slate-500 text-center",
                  children: "Vui lòng chờ, quá trình này có thể mất vài phút.",
                }),
              ],
            }),
          }),
        e.jsx("div", {
          className: "flex-1 overflow-auto p-6",
          children: l
            ? e.jsx("div", {
                className: "flex items-center justify-center h-64",
                children: e.jsx("div", {
                  className: "text-slate-500",
                  children: "Đang tải...",
                }),
              })
            : s.length === 0
              ? e.jsxs("div", {
                  className: "flex flex-col items-center justify-center h-64",
                  children: [
                    e.jsx(As, { className: "h-16 w-16 text-slate-300 mb-4" }),
                    e.jsx("p", {
                      className: "text-slate-500 mb-2",
                      children: "Chưa có project nào",
                    }),
                    e.jsx("button", {
                      onClick: () => h(!0),
                      className:
                        "text-indigo-600 hover:text-indigo-700 text-sm font-medium",
                      children: "Tạo project đầu tiên",
                    }),
                  ],
                })
              : e.jsx("div", {
                  className:
                    "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4",
                  children: s.map((T) =>
                    e.jsxs(
                      "div",
                      {
                        className:
                          "bg-white rounded-lg border border-slate-200 p-4 hover:shadow-md transition-shadow cursor-pointer",
                        onClick: () => t(T.id),
                        children: [
                          e.jsxs("div", {
                            className: "flex items-start justify-between mb-3",
                            children: [
                              e.jsxs("div", {
                                className: "flex-1",
                                children: [
                                  e.jsx("h3", {
                                    className: "font-medium text-slate-900",
                                    children: T.name,
                                  }),
                                  e.jsxs("p", {
                                    className: "mt-1 text-sm text-slate-500",
                                    children: [
                                      T.profiles?.length || 0,
                                      " profiles • ",
                                      T.totalJobs,
                                      " jobs",
                                    ],
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className: "flex gap-2",
                                children: [
                                  e.jsx("button", {
                                    onClick: (M) => {
                                      M.stopPropagation(), t(T.id);
                                    },
                                    className:
                                      "text-indigo-600 hover:text-indigo-700 p-1",
                                    children: e.jsx(ga, {
                                      className: "h-5 w-5",
                                    }),
                                  }),
                                  e.jsx("button", {
                                    onClick: (M) => {
                                      M.stopPropagation(), A(T.id);
                                    },
                                    disabled: m === T.id,
                                    className: `p-1 ${m === T.id ? "text-slate-400 cursor-wait" : "text-red-600 hover:text-red-700"}`,
                                    children: e.jsx(qs, {
                                      className: `h-5 w-5 ${m === T.id ? "animate-pulse" : ""}`,
                                    }),
                                  }),
                                ],
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className: "grid grid-cols-3 gap-2 text-xs",
                            children: [
                              e.jsxs("div", {
                                className: "text-center",
                                children: [
                                  e.jsx("div", {
                                    className:
                                      "text-green-600 font-semibold text-lg",
                                    children: T.completedJobs,
                                  }),
                                  e.jsx("div", {
                                    className: "text-slate-500",
                                    children: "Hoàn thành",
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className: "text-center",
                                children: [
                                  e.jsx("div", {
                                    className:
                                      "text-blue-600 font-semibold text-lg",
                                    children: T.processingJobs,
                                  }),
                                  e.jsx("div", {
                                    className: "text-slate-500",
                                    children: "Đang xử lý",
                                  }),
                                ],
                              }),
                              e.jsxs("div", {
                                className: "text-center",
                                children: [
                                  e.jsx("div", {
                                    className:
                                      "text-red-600 font-semibold text-lg",
                                    children: T.failedJobs,
                                  }),
                                  e.jsx("div", {
                                    className: "text-slate-500",
                                    children: "Thất bại",
                                  }),
                                ],
                              }),
                            ],
                          }),
                          e.jsxs("div", {
                            className: "mt-3 flex items-center justify-between",
                            children: [
                              e.jsx("span", {
                                className: `inline-flex rounded-full px-2 py-1 text-xs font-medium ${T.status === "COMPLETED" ? "bg-green-100 text-green-800" : T.status === "GENERATING" ? "bg-blue-100 text-blue-800" : T.status === "FAILED" ? "bg-red-100 text-red-800" : T.status === "PAUSED" ? "bg-yellow-100 text-yellow-800" : "bg-slate-100 text-slate-800"}`,
                                children: T.status,
                              }),
                              e.jsx("span", {
                                className: "text-xs text-slate-400",
                                children: new Date(
                                  T.createdAt,
                                ).toLocaleDateString("vi-VN"),
                              }),
                            ],
                          }),
                        ],
                      },
                      T.id,
                    ),
                  ),
                }),
        }),
        c &&
          e.jsx(CreateGenProjectDialog, {
            projectSource,
            onClose: () => h(!1),
            onCreated: () => {
              h(!1), C();
            },
          }),
      ],
    });
  },
  CreateGenProjectDialog = ({ onClose: t, onCreated: s, projectSource = "normal" }) => {
    const [r, l] = u.useState(""),
      [o, c] = u.useState([]),
      [h, m] = u.useState([]),
      [f, x] = u.useState(!1),
      [b, p] = u.useState(!0);
    u.useEffect(() => {
      v();
    }, []);
    const v = async () => {
        try {
          const C = await ma.getAll();
          c(C);
        } catch (C) {
          console.error("Failed to load profiles:", C);
        } finally {
          p(!1);
        }
      },
      w = async () => {
        if (!r.trim()) {
          alert("Vui lòng nhập tên project");
          return;
        }
        if (h.length === 0) {
          alert("Vui lòng chọn ít nhất 1 profile");
          return;
        }
        try {
          x(!0);
          const C = await Me.createProject({ name: r.trim(), profileIds: h, source: projectSource });
          console.log("[GenNormal] Project created:", C), s();
        } catch (C) {
          console.error("Failed to create project:", C),
            alert(
              "Không thể tạo project. Vui lòng kiểm tra profiles có cookies/token hợp lệ.",
            );
        } finally {
          x(!1);
        }
      },
      N = (C) => {
        m((k) => (k.includes(C) ? k.filter((j) => j !== C) : [...k, C]));
      };
    return e.jsx("div", {
      className:
        "fixed inset-0 z-50 flex items-center justify-center bg-black/50",
      children: e.jsxs("div", {
        className: "bg-white rounded-lg shadow-xl w-full max-w-md p-6",
        children: [
          e.jsx("h2", {
            className: "text-xl font-semibold text-slate-900 mb-4",
            children: "Tạo Project Mới",
          }),
          e.jsxs("div", {
            className: "space-y-4",
            children: [
              e.jsxs("div", {
                children: [
                  e.jsx("label", {
                    className: "block text-sm font-medium text-slate-700 mb-2",
                    children: "Tên Project",
                  }),
                  e.jsx(Xh, {
                    type: "text",
                    value: r,
                    onChange: (C) => l(C),
                    className:
                      "w-full rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500",
                    placeholder: "Nhập tên project...",
                    autoFocus: !0,
                  }),
                ],
              }),
              e.jsxs("div", {
                children: [
                  e.jsx("label", {
                    className: "block text-sm font-medium text-slate-700 mb-2",
                    children: "Chọn Profiles",
                  }),
                  b
                    ? e.jsx("div", {
                        className: "text-sm text-slate-500",
                        children: "Đang tải profiles...",
                      })
                    : o.length === 0
                      ? e.jsx("div", {
                          className: "text-sm text-red-600",
                          children:
                            "Không có profile nào. Vui lòng tạo profile trước.",
                        })
                      : e.jsx("div", {
                          className:
                            "space-y-2 max-h-48 overflow-auto border border-slate-200 rounded-md p-2",
                          children: o.map((C) =>
                            e.jsxs(
                              "label",
                              {
                                className:
                                  "flex items-center gap-2 p-2 hover:bg-slate-50 rounded cursor-pointer",
                                children: [
                                  e.jsx("input", {
                                    type: "checkbox",
                                    checked: h.includes(C.id),
                                    onChange: () => N(C.id),
                                    className:
                                      "rounded border-slate-300 text-indigo-600 focus:ring-indigo-500",
                                  }),
                                  e.jsx("span", {
                                    className: "text-sm text-slate-700",
                                    children: C.name,
                                  }),
                                ],
                              },
                              C.id,
                            ),
                          ),
                        }),
                  e.jsxs("p", {
                    className: "mt-1 text-xs text-slate-500",
                    children: ["Đã chọn: ", h.length, " profile(s)"],
                  }),
                ],
              }),
            ],
          }),
          e.jsxs("div", {
            className: "mt-6 flex gap-2 justify-end",
            children: [
              e.jsx("button", {
                onClick: t,
                disabled: f,
                className:
                  "px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 disabled:opacity-50",
                children: "Hủy",
              }),
              e.jsxs("button", {
                onClick: w,
                disabled: f || !r.trim() || h.length === 0,
                className:
                  "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed",
                children: [
                  f &&
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
                  f ? "Đang tạo project..." : "Tạo Project",
                ],
              }),
            ],
          }),
          f &&
            e.jsxs("div", {
              className: "mt-3 space-y-2",
              children: [
                e.jsx("div", {
                  className: "text-sm text-slate-600 text-center",
                  children: "Đang tạo project và khởi tạo Veo3 projects...",
                }),
                e.jsxs("div", {
                  className: "text-xs text-slate-500 text-center",
                  children: [
                    "(",
                    h.length,
                    " profile",
                    h.length > 1 ? "s" : "",
                    ")",
                  ],
                }),
              ],
            }),
        ],
      }),
    });
  };
