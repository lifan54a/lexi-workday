/* =====================================================================
   排期台 · 交互逻辑
   每日任务 CRUD + 周聚合 + 周报生成 / 复制 / 打印
   任务数据持久化于云端数据库，本地存储仅作为离线缓存
   ===================================================================== */
(function () {
  "use strict";

  /* -------------------- 常量与存储 -------------------- */
  const STORE_KEY = "paqi_tasks_v1";
  const SYNC_KEY  = "paqi_cloud_sync_v1";
  const THEME_KEY = "paqi_theme";
  const NAME_KEY  = "paqi_name";

  const URGENCY = {
    high:   { label: "高", cls: "high" },
    medium: { label: "中", cls: "medium" },
    low:    { label: "低", cls: "low" },
  };
  const URG_RANK = { high: 0, medium: 1, low: 2 };

  /* 项目配色（Apple 系统色板，按名称稳定哈希分配，跨日历/汇总一致） */
  const PALETTE = ["#007AFF", "#34C759", "#FF9500", "#FF3B30", "#AF52DE",
                   "#5AC8FA", "#FF2D55", "#FFCC00", "#30B0C7", "#5856D6"];
  function projectColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  /* -------------------- 日期工具（本地时区，避免 UTC 偏移） -------------------- */
  const toISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const fromISO = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const getMonday = (d) => {
    const x = new Date(d);
    const day = (x.getDay() + 6) % 7; // 周一=0
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmtHours = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1)) + " 小时";

  /* 任务生命周期状态 + 工期（跨天）支持 */
  const STATUS = {
    todo:  { label: "未开始", cls: "todo" },
    doing: { label: "进行中", cls: "doing" },
    done:  { label: "已完成", cls: "done" },
  };
  // 兼容旧数据（仅有 date 字段）：startDate 缺省用 date，duration 缺省 1 天
  const startDateOf = (t) => t.startDate || t.date || toISO(new Date());
  const endDateOf = (t) => toISO(addDays(fromISO(startDateOf(t)), Math.max(1, t.duration || 1) - 1));
  function timelineEndDateOf(t) {
    const plannedEnd = endDateOf(t);
    const todayISO = toISO(new Date());
    const isActive = Number(t.progress || 0) < 100 && startDateOf(t) <= todayISO;
    return isActive && plannedEnd < todayISO ? todayISO : plannedEnd;
  }
  const spansOn = (t, iso) => iso >= startDateOf(t) && iso <= endDateOf(t);
  function statusOf(t) {
    if (t.progress >= 100) return "done";
    if (toISO(new Date()) < startDateOf(t)) return "todo";
    return "doing";
  }

  /* -------------------- 状态 -------------------- */
  let tasks = load();
  let syncedTasks = [];
  let cloudUpdatedAt = null;
  let selectedDate = new Date();
  let weekBase = getMonday(new Date()); // 当前周周一
  let monthBase = new Date();           // 当前展示月份（任意一天即可）
  let selectedMonthISO = "";            // 月度视图中用户主动定位的日期
  let editingId = null;
  let currentUrgency = "medium";
  const expandedIds = new Set(); // 已展开详情（备注/需求文档）的任务 id

  /* -------------------- DOM 引用 -------------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    dayInput: $("dayInput"), prevDay: $("prevDay"), nextDay: $("nextDay"), todayBtn: $("todayBtn"),
    dayStats: $("dayStats"), taskList: $("taskList"), emptyState: $("emptyState"),
    form: $("taskForm"), editingId: $("editingId"), formTitle: $("modalTitle"),
    project: $("project"), hours: $("hours"), progress: $("progress"), progressOut: $("progressOut"),
    notes: $("notes"), reqDoc: $("reqDoc"), urgency: $("urgency"), reviewDate: $("reviewDate"),
    startDate: $("startDate"), duration: $("duration"),
    submitBtn: $("submitBtn"), cancelEdit: $("cancelEdit"),
    addTaskBtn: $("addTaskBtn"), modal: $("taskModal"), modalClose: $("modalClose"),
    moodEmoji: $("moodEmoji"), moodLabel: $("moodLabel"), moodDesc: $("moodDesc"),
    segs: Array.from(document.querySelectorAll(".seg")),
    weekLabel: $("weekLabel"), prevWeek: $("prevWeek"), nextWeek: $("nextWeek"), thisWeekBtn: $("thisWeekBtn"),
    weekStats: $("weekStats"), projectBreakdown: $("projectBreakdown"), urgencyBreakdown: $("urgencyBreakdown"),
    userName: $("userName"), copyReport: $("copyReport"), printReport: $("printReport"),
    reportText: $("reportText"), toast: $("toast"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    views: { home: $("view-home"), daily: $("view-daily"), weekly: $("view-weekly"), month: $("view-month") },
    prevMonth: $("prevMonth"), nextMonth: $("nextMonth"), thisMonthBtn: $("thisMonthBtn"),
    monthLabel: $("monthLabel"), monthGantt: $("monthGantt"), monthHint: $("monthHint"),
    ganttTooltip: $("ganttTooltip"),
    /* 首页 */
    avatarWrap: $("avatarWrap"), avatarGreet: $("avatarGreet"),
  };

  /* -------------------- 页面动效 -------------------- */
  const motion = window.gsap;
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function animateBasicView(view) {
    if (!motion || reduceMotion()) return;
    const root = els.views[view];
    const targets = view === "home"
      ? root.querySelectorAll(".hero-tag, .hero-typography, .avatar-stage, .hero-role")
      : root.querySelectorAll(".list-panel, .daily-footer");
    if (!targets.length) return;
    motion.killTweensOf(targets);
    motion.fromTo(targets,
      { autoAlpha: 0, y: 16, scale: 0.985, willChange: "transform,opacity" },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.58, stagger: 0.07, ease: "power3.out", clearProps: "transform,opacity,visibility,willChange" });
  }

  function animateDailyTasks() {
    if (!motion || reduceMotion() || !els.views.daily.classList.contains("is-active")) return;
    const cards = els.taskList.querySelectorAll(".task-card");
    const fills = els.taskList.querySelectorAll(".progress-fill");
    if (!cards.length) return;
    motion.killTweensOf([...cards, ...fills]);

    const timeline = motion.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .fromTo(cards,
        { autoAlpha: 0, y: 14, scale: 0.985, willChange: "transform,opacity" },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.46, stagger: 0.075, clearProps: "transform,opacity,visibility,willChange" }, 0)
      .fromTo(fills,
        { scaleX: 0, transformOrigin: "left center", willChange: "transform" },
        { scaleX: 1, duration: 0.72, stagger: 0.075, ease: "power2.out", clearProps: "transform,transformOrigin,willChange" }, 0.14);
  }

  function animateWeeklyView() {
    if (!motion || reduceMotion()) return;
    const root = els.views.weekly;
    const nav = root.querySelector(".week-nav");
    const cards = root.querySelectorAll(".stat-card");
    const panels = root.querySelectorAll(".weekly-cols .panel, .report-panel");
    const rows = root.querySelectorAll(".bd-row");
    const fills = root.querySelectorAll(".bd-fill");
    const targets = [nav, ...cards, ...panels, ...rows, ...fills].filter(Boolean);
    motion.killTweensOf(targets);

    const timeline = motion.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .fromTo(nav, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.35, clearProps: "transform,opacity,visibility" }, 0)
      .fromTo(cards, { autoAlpha: 0, y: 18, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.48, stagger: 0.06, clearProps: "transform,opacity,visibility" }, 0.06)
      .fromTo(panels, { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.52, stagger: 0.08, clearProps: "transform,opacity,visibility" }, 0.14)
      .fromTo(rows, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.035, clearProps: "transform,opacity,visibility" }, 0.22)
      .fromTo(fills,
        { scaleX: 0, transformOrigin: "left center", willChange: "transform" },
        { scaleX: 1, duration: 0.78, stagger: 0.055, ease: "power2.out", clearProps: "transform,transformOrigin,willChange" }, 0.28);
  }

  function animateMonthView() {
    if (!motion || reduceMotion()) return;
    const root = els.views.month;
    const nav = root.querySelector(".month-nav");
    const panel = root.querySelector(".month-gantt-panel");
    const days = root.querySelectorAll(".gantt-day");
    const rows = root.querySelectorAll(".gantt-row");
    const bars = root.querySelectorAll(".gantt-bar");
    const markers = root.querySelectorAll(".gantt-review, .gantt-today, .gantt-selected");
    const targets = [nav, panel, ...days, ...rows, ...bars, ...markers].filter(Boolean);
    motion.killTweensOf(targets);

    const timeline = motion.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .fromTo(nav, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.35, clearProps: "transform,opacity,visibility" }, 0)
      .fromTo(panel, { autoAlpha: 0, y: 18, scale: 0.99 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.52, clearProps: "transform,opacity,visibility" }, 0.05)
      .fromTo(days, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.012, clearProps: "transform,opacity,visibility" }, 0.16)
      .fromTo(rows, { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.055, clearProps: "transform,opacity,visibility" }, 0.2)
      .fromTo(bars,
        { scaleX: 0, transformOrigin: "left center", willChange: "transform" },
        { scaleX: 1, duration: 0.72, stagger: 0.07, ease: "power2.out", clearProps: "transform,transformOrigin,willChange" }, 0.34)
      .fromTo(markers, { autoAlpha: 0, scale: 0.5 }, { autoAlpha: 1, scale: 1, duration: 0.28, stagger: 0.035, clearProps: "transform,opacity,visibility" }, 0.62);
  }

  /* -------------------- 持久化 -------------------- */
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function cacheTasks(nextTasks) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(nextTasks)); } catch {}
  }

  function readSyncMarker() {
    try { return localStorage.getItem(SYNC_KEY) || ""; } catch { return ""; }
  }

  function writeSyncMarker(updatedAt) {
    try { localStorage.setItem(SYNC_KEY, updatedAt || new Date().toISOString()); } catch {}
  }

  function redirectToLogin() {
    window.location.replace("/login");
  }

  async function cloudRequest(options = {}) {
    const response = await fetch("/api/tasks", {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
    });
    if (response.status === 401) {
      redirectToLogin();
      throw new Error("unauthorized");
    }
    if (response.status === 409) {
      const state = await response.json();
      const error = new Error("conflict");
      error.cloudState = state;
      throw error;
    }
    if (!response.ok) throw new Error(`cloud unavailable (${response.status})`);
    return response.json();
  }

  let syncQueue = Promise.resolve();

  function cloneTasks(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sameTask(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function mergeConcurrentChanges(baseTasks, localTasks, remoteTasks) {
    const base = new Map(baseTasks.map((task) => [task.id, task]));
    const local = new Map(localTasks.map((task) => [task.id, task]));
    const remote = new Map(remoteTasks.map((task) => [task.id, task]));
    const merged = new Map();
    let createdConflictCopy = false;

    new Set([...base.keys(), ...local.keys(), ...remote.keys()]).forEach((id) => {
      const before = base.get(id);
      const localTask = local.get(id);
      const remoteTask = remote.get(id);
      const localChanged = !sameTask(localTask, before);
      const remoteChanged = !sameTask(remoteTask, before);

      if (!localChanged) {
        if (remoteTask) merged.set(id, remoteTask);
      } else if (!remoteChanged || sameTask(localTask, remoteTask)) {
        if (localTask) merged.set(id, localTask);
      } else if (!localTask) {
        // 远端已编辑而本机删除：保留远端版本，避免静默丢失对方修改。
        if (remoteTask) merged.set(id, remoteTask);
      } else if (!remoteTask) {
        // 远端删除而本机编辑：保留仍包含用户工作的本机版本。
        merged.set(id, localTask);
      } else {
        merged.set(id, remoteTask);
        const conflictId = uid();
        merged.set(conflictId, {
          ...localTask,
          id: conflictId,
          createdAt: Date.now(),
          project: `${localTask.project}（本机冲突副本）`.slice(0, 60),
        });
        createdConflictCopy = true;
      }
    });

    return { tasks: Array.from(merged.values()), createdConflictCopy };
  }

  function syncTasks(nextTasks, { announce = false } = {}) {
    const snapshot = cloneTasks(nextTasks);
    syncQueue = syncQueue
      .catch(() => {})
      .then(async () => {
        let tasksToSave = snapshot;
        let data;
        try {
          data = await cloudRequest({
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tasks: tasksToSave, expectedUpdatedAt: cloudUpdatedAt }),
          });
        } catch (error) {
          const remote = error.cloudState;
          if (error.message !== "conflict" || !Array.isArray(remote?.tasks)) throw error;
          const merged = mergeConcurrentChanges(syncedTasks, snapshot, remote.tasks);
          tasksToSave = merged.tasks;
          cloudUpdatedAt = remote.updatedAt ?? null;
          data = await cloudRequest({
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tasks: tasksToSave, expectedUpdatedAt: cloudUpdatedAt }),
          });
          if (sameTask(tasks, snapshot)) {
            tasks = cloneTasks(tasksToSave);
            cacheTasks(tasks);
            renderDaily();
          }
          toast(merged.createdConflictCopy
            ? "检测到同时编辑，已保留本机冲突副本"
            : "检测到其他设备更新，已安全合并");
        }
        cloudUpdatedAt = data.updatedAt ?? null;
        syncedTasks = cloneTasks(tasksToSave);
        writeSyncMarker(data.updatedAt);
        if (announce) toast("本机任务已安全同步到云端");
        return data;
      })
      .catch((error) => {
        if (error.message !== "unauthorized") {
          toast("云端同步失败，数据仍安全保存在本机");
        }
        return null;
      });
    return syncQueue;
  }

  function save() {
    cacheTasks(tasks);
    syncTasks(tasks);
  }

  async function loadCloudTasks() {
    try {
      const bootstrap = window.__lexiCloudTasksPromise;
      const data = bootstrap ? await bootstrap : await cloudRequest();
      if (!Array.isArray(data.tasks)) throw new Error("invalid cloud data");

      const cloudTasks = data.tasks;
      const localTasks = tasks.slice();
      cloudUpdatedAt = data.updatedAt ?? null;
      syncedTasks = cloneTasks(cloudTasks);
      const needsLegacyMigration = localTasks.length > 0 && !readSyncMarker();

      if (needsLegacyMigration) {
        const merged = new Map(cloudTasks.map((task) => [task.id, task]));
        localTasks.forEach((task) => merged.set(task.id, task));
        tasks = Array.from(merged.values());
        cacheTasks(tasks);
        renderDaily();
        await syncTasks(tasks, { announce: true });
        return;
      }

      tasks = cloudTasks;
      syncedTasks = cloneTasks(cloudTasks);
      cacheTasks(tasks);
      if (data.updatedAt) writeSyncMarker(data.updatedAt);
      renderDaily();
    } catch {
      if (e.message !== "unauthorized") {
        toast("当前使用本机缓存，恢复连接后可继续同步");
      }
    }
  }

  async function refreshCloudTasks(renderView) {
    try {
      // 先等待本机尚未完成的保存，避免刚编辑的数据被较旧的云端结果覆盖。
      await syncQueue;
      const data = await cloudRequest();
      if (!Array.isArray(data.tasks)) throw new Error("invalid cloud data");

      tasks = data.tasks;
      syncedTasks = cloneTasks(data.tasks);
      cloudUpdatedAt = data.updatedAt ?? null;
      cacheTasks(tasks);
      if (data.updatedAt) writeSyncMarker(data.updatedAt);
    } catch {
      if (e.message !== "unauthorized") {
        toast("最新数据刷新失败，已显示本机缓存");
      }
    }
    renderView();
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* -------------------- 通用工具 -------------------- */
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const avg = (arr, f) => (arr.length ? sum(arr, f) / arr.length : 0);
  const tasksOn = (iso) => {
    // 当日看板上的任务：
    // 1) 原定工期覆盖当天（spansOn）；或
    // 2) 任务未完成（progress < 100）且开始日及之后 —— 即延续罗列，直至完成
    return tasks.filter((t) => startDateOf(t) <= iso && (spansOn(t, iso) || t.progress < 100));
  };

  function tasksInRange(mondayISO, sundayISO) {
    return tasks
      .filter((t) => endDateOf(t) >= mondayISO && startDateOf(t) <= sundayISO)
      .sort((a, b) => (startDateOf(a) < startDateOf(b) ? -1 : startDateOf(a) > startDateOf(b) ? 1 : 0));
  }

  /* 每日任务排序：紧急程度 > Deadline（早者优先，无日期置后） > 增加时间（新者靠前） */
  function sortDaily(arr) {
    const NO_REVIEW = "9999-99-99";
    return arr.slice().sort((a, b) => {
      // 已完成（进度=100%）整体置底，未完成在前
      const ad = (a.progress || 0) >= 100 ? 1 : 0;
      const bd = (b.progress || 0) >= 100 ? 1 : 0;
      if (ad !== bd) return ad - bd;
      const ru = URG_RANK[a.urgency] - URG_RANK[b.urgency];
      if (ru !== 0) return ru;
      const ra = a.reviewDate || NO_REVIEW;
      const rb = b.reviewDate || NO_REVIEW;
      if (ra !== rb) return ra < rb ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  /* ============================================================
     每日视图
     ============================================================ */
  function updateMood() {
    if (!els.moodEmoji) return; // 忙闲表情组件已移除，安全跳过
    const todayISO = toISO(new Date());
    const todayTasks = tasksOn(todayISO);
    const n = todayTasks.length;
    let mood;
    if (n === 0) {
      mood = { emoji: "🌿", label: "今日空闲", desc: "暂无待办" };
    } else {
      const pts = todayTasks.reduce((s, t) => s + (t.urgency === "high" ? 3 : t.urgency === "medium" ? 2 : 1), 0);
      const score = pts + Math.floor(n / 2);
      if (score <= 3) mood = { emoji: "🙂", label: "比较轻松", desc: "节奏舒适" };
      else if (score <= 6) mood = { emoji: "😊", label: "安排适中", desc: "满满当当" };
      else if (score <= 10) mood = { emoji: "😅", label: "有点忙碌", desc: "注意劳逸结合" };
      else mood = { emoji: "🔥", label: "非常忙碌", desc: "优先高优任务" };
    }
    els.moodEmoji.textContent = mood.emoji;
    els.moodLabel.textContent = mood.label;
    els.moodDesc.textContent = mood.desc;
  }

  function renderDaily() {
    const iso = toISO(selectedDate);
    els.dayInput.value = iso;
    if (!editingId) { els.startDate.value = iso; } // 新增时默认从当天开始

    const dayTasks = sortDaily(tasksOn(iso));

    // 统计（统计当日看板上的全部任务）
    const avgP = Math.round(avg(dayTasks, (t) => t.progress));
    // 今日 Deadline：截止日期正好等于当天（含顺延罗列进来的任务）
    const deadlineN = dayTasks.filter((t) => t.reviewDate === iso).length;
    els.dayStats.innerHTML = `
      <div class="stat-chip"><div class="v">${dayTasks.length}</div><div class="k">任务数</div></div>
      <div class="stat-chip"><div class="v">${deadlineN}</div><div class="k">今日 Deadline 任务数量</div></div>
      <div class="stat-chip"><div class="v">${dayTasks.length ? avgP : 0}<small>%</small></div><div class="k">平均进度</div></div>
    `;

    // 列表
    if (dayTasks.length === 0) {
      els.taskList.innerHTML = "";
      els.emptyState.hidden = false;
      return;
    }
    els.emptyState.hidden = true;
    els.taskList.innerHTML = dayTasks.map((t) => taskCardHTML(t)).join("");
    updateMood();
    animateDailyTasks();
  }

  function taskCardHTML(t) {
    const u = URGENCY[t.urgency];
    const st = STATUS[statusOf(t)];
    const grey = st.cls === "done" ? " is-done" : "";
    const s = startDateOf(t), e = endDateOf(t);
    const rangeTxt = s === e ? fmtMD(s) : `${fmtMD(s)}–${fmtMD(e)}`;

    const hasNotes = !!t.notes;
    const hasReq = !!t.reqDoc;
    const safeReqDoc = hasReq ? safeExternalLink(t.reqDoc) : "";
    const hasDetail = hasNotes || hasReq;
    const expanded = expandedIds.has(t.id);

    const detail = hasDetail
      ? `<div class="task-detail"${expanded ? "" : " hidden"}>`
        + (hasNotes ? `<p class="task-notes"><span class="dn">备注</span>${escapeHTML(t.notes)}</p>` : "")
        + (safeReqDoc
          ? `<p class="task-req"><span class="dn">需求文档</span><a href="${escapeHTML(safeReqDoc)}" target="_blank" rel="noopener noreferrer">${escapeHTML(t.reqDoc)}</a></p>`
          : hasReq ? `<p class="task-req"><span class="dn">需求文档</span>${escapeHTML(t.reqDoc)}（链接不可用）</p>` : "")
        + `</div>`
      : "";

    const toggle = hasDetail
      ? `<button class="task-toggle${expanded ? " is-open" : ""}" type="button" data-act="toggle" aria-expanded="${expanded}" aria-label="${expanded ? "收起详情" : "展开详情"}">`
        + `<span class="tt-text">${expanded ? "收起" : "展开"}</span>`
        + `<svg class="tt-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`
        + `</button>`
      : "";

    return `
      <article class="task-card${grey}" data-id="${escapeHTML(t.id)}">
        <div class="task-main">
          <div class="task-top">
            <span class="task-name">${escapeHTML(t.project)}</span>
            <span class="badge ${u.cls}">${u.label}</span>
            <span class="status ${st.cls}">${st.label}</span>
          </div>
          <div class="task-meta">
            <span>耗时 <b>${t.hours}h</b></span>
            <span>进度 <b>${t.progress}%</b></span>
            <span>工期 <b>${rangeTxt}</b></span>
            ${reviewBadge(t)}
          </div>
          <div class="progress-track"><div class="progress-fill${grey}" role="progressbar" aria-label="${escapeHTML(t.project)}任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${t.progress}" style="width:${t.progress}%"></div></div>
          ${toggle}
          ${detail}
        </div>
        <div class="task-actions">
          <button class="mini-btn" data-act="edit" title="编辑" aria-label="编辑 ${escapeHTML(t.project)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
          <button class="mini-btn danger" data-act="del" title="删除" aria-label="删除 ${escapeHTML(t.project)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </article>`;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function safeExternalLink(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }
  function fmtMD(iso) {
    const parts = String(iso).split("-");
    return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
  }
  function reviewBadge(t) {
    if (!t.reviewDate) return "";
    const todayISO = toISO(new Date());
    if (t.progress >= 100) return `<span class="rev done">已交付</span>`;
    if (t.reviewDate < todayISO) return `<span class="rev overdue">逾期 ${fmtMD(t.reviewDate)}</span>`;
    if (t.reviewDate === todayISO) return `<span class="rev due">今天 Deadline</span>`;
    return `<span class="rev">Deadline ${fmtMD(t.reviewDate)}</span>`;
  }

  /* -------------------- 表单：紧急程度分段 -------------------- */
  function setUrgency(u) {
    currentUrgency = u;
    els.urgency.value = u;
    els.segs.forEach((b) => {
      const on = b.dataset.urgency === u;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  els.segs.forEach((b) => b.addEventListener("click", () => setUrgency(b.dataset.urgency)));

  /* -------------------- 进度联动 -------------------- */
  els.progress.addEventListener("input", () => { els.progressOut.textContent = els.progress.value + "%"; });

  /* -------------------- 提交（新增 / 更新） -------------------- */
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const project = els.project.value.trim();
    if (!project) { els.project.focus(); return; }
    const hours = parseFloat(els.hours.value);
    if (isNaN(hours) || hours < 0) { toast("请填写有效的耗时"); els.hours.focus(); return; }
    const reqDoc = els.reqDoc.value.trim();
    if (reqDoc && !safeExternalLink(reqDoc)) {
      toast("需求文档仅支持 http 或 https 链接");
      els.reqDoc.focus();
      return;
    }
    const payload = {
      project,
      urgency: currentUrgency,
      hours: Math.round(hours * 10) / 10,
      progress: parseInt(els.progress.value, 10) || 0,
      reviewDate: els.reviewDate.value || "",
      startDate: els.startDate.value || toISO(selectedDate),
      duration: Math.max(1, parseInt(els.duration.value, 10) || 1),
      notes: els.notes.value.trim(),
      reqDoc,
    };

    if (editingId) {
      const t = tasks.find((x) => x.id === editingId);
      if (t) Object.assign(t, payload);
      save(); toast("已更新任务");
    } else {
      tasks.push({ id: uid(), createdAt: Date.now(), ...payload });
      save(); toast("已添加任务");
    }
    resetForm();
    renderDaily();
    hideModal();
  });

  /* -------------------- 编辑 / 删除（事件委托） -------------------- */
  els.taskList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".task-card");
    const id = card && card.dataset.id;
    if (!id) return;

    if (btn.dataset.act === "del") {
      const t = tasks.find((x) => x.id === id);
      if (t && confirm(`确定删除「${t.project}」？`)) {
        tasks = tasks.filter((x) => x.id !== id);
        save(); renderDaily(); toast("已删除");
      }
    } else if (btn.dataset.act === "edit") {
      startEdit(id);
    } else if (btn.dataset.act === "toggle") {
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      renderDaily();
    }
  });

  function startEdit(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    els.editingId.value = id;
    els.project.value = t.project;
    els.hours.value = t.hours;
    els.progress.value = t.progress;
    els.progressOut.textContent = t.progress + "%";
    els.notes.value = t.notes || "";
    els.reqDoc.value = t.reqDoc || "";
    els.reviewDate.value = t.reviewDate || "";
    els.startDate.value = t.startDate || t.date || "";
    els.duration.value = Math.max(1, t.duration || 1);
    setUrgency(t.urgency);
    els.formTitle.textContent = "编辑任务";
    els.submitBtn.textContent = "保存修改";
    els.cancelEdit.hidden = false;
    showModal();
  }

  function resetForm() {
    editingId = null;
    els.editingId.value = "";
    els.form.reset();
    els.reviewDate.value = "";
    els.reqDoc.value = "";
    els.duration.value = 1;
    els.progress.value = 0;
    els.progressOut.textContent = "0%";
    els.startDate.value = toISO(selectedDate);
    setUrgency("medium");
    els.formTitle.textContent = "新增任务";
    els.submitBtn.textContent = "添加任务";
    els.cancelEdit.hidden = true;
  }
  els.cancelEdit.addEventListener("click", () => { resetForm(); hideModal(); });

  /* -------------------- 弹窗控制 -------------------- */
  let modalScrollY = 0;

  function showModal() {
    modalScrollY = window.scrollY;
    els.modal.hidden = false;
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    document.body.style.top = `-${modalScrollY}px`;
    els.project.focus();
  }

  function hideModal() {
    els.modal.hidden = true;
    document.documentElement.classList.remove("modal-open");
    document.body.classList.remove("modal-open");
    document.body.style.top = "";
    window.scrollTo(0, modalScrollY);
  }
  els.addTaskBtn.addEventListener("click", () => { resetForm(); showModal(); });
  els.modalClose.addEventListener("click", hideModal);
  els.modal.addEventListener("click", (e) => { if (e.target === els.modal) hideModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.modal.hidden) hideModal(); });

  /* -------------------- 日期导航 -------------------- */
  els.dayInput.addEventListener("change", () => {
    if (els.dayInput.value) { selectedDate = fromISO(els.dayInput.value); renderDaily(); }
  });
  els.prevDay.addEventListener("click", () => { selectedDate = addDays(selectedDate, -1); renderDaily(); });
  els.nextDay.addEventListener("click", () => { selectedDate = addDays(selectedDate, 1); renderDaily(); });
  els.todayBtn.addEventListener("click", () => { selectedDate = new Date(); renderDaily(); });

  /* ============================================================
     月度视图（Gantt 横条日历）
     ============================================================ */
  /* 月视图辅助：解析 ISO 的“日” */
  function parseDay(iso) { return parseInt(String(iso).slice(8, 10), 10); }
  function visibleDaysInclusive(startISO, endISO) {
    let count = 0;
    let cursor = fromISO(startISO);
    while (toISO(cursor) <= endISO) {
      count += 1;
      cursor = addDays(cursor, 1);
    }
    return count;
  }

  function ganttCornerHTML() {
    return `<div class="gantt-corner">项目 <span class="g-slash">/</span> 日期</div>`;
  }
  function ganttDayCellsHTML(y, m, daysInMonth, todayInMonth, todayDay, selectedDay, isTodaySelection) {
    const wk = ["日", "一", "二", "三", "四", "五", "六"];
    let out = "";
    for (let d = 1; d <= daysInMonth; d++) {
      const wd = new Date(y, m, d).getDay();
      const isWe = (wd === 0 || wd === 6);
      const isTo = (todayInMonth && d === todayDay);
      const isSelected = d === selectedDay;
      const showSelectedAccent = isSelected && !isTodaySelection;
      const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out += `<button type="button" class="gantt-day${isWe ? " is-weekend" : ""}${isTo ? " is-today" : ""}${showSelectedAccent ? " is-selected" : ""}"`
        + ` data-date="${iso}" aria-label="${m + 1}月${d}日，定位当天任务" aria-pressed="${isSelected ? "true" : "false"}">`
        + `<span class="g-wk">${wk[wd]}</span><span class="g-num">${d}</span></button>`;
    }
    return out;
  }

  /* 统一 Gantt：日历时间线 + 项目工期总览合并为单一视图 */
  function renderMonth(animate = false) {
    const y = monthBase.getFullYear();
    const m = monthBase.getMonth();
    els.monthLabel.textContent = `${y} 年 ${m + 1} 月`;

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();
    const todayInMonth = (today.getFullYear() === y && today.getMonth() === m);
    const todayDay = today.getDate();

    const pad = (n) => String(n).padStart(2, "0");
    const monthStartISO = `${y}-${pad(m + 1)}-01`;
    const monthEndISO = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
    const selectedDay = selectedMonthISO >= monthStartISO && selectedMonthISO <= monthEndISO
      ? parseDay(selectedMonthISO)
      : 0;
    const isTodaySelection = Boolean(selectedDay && selectedMonthISO === toISO(today));

    // 收集当月有交集的任务（去重）
    const seen = new Set();
    const monthTasks = [];
    tasks.forEach((t) => {
      if (seen.has(t.id)) return;
      if (timelineEndDateOf(t) >= monthStartISO && startDateOf(t) <= monthEndISO) {
        seen.add(t.id);
        monthTasks.push(t);
      }
    });

    const headHTML = `<div class="gantt-head gantt-grid">${ganttCornerHTML()}${ganttDayCellsHTML(y, m, daysInMonth, todayInMonth, todayDay, selectedDay, isTodaySelection)}</div>`;

    if (monthTasks.length === 0) {
      els.monthGantt.style.setProperty("--days", daysInMonth);
      els.monthGantt.innerHTML = headHTML
        + `<div class="gantt-empty"><div class="empty-mark" aria-hidden="true">📭</div>`
        + `<p>本月还没有记录，去「每日记录」添加任务吧。</p></div>`;
      els.monthHint.textContent = selectedDay
        ? `已定位 ${m + 1}月${selectedDay}日 · 当天没有任务`
        : "点击日期可定位当天任务；悬停任务可立即查看详情。";
      if (animate) animateMonthView();
      return;
    }

    // 按项目分组
    const projMap = {};
    monthTasks.forEach((t) => { (projMap[t.project] = projMap[t.project] || []).push(t); });
    const projKeys = Object.keys(projMap).sort((a, b) => {
      const sa = projMap[a].map((t) => startDateOf(t) < monthStartISO ? monthStartISO : startDateOf(t)).sort()[0];
      const sb = projMap[b].map((t) => startDateOf(t) < monthStartISO ? monthStartISO : startDateOf(t)).sort()[0];
      return sa.localeCompare(sb);
    });

    const rows = projKeys.map((p) => {
      const arr = projMap[p];
      const c = projectColor(p);
      const monthDays = arr.reduce((n, t) => {
        const visibleStart = startDateOf(t) < monthStartISO ? monthStartISO : startDateOf(t);
        const taskEnd = timelineEndDateOf(t);
        const visibleEnd = taskEnd > monthEndISO ? monthEndISO : taskEnd;
        return n + visibleDaysInclusive(visibleStart, visibleEnd);
      }, 0);

      // 每个任务一条横条，按在月内的起止定位
      const bars = arr.map((t) => {
        const sd = startDateOf(t);
        const plannedEnd = endDateOf(t);
        const ed = timelineEndDateOf(t);
        const visibleStart = sd < monthStartISO ? monthStartISO : sd;
        const visibleEnd = ed > monthEndISO ? monthEndISO : ed;
        const s = parseDay(visibleStart);
        const e = parseDay(visibleEnd);
        const left = (s - 1) / daysInMonth * 100;
        const width = (e - s + 1) / daysInMonth * 100;
        const stKey = statusOf(t);
        const isOnSelectedDay = selectedMonthISO && selectedMonthISO >= sd && selectedMonthISO <= ed;
        const rangeText = ed !== plannedEnd
          ? `${fmtMD(sd)} – ${fmtMD(plannedEnd)}（进行中，已延续至 ${fmtMD(ed)}）`
          : `${fmtMD(sd)} – ${fmtMD(ed)}`;
        const tooltip = `${t.project}\n${rangeText}\n状态：${STATUS[stKey].label}`
          + (t.reviewDate ? ` · Deadline ${fmtMD(t.reviewDate)}` : "");
        const name = width > 9 ? `<span class="gb-name">${escapeHTML(t.project)}</span>` : "";
        return `<div class="gantt-bar is-${stKey}${isOnSelectedDay ? " is-on-selected-day" : ""}"`
          + ` style="left:${left}%;width:${width}%" data-tooltip="${escapeHTML(tooltip)}"`
          + ` aria-label="${escapeHTML(tooltip)}" tabindex="0">${name}</div>`;
      }).join("");

      // Deadline 标记（仅显示在月内者）
      const reviews = arr.filter((t) => t.reviewDate && t.reviewDate >= monthStartISO && t.reviewDate <= monthEndISO)
        .map((t) => {
          const rd = parseDay(t.reviewDate);
          const left = (rd - 0.5) / daysInMonth * 100;
          return `<span class="gantt-review" style="left:${left}%" title="Deadline ${fmtMD(t.reviewDate)}"></span>`;
        }).join("");

      return `<div class="gantt-row gantt-grid">`
        + `<div class="gantt-label"><span class="gl-dot" style="background:${c}"></span>`
        + `<span class="gl-name">${escapeHTML(p)}</span><span class="gl-days">${monthDays}天</span></div>`
        + `<div class="gantt-track">${bars}${reviews}</div></div>`;
    }).join("");

    const todayLine = todayInMonth
      ? `<div class="gantt-today" style="left:calc(var(--label-w) + ${(todayDay - 0.5) / daysInMonth} * (100% - var(--label-w)))"></div>`
      : "";
    const selectedLine = selectedDay && !isTodaySelection
      ? `<div class="gantt-selected" style="left:calc(var(--label-w) + ${(selectedDay - 0.5) / daysInMonth} * (100% - var(--label-w)))"></div>`
      : "";
    const selectedTaskCount = selectedDay
      ? monthTasks.filter((t) => selectedMonthISO >= startDateOf(t) && selectedMonthISO <= timelineEndDateOf(t)).length
      : 0;

    els.monthGantt.style.setProperty("--days", daysInMonth);
    els.monthGantt.innerHTML = headHTML
      + `<div class="gantt-body${selectedDay ? " has-date-selection" : ""}${isTodaySelection ? " is-today-selection" : ""}">${todayLine}${selectedLine}${rows}</div>`;
    els.monthHint.textContent = selectedDay
      ? `已定位 ${m + 1}月${selectedDay}日 · ${selectedTaskCount} 项任务`
      : "点击日期可定位当天任务；悬停任务可立即查看详情。";
    if (animate) animateMonthView();
  }

  els.prevMonth.addEventListener("click", () => { selectedMonthISO = ""; monthBase = new Date(monthBase.getFullYear(), monthBase.getMonth() - 1, 1); renderMonth(true); });
  els.nextMonth.addEventListener("click", () => { selectedMonthISO = ""; monthBase = new Date(monthBase.getFullYear(), monthBase.getMonth() + 1, 1); renderMonth(true); });
  els.thisMonthBtn.addEventListener("click", () => { selectedMonthISO = ""; monthBase = new Date(); renderMonth(true); });

  els.monthGantt.addEventListener("click", (event) => {
    const day = event.target.closest(".gantt-day[data-date]");
    if (!day) return;
    selectedMonthISO = day.dataset.date;
    renderMonth();
  });

  function positionGanttTooltip(clientX, clientY) {
    const tip = els.ganttTooltip;
    const gap = 12;
    tip.style.left = `${clientX + gap}px`;
    tip.style.top = `${clientY + gap}px`;
    const rect = tip.getBoundingClientRect();
    if (rect.right > window.innerWidth - gap) tip.style.left = `${Math.max(gap, clientX - rect.width - gap)}px`;
    if (rect.bottom > window.innerHeight - gap) tip.style.top = `${Math.max(gap, clientY - rect.height - gap)}px`;
  }

  function showGanttTooltip(bar, clientX, clientY) {
    if (!bar?.dataset.tooltip) return;
    els.ganttTooltip.textContent = bar.dataset.tooltip;
    els.ganttTooltip.hidden = false;
    positionGanttTooltip(clientX, clientY);
  }

  function hideGanttTooltip() {
    els.ganttTooltip.hidden = true;
  }

  els.monthGantt.addEventListener("pointerover", (event) => {
    const bar = event.target.closest(".gantt-bar");
    if (bar) showGanttTooltip(bar, event.clientX, event.clientY);
  });
  els.monthGantt.addEventListener("pointermove", (event) => {
    if (!els.ganttTooltip.hidden && event.target.closest(".gantt-bar")) {
      positionGanttTooltip(event.clientX, event.clientY);
    }
  });
  els.monthGantt.addEventListener("pointerout", (event) => {
    const bar = event.target.closest(".gantt-bar");
    if (bar && !bar.contains(event.relatedTarget)) hideGanttTooltip();
  });
  els.monthGantt.addEventListener("focusin", (event) => {
    const bar = event.target.closest(".gantt-bar");
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    showGanttTooltip(bar, rect.left + rect.width / 2, rect.top);
  });
  els.monthGantt.addEventListener("focusout", hideGanttTooltip);

  /* ============================================================
     首页（极简）
     ============================================================ */
  function renderHome() {
    // 首页只展示标题和头像，无需数据渲染
  }


  /* ============================================================
     周报视图
     ============================================================ */
  function renderWeekly(animate = false) {
    const mon = weekBase;
    const sun = addDays(weekBase, 6);
    const monISO = toISO(mon), sunISO = toISO(sun);
    els.weekLabel.textContent = `${monISO} ~ ${sunISO}`;

    const wk = tasksInRange(monISO, sunISO);

    // 统计卡
    const totalH = sum(wk, (t) => t.hours);
    const projects = new Set(wk.map((t) => t.project));
    const avgP = Math.round(avg(wk, (t) => t.progress));
    const highN = wk.filter((t) => t.urgency === "high").length;
    els.weekStats.innerHTML = `
      <div class="stat-card"><div class="v">${totalH}</div><div class="k">总投入工时（h）</div></div>
      <div class="stat-card"><div class="v">${projects.size}</div><div class="k">参与项目数</div></div>
      <div class="stat-card"><div class="v">${wk.length ? avgP : 0}<small>%</small></div><div class="k">平均进度</div></div>
      <div class="stat-card"><div class="v">${highN}</div><div class="k">高优先级任务</div></div>
    `;

    // 按项目汇总
    const byProject = {};
    wk.forEach((t) => {
      (byProject[t.project] = byProject[t.project] || []).push(t);
    });
    const projKeys = Object.keys(byProject).sort((a, b) => sum(byProject[b], (t) => t.hours) - sum(byProject[a], (t) => t.hours));
    els.projectBreakdown.innerHTML = projKeys.length
      ? projKeys.map((p) => {
          const arr = byProject[p];
          const h = sum(arr, (t) => t.hours);
          const pr = Math.round(avg(arr, (t) => t.progress));
          return `
            <div class="bd-row">
              <div class="bd-top"><span class="bd-name">${escapeHTML(p)}</span>
                <span class="bd-val">${h}h · ${arr.length} 项 · 进度 ${pr}%</span></div>
              <div class="bd-bar"><div class="bd-fill progress" role="progressbar" aria-label="${escapeHTML(p)}平均进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pr}" style="width:${pr}%"></div></div>
            </div>`;
        }).join("")
      : `<p class="empty-sub" style="padding:var(--s4) 0">本周暂无数据。</p>`;

    // 优先级分布
    const counts = { high: 0, medium: 0, low: 0 };
    wk.forEach((t) => counts[t.urgency]++);
    const order = ["high", "medium", "low"];
    els.urgencyBreakdown.innerHTML = wk.length
      ? order.map((u) => {
          const n = counts[u];
          const pct = Math.round((n / wk.length) * 100);
          return `
            <div class="bd-row">
              <div class="bd-top"><span class="bd-name">${URGENCY[u].label}优先级</span>
                <span class="bd-val">${n} 项 · ${pct}%</span></div>
              <div class="bd-bar"><div class="bd-fill u-${u}" role="progressbar" aria-label="${URGENCY[u].label}优先级任务占比" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" style="width:${pct}%"></div></div>
            </div>`;
        }).join("")
      : `<p class="empty-sub" style="padding:var(--s4) 0">本周暂无数据。</p>`;

    // 周报文本
    els.reportText.textContent = buildReport(mon, sun, wk, els.userName.value.trim());
    if (animate) animateWeeklyView();
  }

  function buildReport(mon, sun, wk, name) {
    if (wk.length === 0) return "本周还没有记录，去「每日记录」添加任务吧。";
    const monISO = toISO(mon), sunISO = toISO(sun);
    const totalH = sum(wk, (t) => t.hours);
    const projects = new Set(wk.map((t) => t.project));
    const avgP = Math.round(avg(wk, (t) => t.progress));
    const highN = wk.filter((t) => t.urgency === "high").length;

    const L = [];
    L.push(`工作周报（${monISO} ~ ${sunISO}）`);
    if (name) L.push(`汇报人：${name}`);
    L.push("");
    L.push(`· 总投入工时：${fmtHours(totalH)}`);
    L.push(`· 参与项目：${projects.size} 个`);
    L.push(`· 平均进度：${avgP}%`);
    L.push(`· 高优先级任务：${highN} 项`);
    L.push("");
    L.push("一、按项目汇总");
    const byProject = {};
    wk.forEach((t) => (byProject[t.project] = byProject[t.project] || []).push(t));
    Object.keys(byProject)
      .sort((a, b) => sum(byProject[b], (t) => t.hours) - sum(byProject[a], (t) => t.hours))
      .forEach((p) => {
        const arr = byProject[p];
        const h = sum(arr, (t) => t.hours);
        const pr = Math.round(avg(arr, (t) => t.progress));
        L.push(`  - ${p}：工时 ${fmtHours(h)}，平均进度 ${pr}%，任务 ${arr.length} 项`);
      });
    L.push("");
    L.push("二、重点事项（高 / 中优先级）");
    const key = wk.filter((t) => t.urgency !== "low").sort((a, b) => URG_RANK[a.urgency] - URG_RANK[b.urgency] || startDateOf(a).localeCompare(startDateOf(b)));
    if (key.length === 0) L.push("  （无）");
    key.forEach((t) => {
      const s = startDateOf(t), e = endDateOf(t);
      const span = s === e ? fmtMD(s) : `${fmtMD(s)}–${fmtMD(e)}`;
      L.push(`  - [${URGENCY[t.urgency].label}] ${t.project}（${span}）进度 ${t.progress}%`);
      if (t.notes) L.push(`      备注：${t.notes}`);
    });
    L.push("");
    L.push("四、待 Deadline 事项");
    const rev = wk.filter((t) => t.reviewDate).sort((a, b) => a.reviewDate.localeCompare(b.reviewDate));
    if (rev.length === 0) L.push("  （无）");
    rev.forEach((t) => {
      const tag = t.progress >= 100 ? "已交付" : fmtMD(t.reviewDate);
      L.push(`  - ${t.project}：${tag}`);
    });
    L.push("");
    L.push("三、说明");
    L.push("  以上数据由「排期台」依据每日记录自动汇总生成。");
    return L.join("\n");
  }

  /* -------------------- 周导航 -------------------- */
  els.prevWeek.addEventListener("click", () => { weekBase = addDays(weekBase, -7); renderWeekly(true); });
  els.nextWeek.addEventListener("click", () => { weekBase = addDays(weekBase, 7); renderWeekly(true); });
  els.thisWeekBtn.addEventListener("click", () => { weekBase = getMonday(new Date()); renderWeekly(true); });
  els.userName.addEventListener("input", () => {
    localStorage.setItem(NAME_KEY, els.userName.value.trim());
    renderWeekly();
  });

  /* -------------------- 复制 / 打印 -------------------- */
  els.copyReport.addEventListener("click", async () => {
    const text = els.reportText.textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("周报已复制到剪贴板");
    } catch {
      // 回退方案
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("周报已复制"); }
      catch { toast("复制失败，请手动选择文本"); }
      document.body.removeChild(ta);
    }
  });
  els.printReport.addEventListener("click", () => window.print());

  /* ============================================================
     视图切换
     ============================================================ */
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      els.tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      Object.entries(els.views).forEach(([k, el]) => {
        const on = k === view;
        el.classList.toggle("is-active", on);
        el.hidden = !on;
      });
      if (view === "weekly") {
        renderWeekly(false);
        void refreshCloudTasks(() => renderWeekly(true));
      } else if (view === "month") {
        renderMonth(false);
        void refreshCloudTasks(() => renderMonth(true));
      }
      else if (view === "daily") { renderDaily(); animateBasicView("daily"); }
      else { renderHome(); animateBasicView("home"); }
    });
  });

  /* ============================================================
     主题
     ============================================================ */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }
  (function initTheme() {
    let theme = "light";
    try { theme = localStorage.getItem(THEME_KEY) || "light"; } catch {}
    applyTheme(theme);
  })();
  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });

  /* ============================================================
     初始化
     ============================================================ */
  /* 头像悬停时随机显示的原创「答案之书」风格短句 */
  const greetTexts = [
    "嗨～今天也要加油哦！💪",
    "你好呀 Lexi 👋 今天想做什么？",
    "欢迎回来！🌟 继续冲鸭～",
    "又见面啦 😊 记得喝水哦 💧",
    "Lexi 准备好啦，开始记录吧 📝",
    "答案正在靠近。",
    "大胆一点，会有惊喜。",
    "先完成，再完美。",
    "现在正是好时机。",
    "相信你的第一感觉。",
    "再等一等，线索会出现。",
    "今天适合迈出第一步。",
    "把复杂的事拆小一点。",
    "你已经知道答案了。",
    "去做那件让你眼睛发亮的事。",
    "不必急着得出结论。",
    "允许计划发生一点变化。",
    "答案是肯定的。",
    "换个角度再看一次。",
    "先照顾好自己的节奏。",
    "这次值得认真尝试。",
    "顺其自然，保持行动。",
    "别忽略那个小小的信号。",
    "今天会比想象中顺利。",
    "把注意力放回当下。",
    "你的坚持正在积累结果。",
    "先问问自己真正想要什么。",
    "不妨说出你的想法。",
    "一个小决定会带来新方向。",
    "暂时放下，答案会更清晰。",
    "继续，你走在正确的路上。",
    "给它一点时间。",
    "这件事没有你想得那么难。",
    "选择让你更自由的那个。",
    "可以拒绝，也可以重新选择。",
    "今天适合整理和告别。",
    "好消息藏在下一步里。",
    "先从最重要的一件事开始。",
    "你的直觉值得被听见。",
    "慢一点也没关系。",
    "会有人愿意帮助你。",
    "保持好奇，别急着定义。",
    "尝试一个从未用过的方法。",
    "这一次，优先相信自己。",
    "把担心写下来，然后行动。",
    "答案可能比问题更简单。",
    "先休息一下，再继续。",
    "你需要的是清晰，而不是更多。",
    "今天适合做出取舍。",
    "让结果自然展开。",
    "一个真诚的对话会有帮助。",
    "不要低估微小的进步。",
    "你比自己以为的更接近目标。",
    "如果犹豫，就先做可逆的选择。",
    "给未知留一点空间。",
    "最好的回应是开始行动。",
    "这件事值得第二次机会。",
    "先完成今天能够完成的部分。",
    "别让完美阻止你出发。",
    "答案会在行动中变得清楚。",
    "向前一步，局面就会不同。",
    "今天，温柔但坚定。",
    "把精力留给真正重要的人和事。",
    "你可以重新开始。",
    "事情正在向好的方向移动。",
    "保持耐心，也保持选择权。",
    "下一次尝试会更接近答案。",
  ];
  let greetIdx = -1;
  function showNextGreeting() {
    const bubble = els.avatarGreet?.querySelector(".greet-bubble");
    if (bubble) {
      let nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * greetTexts.length);
      } while (greetTexts.length > 1 && nextIdx === greetIdx);
      greetIdx = nextIdx;
      bubble.textContent = greetTexts[greetIdx];
    }
  }

  els.avatarWrap?.addEventListener("mouseenter", showNextGreeting, { passive: true });
  let touchGreetingTimer;
  els.avatarWrap?.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    showNextGreeting();
    els.avatarWrap.classList.add("is-greeting-visible");
    window.clearTimeout(touchGreetingTimer);
    touchGreetingTimer = window.setTimeout(() => {
      els.avatarWrap?.classList.remove("is-greeting-visible");
    }, 3500);
  }, { passive: true });

  (function init() {
    try { els.userName.value = localStorage.getItem(NAME_KEY) || ""; } catch {}
    setUrgency("medium");
    renderHome();
    loadCloudTasks();
  })();
})();
