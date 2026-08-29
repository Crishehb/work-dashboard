/* ============================================================
   工作看板 · 核心逻辑
   数据持久化：localStorage 本地保存 + Supabase 云端同步（可选）
   核心原则：计划调整零负担 —— 拖拽改阶段、单击改优先级、
             双击改标题、内联控件改时间，全部 1~2 步完成
   ============================================================ */

// ---------------- 常量定义 ----------------
const PHASES = [
  { key: 'plan',    name: '规划' },
  { key: 'exec',    name: '执行' },
  { key: 'monitor', name: '监控' },
  { key: 'done',    name: '完成' },
];
const PHASE_NAME = Object.fromEntries(PHASES.map(p => [p.key, p.name]));

const PRIORITIES = ['high', 'mid', 'low'];          // 单击循环切换的顺序
const PRIORITY_NAME = { high: '高', mid: '中', low: '低' };
const PRIORITY_ICON = { high: '🔴', mid: '🟡', low: '🟢' };

const PROJECT_COLORS = ['#4f6ef7', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];

/** 阶段列颜色（看板列头圆点） */
const COL_COLORS = { plan: '#8b5cf6', exec: '#4f6ef7', monitor: '#f59e0b', done: '#22c55e' };

/** 阶段列图标（看板列头小图标） */
const PHASE_ICON = { plan: '📝', exec: '🚀', monitor: '👁️', done: '✅' };

const STORE_KEY = 'workboard_data_v1';
const VIEW_KEY = 'workboard_view_v1';
const TL_SCALE_KEY = 'workboard_tlscale_v1';
const SYNC_KEY = 'workboard_sync_v1';          // 云同步配置 {code, lastSync}
const LOCAL_UPDATED_KEY = 'workboard_updated_v1'; // 本地数据最后更新时间（多设备比新旧用）

// ---------------- 云同步（Supabase）配置 ----------------
// 已接入用户的 Supabase 项目；publishable key 为官方定义的客户端公开密钥，可安全置于前端；
// 数据隔离靠用户自设的同步码（等同密码）
const CLOUD_URL = 'https://euxefuoxiubuvgufjyem.supabase.co';
const CLOUD_KEY = 'sb_publishable_-1dbt8eTvJ5T5C4eHRo3wA_vYAGdOUK';
const CLOUD_TABLE = 'workboard_data';

/** 时间轴粒度：以今天为中心的时间窗口宽度 + 刻度数/格式 */
const TL_SCALES = {
  day:   { spanDays: 14,   ticks: 7,  fmt: d => `${d.getMonth() + 1}/${d.getDate()}` },
  week:  { spanDays: 84,   ticks: 7,  fmt: d => `${d.getMonth() + 1}/${d.getDate()}` },
  month: { spanDays: 366,  ticks: 12, fmt: d => `${d.getFullYear()}/${d.getMonth() + 1}` },
  year:  { spanDays: 1095, ticks: 12, fmt: d => `${d.getFullYear()}` },
};

// ---------------- 全局状态 ----------------
let state = { projects: [], tasks: [] };
let viewMode = 'card';      // card | list
let tlScale = 'month';      // 时间轴粒度：day | week | month | year
// 选择模型：总览随选择变化 —— {type:'all'} | {type:'project',id} | {type:'task',id}
let selection = { type: 'all' };
const expandedProjects = new Set(); // 侧栏中展开任务列表的项目

// ---------------- 工具函数 ----------------
const $ = sel => document.querySelector(sel);

/** 日期 -> yyyy-MM-dd */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() { return fmtDate(new Date()); }

/** 基于今天偏移 offset 天，返回 yyyy-MM-dd */
function offsetDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return fmtDate(d);
}

/** 解析字符串为当天 0 点的 Date */
function parseDate(str) { return new Date(str + 'T00:00:00'); }

/** 相对今天的天数差（正数=未来） */
function daysFromToday(str) {
  if (!str) return Infinity;
  return Math.round((parseDate(str) - parseDate(todayStr())) / 86400000);
}

/** 截止时间的展示文案与状态 */
function dueInfo(due) {
  if (!due) return { text: '无截止', cls: '' };
  const diff = daysFromToday(due);
  const md = due.slice(5).replace('-', '/');
  if (diff < 0)  return { text: `已逾期 ${-diff} 天`, cls: 'overdue' };
  if (diff === 0) return { text: `今天截止 ${md}`, cls: 'soon' };
  if (diff <= 2)  return { text: `${diff} 天后截止`, cls: 'soon' };
  return { text: `截止 ${md}`, cls: '' };
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 十六进制颜色转 rgba（时间轴条形背景用） */
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function getProject(id) { return state.projects.find(p => p.id === id); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 持久化（本地 + 云端） ----------------
let syncConf = (() => {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; }
  catch (e) { return {}; }
})();
let suppressPush = false;  // 采纳云端数据时不回推，避免无谓请求
let pushTimer = null;

/** 同步是否可用：云服务参数 + 用户同步码缺一不可 */
function cloudReady() { return !!(CLOUD_URL && CLOUD_KEY && syncConf.code); }

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  localStorage.setItem(LOCAL_UPDATED_KEY, String(Date.now()));
  scheduleCloudPush();
}

/** 防抖推送：停止操作 1.5 秒后才写云端，避免频繁请求 */
function scheduleCloudPush() {
  if (!cloudReady() || suppressPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => cloudPush().catch(() => {}), 1500);
}

/** 数据结构校验（云端拉回的数据需先验证） */
function isValidState(d) {
  return d && Array.isArray(d.projects) && Array.isArray(d.tasks);
}

/** 数据规范化：无效项目归属转为独立任务，补齐子任务数组与倒计时数组（兼容旧版本数据） */
function normalizeState(data) {
  data.tasks.forEach(t => {
    if (t.projectId && !data.projects.some(p => p.id === t.projectId)) t.projectId = null;
    if (!Array.isArray(t.subtasks)) t.subtasks = [];
  });
  if (!Array.isArray(data.countdowns)) data.countdowns = [];
  return data;
}

function load() {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (isValidState(data)) {
        state = normalizeState(data);
        return;
      }
    } catch (e) { /* 数据损坏时回退到示例数据 */ }
  }
  state = seedData();
  save();
}

/** 首次运行的示例数据（日期相对今天生成，保证演示效果） */
function seedData() {
  const p1 = uid(), p2 = uid(), p3 = uid();
  return {
    projects: [
      { id: p1, name: '官网改版', start: offsetDate(-20), end: offsetDate(15), color: PROJECT_COLORS[0] },
      { id: p2, name: '移动端 App', start: offsetDate(-5), end: offsetDate(40), color: PROJECT_COLORS[1] },
      { id: p3, name: '数据报表平台', start: offsetDate(3), end: offsetDate(25), color: PROJECT_COLORS[2] },
    ],
    tasks: [
      {
        id: uid(), projectId: p1, title: '首页视觉稿评审', priority: 'high', phase: 'exec', due: offsetDate(0), today: true, finished: false,
        subtasks: [
          { id: uid(), title: '收集各方反馈意见', finished: true },
          { id: uid(), title: '输出评审结论并归档', finished: false },
        ],
      },
      { id: uid(), projectId: p1, title: '需求文档终稿确认', priority: 'high', phase: 'done',   due: offsetDate(-2), today: false, finished: true },
      { id: uid(), projectId: p1, title: '前端页面切图开发', priority: 'mid',  phase: 'exec',   due: offsetDate(6), today: true,  finished: false },
      { id: uid(), projectId: p1, title: '上线前兼容性测试', priority: 'mid',  phase: 'plan',   due: offsetDate(12), today: false, finished: false },
      { id: uid(), projectId: p2, title: '登录模块接口联调', priority: 'high', phase: 'exec',   due: offsetDate(-1), today: true,  finished: false },
      { id: uid(), projectId: p2, title: 'UI 走查与问题跟踪', priority: 'low', phase: 'monitor', due: offsetDate(8), today: false, finished: false },
      { id: uid(), projectId: p2, title: '产品原型第二轮评审', priority: 'mid', phase: 'plan',  due: offsetDate(4), today: false, finished: false },
      { id: uid(), projectId: p3, title: '指标口径梳理', priority: 'mid', phase: 'plan', due: offsetDate(5), today: false, finished: false },
      { id: uid(), projectId: p3, title: '数据源接入调研', priority: 'low', phase: 'plan', due: offsetDate(10), today: false, finished: false },
      // 独立任务（单独新建，不属于任何项目）
      { id: uid(), projectId: null, title: '整理本周周报', priority: 'mid', phase: 'exec', due: offsetDate(1), today: false, finished: false },
      { id: uid(), projectId: null, title: '预定团队会议室', priority: 'low', phase: 'plan', due: offsetDate(2), today: false, finished: false },
    ],
    countdowns: [
      { id: uid(), name: '2027 元旦', target: '2027-01-01' },
    ],
  };
}

// ---------------- 选择模型 ----------------
/** 看板/列表展示范围：总览=全部；项目=其下任务；任务=该任务所在分组（项目内或全部独立任务），并高亮自身 */
function visibleTasks() {
  if (selection.type === 'project') return state.tasks.filter(t => t.projectId === selection.id);
  if (selection.type === 'task') {
    const t = getTask(selection.id);
    if (!t) return state.tasks;
    return t.projectId
      ? state.tasks.filter(x => x.projectId === t.projectId)
      : state.tasks.filter(x => !x.projectId);
  }
  return state.tasks;
}

function getTask(id) { return state.tasks.find(t => t.id === id); }

/** 子任务完成进度 */
function subtaskProgress(t) {
  const subs = t.subtasks || [];
  return { done: subs.filter(s => s.finished).length, total: subs.length };
}

function selectedTask() {
  return selection.type === 'task' ? getTask(selection.id) : null;
}

function selectedProject() {
  return selection.type === 'project' ? getProject(selection.id) : null;
}

// ============================================================
//  渲染
// ============================================================
function renderAll() {
  renderHeaderDate();
  renderStats();
  renderCalendar();
  renderSidebar();
  renderTimeline();
  renderToday();
  renderUpcoming();
  renderCountdowns();
  renderBoard();
  renderList();
  renderTaskDetail();
}

function renderHeaderDate() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  $('#todayDate').textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`;
}

/** 数据概览：统计卡片随当前选择（总览/项目/任务）变化 */
function renderStats() {
  const card = (iconCls, icon, num, label, alert, textMode) => `
    <div class="stat-card ${alert ? 'alert' : ''}">
      <div class="stat-icon ${iconCls}">${icon}</div>
      <div><div class="stat-num ${textMode ? 'stat-text' : ''}">${num}</div><div class="stat-label">${label}</div></div>
    </div>`;

  const t = selectedTask();
  const p = selectedProject();

  if (t) {
    // 选中任务：展示该任务的专属概览（剩余时间/子任务/优先级/阶段/归属）
    const sp = subtaskProgress(t);
    const diff = daysFromToday(t.due);
    let dueText, dueAlert = false;
    if (!t.due) { dueText = '无截止'; }
    else if (t.phase === 'done') { dueText = '已完成'; }
    else if (diff < 0) { dueText = `逾期 ${-diff} 天`; dueAlert = true; }
    else if (diff === 0) { dueText = '今天截止'; dueAlert = true; }
    else { dueText = `${diff} 天`;
    }
    const proj = getProject(t.projectId);
    $('#statsRow').innerHTML =
      card('si-overdue', '⏳', dueText, '截止时间', dueAlert, true) +
      card('si-done', '🧩', sp.total ? `${sp.done}/${sp.total}` : '—', '子任务进度', false, true) +
      card('si-today', PRIORITY_ICON[t.priority], PRIORITY_NAME[t.priority], '优先级', t.priority === 'high', true) +
      card('si-active', '🚩', PHASE_NAME[t.phase], '当前阶段', false, true) +
      card('si-total', '📁', proj ? escapeHtml(proj.name) : '独立', '所属项目', false, true);
    return;
  }

  // 总览 / 选中项目：同构统计，范围不同；项目视图额外展示子任务完成度
  const scope = p ? state.tasks.filter(x => x.projectId === p.id) : state.tasks;
  const done = scope.filter(x => x.phase === 'done').length;
  const overdue = scope.filter(x => x.phase !== 'done' && daysFromToday(x.due) < 0).length;
  const todayDue = scope.filter(x => x.phase !== 'done' && daysFromToday(x.due) === 0).length;
  const subs = scope.flatMap(x => x.subtasks || []);
  const subsDone = subs.filter(s => s.finished).length;

  $('#statsRow').innerHTML =
    card('si-total', '📦', scope.length, p ? '项目任务' : '总任务') +
    card('si-active', '🚀', scope.length - done, '进行中') +
    card('si-done', '✅', done, '已完成') +
    (p
      ? card('si-active', '🧩', subs.length ? `${subsDone}/${subs.length}` : '—', '子任务完成', false, true)
      : card('si-today', '⭐', todayDue, '今日截止')) +
    card('si-overdue', '🔥', overdue, '已逾期', overdue > 0);
}

/** 侧栏：项目分组 + 独立任务分组（项目→任务→子任务三级层次） */
function renderSidebar() {
  const ul = $('#projectList');
  // 总览入口 + 项目分组头（右侧“＋”= 新建项目）
  let html = `
    <li class="project-item ${selection.type === 'all' ? 'active' : ''}">
      <div class="project-head" data-sel-all="1">
        <span class="pj-toggle-placeholder"></span>
        <span class="project-dot" style="background:#94a3b8"></span>
        <span class="project-name">📊 总览</span>
        <span class="project-count">${state.tasks.length}</span>
      </div>
    </li>
    <li class="sb-section">
      <span>📁 项目</span>
      <button class="sb-add" data-act="add-project" title="新建项目">＋</button>
    </li>`;

  for (const p of state.projects) {
    const tasks = state.tasks.filter(t => t.projectId === p.id);
    const done = tasks.filter(t => t.phase === 'done').length;
    const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const expanded = expandedProjects.has(p.id);
    html += `
      <li class="project-item ${selection.type === 'project' && selection.id === p.id ? 'active' : ''}">
        <div class="project-head" data-sel-project="${p.id}">
          <button class="pj-toggle" data-toggle="${p.id}" title="展开/收起任务">${expanded ? '▼' : '▶'}</button>
          <span class="project-dot" style="background:${p.color}"></span>
          <span class="project-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <span class="sb-actions">
            <button class="sb-act" data-act="add-task" data-pid="${p.id}" title="在此项目下新建任务">＋</button>
            <button class="sb-act sb-del" data-act="del-project" data-pid="${p.id}" title="删除项目">✕</button>
          </span>
          <span class="project-count">${done}/${tasks.length}</span>
        </div>
        <div class="pj-progress">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        ${expanded ? `<ul class="pj-tasks">${tasks.map(taskRowHtml).join('') ||
          '<li class="pj-task"><span class="pj-task-name" style="color:#b0b8c4">暂无任务，点行尾 ＋ 新建</span></li>'}</ul>` : ''}
      </li>`;
  }

  // 独立任务分组（单独新建的任务显示在这里，右侧“＋”= 新建独立任务）
  const orphans = state.tasks.filter(t => !t.projectId);
  html += `
    <li class="sb-section">
      <span>📌 独立任务</span>
      <button class="sb-add" data-act="add-standalone" title="新建独立任务">＋</button>
    </li>
    <ul class="pj-tasks standalone-list">${orphans.map(taskRowHtml).join('') ||
      '<li class="pj-task"><span class="pj-task-name" style="color:#b0b8c4">暂无，点上方 ＋ 新建</span></li>'}</ul>`;

  ul.innerHTML = html;
}

/** 侧栏任务行（含子任务展开、状态圆点、子任务计数、删除） */
function taskRowHtml(t) {
  const diff = daysFromToday(t.due);
  let dotCls = 'dot-normal';
  if (t.phase === 'done') dotCls = 'dot-done';
  else if (diff < 0) dotCls = 'dot-overdue';
  else if (diff === 0) dotCls = 'dot-today';
  const sp = subtaskProgress(t);
  const expanded = expandedProjects.has(t.id);
  const subHtml = expanded ? `<ul class="sb-subtasks">${(t.subtasks || []).map(s => `
    <li class="sb-subtask ${s.finished ? 'finished' : ''}">
      <span class="pj-dot ${s.finished ? 'dot-done' : 'dot-normal'}"></span>
      <span class="pj-task-name">${escapeHtml(s.title)}</span>
    </li>`).join('') || '<li class="sb-subtask"><span class="pj-task-name" style="color:#b0b8c4">暂无子任务</span></li>'}</ul>` : '';
  return `
    <li class="pj-task ${t.phase === 'done' ? 'finished' : ''} ${selection.type === 'task' && selection.id === t.id ? 'selected' : ''}">
      ${sp.total ? `<button class="pj-toggle" data-toggle="${t.id}" title="展开/收起子任务">${expanded ? '▼' : '▶'}</button>` : '<span class="pj-toggle-placeholder"></span>'}
      <span class="pj-dot ${dotCls}"></span>
      <span class="pj-task-name" data-sel-task="${t.id}" title="点击查看任务概览">${escapeHtml(t.title)}</span>
      ${sp.total ? `<span class="pj-subcount" title="子任务进度">${sp.done}/${sp.total}</span>` : ''}
      <button class="sb-task-del" data-act="del-task" data-tid="${t.id}" title="删除任务">✕</button>
    </li>${subHtml}`;
}

/** 时间轴：甘特图风格，按选择显示（总览=项目条+独立任务里程碑；选中=单条），支持日/周/月/年切换 */
function renderTimeline() {
  const body = $('#timelineBody');
  const cfg = TL_SCALES[tlScale];
  const DAY = 86400000;

  // 同步切换器选中态（粒度持久化）
  document.querySelectorAll('.tl-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.scale === tlScale));

  // 展示行：选中任务/项目时只显示它，总览显示全部项目 + 独立任务
  const selT = selectedTask(), selP = selectedProject();
  let items;
  if (selT) items = [{ kind: 'task', ref: selT }];
  else if (selP) items = [{ kind: 'project', ref: selP }];
  else items = [
    ...state.projects.map(p => ({ kind: 'project', ref: p })),
    ...state.tasks.filter(t => !t.projectId).map(t => ({ kind: 'task', ref: t })),
  ];

  if (!items.length) {
    body.innerHTML = '<div class="empty">暂无时间轴内容，先创建项目或任务</div>';
    $('#timelineRange').textContent = '';
    return;
  }

  // 时间窗口：以今天为中心，宽度由粒度决定；刻度/网格/今天线共用同一坐标系（左 150px 为名称区）
  const today = parseDate(todayStr()).getTime();
  const min = today - cfg.spanDays * DAY / 2;
  const max = today + cfg.spanDays * DAY / 2;
  const span = max - min;
  const frac = t => Math.min(1, Math.max(0, (t - min) / span)); // 超出窗口则夹取到边缘
  const leftOf = f => `calc(150px + (100% - 150px) * ${f.toFixed(4)})`;

  $('#timelineRange').textContent = `${fmtDate(new Date(min))} ~ ${fmtDate(new Date(max))}`;

  // 日期刻度与网格线（按粒度均分）
  let axis = '<div class="tl-axis">', grid = '';
  for (let i = 0; i <= cfg.ticks; i++) {
    const f = i / cfg.ticks;
    axis += `<span class="tl-tick" style="left:${leftOf(f)}">${cfg.fmt(new Date(min + span * f))}</span>`;
    grid += `<div class="tl-gridline" style="left:${leftOf(f)}"></div>`;
  }
  axis += '</div>';

  // 逐行渲染：项目=进度胶囊条，任务=截止日里程碑节点（◆）
  const rows = items.map(({ kind, ref }) => {
    if (kind === 'project') return projectTimelineRow(ref, frac, span, DAY, today);
    return taskTimelineRow(ref, frac, today);
  }).join('');

  const todayLine = `
    <div class="tl-today" style="left:${leftOf(frac(today))}">
      <span class="tl-today-label">今天</span>
    </div>`;

  body.innerHTML = axis + `<div class="tl-canvas">${grid}${rows}${todayLine}</div>`;
}

/** 项目行：起止时间胶囊条，内层填充=任务完成比例 */
function projectTimelineRow(p, frac, span, DAY, today) {
  const s = parseDate(p.start).getTime(), e = parseDate(p.end).getTime();
  const tasks = state.tasks.filter(t => t.projectId === p.id);
  const done = tasks.filter(t => t.phase === 'done').length;
  const pct = tasks.length ? done / tasks.length * 100 : 0;
  const days = Math.round((e - s) / DAY) + 1;
  const isOverdue = e < today && done < tasks.length;
  const left = frac(s) * 100;
  const width = Math.max(frac(e) * 100 - left, 2.5); // 窗口外/过窄时保留最小可见宽度
  return `
    <div class="tl-row ${isOverdue ? 'overdue' : ''}">
      <div class="tl-label">
        <span class="tl-label-dot" style="background:${p.color}"></span>
        <span class="tl-label-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      </div>
      <div class="tl-track">
        <div class="tl-bar" title="${escapeHtml(p.name)}：${done}/${tasks.length} 任务完成"
             style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;
                    background:${hexToRgba(p.color, .13)};border-color:${hexToRgba(p.color, .45)}">
          <div class="tl-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,${hexToRgba(p.color, .65)},${p.color})"></div>
          <span class="tl-bar-text">${days} 天 · ${done}/${tasks.length}
            ${isOverdue ? '<span class="tl-overdue-tag">已逾期</span>' : ''}</span>
        </div>
      </div>
    </div>`;
}

/** 任务行：截止日期的里程碑节点（无截止时提示） */
function taskTimelineRow(t, frac, today) {
  const due = t.due ? parseDate(t.due).getTime() : null;
  const overdue = t.phase !== 'done' && due !== null && due < today;
  const milestone = due !== null
    ? `<div class="tl-milestone ${overdue ? 'overdue' : ''} ${t.phase === 'done' ? 'done' : ''}"
            style="left:${(frac(due) * 100).toFixed(2)}%">
         <span class="tl-milestone-dot">◆</span>
         <span class="tl-milestone-text">${t.due.slice(5).replace('-', '/')}${overdue ? ' 已逾期' : ''}</span>
       </div>`
    : '<span class="tl-milestone-none">未设置截止时间</span>';
  return `
    <div class="tl-row">
      <div class="tl-label">
        <span class="tl-label-dot" style="background:#94a3b8"></span>
        <span class="tl-label-name" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      </div>
      <div class="tl-track">${milestone}</div>
    </div>`;
}

/** 今日待办 */
function renderToday() {
  const list = visibleTasks().filter(t => t.today && t.phase !== 'done')
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  $('#todayCount').textContent = list.length;

  const ul = $('#todayList');
  if (!list.length) {
    ul.innerHTML = '<div class="empty">🎉 今天没有待办事项</div>';
    return;
  }
  ul.innerHTML = list.map(t => {
    const due = dueInfo(t.due);
    return `
      <li class="today-item ${due.cls === 'overdue' ? 'overdue' : ''} ${t.finished ? 'finished' : ''}">
        <input type="checkbox" class="today-check" data-id="${t.id}" ${t.finished ? 'checked' : ''} title="勾选完成">
        <span class="today-title">${PRIORITY_ICON[t.priority]} ${escapeHtml(t.title)}</span>
        <span class="today-due ${due.cls}">${due.text}</span>
      </li>`;
  }).join('');
}

/** 即将到期：未来 7 天内截止的未完成任务 */
function renderUpcoming() {
  const list = visibleTasks()
    .filter(t => {
      if (t.phase === 'done') return false;
      const d = daysFromToday(t.due);
      return d > 0 && d <= 7;
    })
    .sort((a, b) => daysFromToday(a.due) - daysFromToday(b.due));

  const ul = $('#upcomingList');
  if (!list.length) {
    ul.innerHTML = '<div class="empty">未来 7 天没有到期任务</div>';
    return;
  }
  ul.innerHTML = list.map(t => {
    const proj = getProject(t.projectId);
    const d = daysFromToday(t.due);
    return `
      <li class="upcoming-item">
        <span class="project-dot" style="background:${proj ? proj.color : '#94a3b8'}"></span>
        <span class="upcoming-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
        <span class="today-due">${proj ? escapeHtml(proj.name) + ' · ' : ''}${t.due.slice(5).replace('-', '/')}</span>
        <span class="upcoming-days ${d <= 2 ? 'urgent' : ''}">${d} 天后</span>
      </li>`;
  }).join('');
}

/** 卡片视图：按阶段分列的看板 */
function renderBoard() {
  const tasks = visibleTasks();
  const board = $('#board');
  board.innerHTML = PHASES.map(ph => {
    const colTasks = tasks
      .filter(t => t.phase === ph.key)
      .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
    const cards = colTasks.map(t => taskCardHtml(t)).join('');
    return `
      <div class="board-col" data-phase="${ph.key}">
        <div class="col-head">
          <span class="col-dot" style="background:${COL_COLORS[ph.key]}"></span>
          <span>${PHASE_ICON[ph.key]} ${ph.name}</span>
          <span class="col-count">${colTasks.length}</span>
        </div>
        <div class="col-body">${cards || '<div class="empty">拖拽任务到这里</div>'}</div>
      </div>`;
  }).join('');
  bindBoardEvents();
}

function taskCardHtml(t) {
  const proj = getProject(t.projectId);
  const due = dueInfo(t.due);
  const sp = subtaskProgress(t);
  const selCls = (selection.type === 'task' && selection.id === t.id) ? ' selected' : '';
  return `
    <div class="task-card p-${t.priority} ${due.cls === 'overdue' ? 'overdue' : ''}${selCls}" draggable="true" data-id="${t.id}" title="单击卡片查看任务概览">
      <div class="card-top">
        <div class="card-title" title="双击编辑标题">${escapeHtml(t.title)}</div>
        <button class="card-del" data-act="del" title="删除任务">✕</button>
      </div>
      ${t.note ? `<div class="card-note" title="${escapeHtml(t.note)}">${escapeHtml(t.note)}</div>` : ''}
      <div class="card-meta">
        ${proj ? `<span class="tag tag-project">${escapeHtml(proj.name)}</span>` : '<span class="tag tag-project" style="background:#f0f3f9;color:#8a93a5">独立</span>'}
        <button class="tag tag-p-${t.priority}" data-act="priority" title="单击切换优先级">${PRIORITY_NAME[t.priority]}优先级</button>
        ${sp.total ? `<button class="tag tag-sub" data-act="select" title="查看任务概览与子任务">☑ ${sp.done}/${sp.total} 子任务</button>` : ''}
        <button class="tag tag-today ${t.today ? '' : 'off'}" data-act="today" title="加入/移出今日待办">${t.today ? '⭐ 待办' : '☆ 待办'}</button>
        <button class="tag tag-due ${due.cls}" data-act="due" title="单击修改截止时间">${due.text}</button>
      </div>
    </div>`;
}

/** 列表视图：表格 + 内联编辑控件 */
function renderList() {
  const tbody = $('#taskTableBody');
  const tasks = visibleTasks()
    .sort((a, b) =>
      PHASES.findIndex(p => p.key === a.phase) - PHASES.findIndex(p => p.key === b.phase) ||
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));

  if (!tasks.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">暂无任务</div></td></tr>';
    return;
  }

  tbody.innerHTML = tasks.map(t => {
    const proj = getProject(t.projectId);
    const due = dueInfo(t.due);
    const phaseOpts = PHASES.map(p =>
      `<option value="${p.key}" ${t.phase === p.key ? 'selected' : ''}>${p.name}</option>`).join('');
    const prOpts = PRIORITIES.map(p =>
      `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${PRIORITY_ICON[p]} ${PRIORITY_NAME[p]}</option>`).join('');
    return `
      <tr data-id="${t.id}" class="${due.cls === 'overdue' ? 'overdue' : ''}">
        <td><input type="checkbox" class="td-check" data-act="check" ${t.finished ? 'checked' : ''} title="完成"></td>
        <td class="td-title"><input type="text" value="${escapeHtml(t.title)}" data-act="title" maxlength="60" ${t.note ? `title="${escapeHtml(t.note)}"` : ''}></td>
        <td><span class="tag tag-project">${proj ? escapeHtml(proj.name) : '独立'}</span></td>
        <td><select class="sel-mini" data-act="phase">${phaseOpts}</select></td>
        <td><select class="sel-mini" data-act="priority">${prOpts}</select></td>
        <td><input type="date" class="date-input" value="${t.due || ''}" data-act="due"></td>
        <td><button class="td-del" data-act="del" title="删除">✕</button></td>
      </tr>`;
  }).join('');
}

// ============================================================
//  交互事件
// ============================================================

/** 看板列拖拽 + 卡片快捷操作 */
function bindBoardEvents() {
  const board = $('#board');

  // --- 卡片快捷操作（事件委托） ---
  board.onclick = e => {
    const btn = e.target.closest('[data-act]');
    const cardEl = e.target.closest('.task-card');
    if (!cardEl) return;
    const task = state.tasks.find(t => t.id === cardEl.dataset.id);
    if (!task) return;

    // 单击卡片空白处：选中任务（总览跟随切换）；已选中时再点回到其所在分组，点“总览”可回全部
    if (!btn) {
      selection = (selection.type === 'task' && selection.id === task.id)
        ? taskGroupSelection(task)
        : { type: 'task', id: task.id };
      renderAll();
      return;
    }

    if (btn.dataset.act === 'select') {
      selection = { type: 'task', id: task.id };
    } else if (btn.dataset.act === 'del') {
      if (confirm(`确认删除任务「${task.title}」？`)) {
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        if (selection.type === 'task' && selection.id === task.id) selection = taskGroupSelection(task);
      }
    } else if (btn.dataset.act === 'priority') {
      // 单击循环切换：高 → 中 → 低 → 高
      task.priority = PRIORITIES[(PRIORITIES.indexOf(task.priority) + 1) % PRIORITIES.length];
    } else if (btn.dataset.act === 'today') {
      task.today = !task.today;
    } else if (btn.dataset.act === 'due') {
      // 单击弹出日期选择，一步完成改期
      const input = document.createElement('input');
      input.type = 'date';
      input.value = task.due || '';
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        task.due = input.value || '';
        input.remove();
        save(); renderAll();
      });
      input.addEventListener('blur', () => setTimeout(() => input.remove(), 200));
      input.focus();
      input.showPicker && input.showPicker();
      return; // 等待 change 回调统一保存
    }
    save();
    renderAll();
  };

  // --- 双击卡片标题进行内联编辑 ---
  board.ondblclick = e => {
    const titleEl = e.target.closest('.card-title');
    if (!titleEl || titleEl.querySelector('input')) return;
    const card = titleEl.closest('.task-card');
    const task = state.tasks.find(t => t.id === card.dataset.id);
    const input = document.createElement('input');
    input.value = task.title;
    input.maxLength = 60;
    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const v = input.value.trim();
      if (v) task.title = v;
      save(); renderAll();
    };
    input.onblur = commit;
    input.onkeydown = ev => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.onblur = null; renderAll(); }
    };
  };

  // --- HTML5 拖拽：拖动卡片切换阶段 ---
  board.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  board.querySelectorAll('.board-col').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const task = state.tasks.find(t => t.id === e.dataTransfer.getData('text/plain'));
      if (task && task.phase !== col.dataset.phase) {
        task.phase = col.dataset.phase;
        if (task.phase === 'done') task.finished = true;
        save(); renderAll();
      }
    });
  });
}

/** 列表视图：内联控件事件（事件委托） */
function bindListEvents() {
  const tbody = $('#taskTableBody');
  tbody.addEventListener('change', e => {
    const el = e.target;
    const row = el.closest('tr');
    if (!row) return;
    const task = state.tasks.find(t => t.id === row.dataset.id);
    if (!task) return;

    switch (el.dataset.act) {
      case 'check':    task.finished = el.checked;
                       if (el.checked) task.phase = 'done';
                       break;
      case 'phase':    task.phase = el.value;
                       task.finished = el.value === 'done';
                       break;
      case 'priority': task.priority = el.value; break;
      case 'due':      task.due = el.value || ''; break;
    }
    save(); renderAll();
  });

  // 标题失焦即保存
  tbody.addEventListener('focusout', e => {
    if (e.target.dataset.act !== 'title') return;
    const row = e.target.closest('tr');
    const task = state.tasks.find(t => t.id === row.dataset.id);
    const v = e.target.value.trim();
    if (task && v && v !== task.title) {
      task.title = v;
      save(); renderAll();
    }
  });

  tbody.addEventListener('click', e => {
    if (e.target.dataset.act !== 'del') return;
    const row = e.target.closest('tr');
    const task = state.tasks.find(t => t.id === row.dataset.id);
    if (task && confirm(`确认删除任务「${task.title}」？`)) {
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      save(); renderAll();
    }
  });
}

/** 侧栏：总览/项目/任务选择 + 展开收起 + 新建/删除操作 */
function bindSidebarEvents() {
  $('#projectList').addEventListener('click', e => {
    // 展开/收起（项目任务列表 或 任务子任务列表）
    const toggle = e.target.closest('.pj-toggle');
    if (toggle) {
      e.stopPropagation();
      const id = toggle.dataset.toggle;
      if (expandedProjects.has(id)) expandedProjects.delete(id);
      else expandedProjects.add(id);
      renderSidebar();
      return;
    }
    // 新建/删除操作按钮（阻止冒泡，避免误触发选择）
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      switch (act.dataset.act) {
        case 'add-project':    openProjectModal(); break;
        case 'add-task':       openTaskModal(act.dataset.pid); break;
        case 'add-standalone': openTaskModal(null); break;
        case 'del-project':    deleteProject(act.dataset.pid); break;
        case 'del-task':       deleteTask(act.dataset.tid); break;
      }
      return;
    }
    // 选择：任务 → 项目 → 总览（再次点击取消选择回到上级）
    const taskEl = e.target.closest('[data-sel-task]');
    if (taskEl) {
      const id = taskEl.dataset.selTask;
      selection = (selection.type === 'task' && selection.id === id)
        ? taskGroupSelection(getTask(id))
        : { type: 'task', id };
      renderAll();
      return;
    }
    const projEl = e.target.closest('[data-sel-project]');
    if (projEl) {
      const id = projEl.dataset.selProject;
      selection = (selection.type === 'project' && selection.id === id)
        ? { type: 'all' } : { type: 'project', id };
      renderAll();
      return;
    }
    if (e.target.closest('[data-sel-all]')) {
      selection = { type: 'all' };
      renderAll();
    }
  });
}

/** 任务所在分组的默认选择（取消任务选择时回到的层级） */
function taskGroupSelection(t) {
  return t && t.projectId ? { type: 'project', id: t.projectId } : { type: 'all' };
}

/** 删除任务（同步修正当前选择） */
function deleteTask(id) {
  const t = getTask(id);
  if (!t) return;
  const subWarn = (t.subtasks || []).length ? `（含 ${t.subtasks.length} 个子任务）` : '';
  if (!confirm(`确认删除任务「${t.title}」${subWarn}？`)) return;
  state.tasks = state.tasks.filter(x => x.id !== id);
  if (selection.type === 'task' && selection.id === id) selection = taskGroupSelection(t);
  save(); renderAll();
}

/** 删除项目：连同其下任务一起删除（不再移入独立任务） */
function deleteProject(id) {
  const p = getProject(id);
  if (!p) return;
  const count = state.tasks.filter(t => t.projectId === id).length;
  if (!confirm(`确认删除项目「${p.name}」？${count ? `\n其下 ${count} 个任务也将一并删除。` : ''}`)) return;
  state.projects = state.projects.filter(x => x.id !== id);
  state.tasks = state.tasks.filter(t => t.projectId !== id);
  expandedProjects.delete(id);
  if (selection.type === 'project' && selection.id === id) selection = { type: 'all' };
  // 若选中的任务在被删项目下，回退到总览
  if (selection.type === 'task' && !getTask(selection.id)) selection = { type: 'all' };
  save(); renderAll();
}

/** 任务详情面板：仅选中任务时显示，管理子任务（勾选/新增/删除） */
function renderTaskDetail() {
  const panel = $('#taskDetailPanel');
  const t = selectedTask();
  if (!t) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const proj = getProject(t.projectId);
  $('#detailTitle').textContent = t.title;
  const sp = subtaskProgress(t);
  $('#detailMeta').textContent =
    `${proj ? '项目：' + proj.name : '独立任务'} · ${PHASE_NAME[t.phase]}阶段 · ${PRIORITY_NAME[t.priority]}优先级` +
    (sp.total ? ` · 子任务 ${sp.done}/${sp.total}` : '');

  const list = $('#subtaskList');
  const subs = t.subtasks || [];
  list.innerHTML = subs.length ? subs.map(s => `
    <li class="subtask-item ${s.finished ? 'finished' : ''}">
      <input type="checkbox" class="sub-check" data-sid="${s.id}" ${s.finished ? 'checked' : ''}>
      <span class="sub-title">${escapeHtml(s.title)}</span>
      <button class="sub-del" data-sdel="${s.id}" title="删除子任务">✕</button>
    </li>`).join('') : '<div class="empty">暂无子任务，在下方输入后回车添加</div>';
}

/** 任务详情面板事件：子任务勾选/新增/删除 */
function bindTaskDetail() {
  const panel = $('#taskDetailPanel');
  panel.addEventListener('change', e => {
    if (!e.target.classList.contains('sub-check')) return;
    const t = selectedTask();
    const s = t && (t.subtasks || []).find(x => x.id === e.target.dataset.sid);
    if (!s) return;
    s.finished = e.target.checked;
    save(); renderAll();
  });
  panel.addEventListener('click', e => {
    const del = e.target.closest('[data-sdel]');
    if (!del) return;
    const t = selectedTask();
    if (!t) return;
    t.subtasks = (t.subtasks || []).filter(x => x.id !== del.dataset.sdel);
    save(); renderAll();
  });
  // 输入子任务后回车添加；全部子任务完成时自动把任务标记完成（再次取消勾选会恢复）
  $('#subtaskInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (!v) return;
    const t = selectedTask();
    if (!t) return;
    t.subtasks = t.subtasks || [];
    t.subtasks.push({ id: uid(), title: v, finished: false });
    e.target.value = '';
    save(); renderAll();
    $('#subtaskInput').focus();
  });
}

/** 视图切换（状态持久化） */
function bindViewSwitch() {
  $('#viewSwitch').addEventListener('click', e => {
    const btn = e.target.closest('.vs-btn');
    if (!btn) return;
    viewMode = btn.dataset.view;
    localStorage.setItem(VIEW_KEY, viewMode);
    applyViewMode();
  });
}

function applyViewMode() {
  document.querySelectorAll('.vs-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === viewMode));
  $('#cardView').classList.toggle('hidden', viewMode !== 'card');
  $('#listView').classList.toggle('hidden', viewMode !== 'list');
}

/** 右栏今日待办：勾选完成 + 备忘录式快速录入（回车新建独立今日任务） */
function bindTodayEvents() {
  // 勾选/取消：完成则移入完成阶段，取消则回到执行阶段（保留在看板可见范围）
  $('#todayList').addEventListener('change', e => {
    if (!e.target.classList.contains('today-check')) return;
    const task = getTask(e.target.dataset.id);
    if (!task) return;
    task.finished = e.target.checked;
    task.phase = e.target.checked ? 'done' : 'exec';
    save(); renderAll();
  });
  // 备忘录式录入：随手输入回车即加入今日待办（独立任务，无截止）
  $('#todayAddInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (!v) return;
    state.tasks.push({
      id: uid(), projectId: null, title: v,
      priority: 'mid', phase: 'exec', due: '',
      today: true, finished: false, subtasks: [],
    });
    e.target.value = '';
    save(); renderAll();
    $('#todayAddInput').focus();
  });
}

/** 时间轴粒度切换（日/周/月/年，持久化） */
function bindTimelineScale() {
  $('#tlSwitch').addEventListener('click', e => {
    const btn = e.target.closest('.tl-btn');
    if (!btn) return;
    tlScale = btn.dataset.scale;
    localStorage.setItem(TL_SCALE_KEY, tlScale);
    renderTimeline();
  });
}

// ============================================================
//  弹窗：新建任务 / 新建项目
// ============================================================
/**
 * 新建任务弹窗。入口区分两种新建方式：
 * - openTaskModal(pid)     → 在指定项目下新建（侧栏项目行“＋”）
 * - openTaskModal(null)    → 新建独立任务（顶栏/独立分组“＋”）
 * 弹窗内仍可切换归属（含“独立任务”选项）
 */
function openTaskModal(pid) {
  $('#taskModalTitle').textContent = pid ? '✏️ 新建任务（归属项目）' : '✏️ 新建独立任务';
  $('#fTitle').value = '';
  $('#fDue').value = '';
  $('#fToday').checked = false;
  $('#fPriority').value = 'mid';
  $('#fPhase').value = 'exec';
  // 归属下拉：首项为“独立任务”，其余为项目列表；独立也可新建，不再强制项目
  $('#fProject').innerHTML =
    `<option value="" ${pid ? '' : 'selected'}>📌 独立任务（不属于任何项目）</option>` +
    state.projects.map(p =>
      `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  $('#taskModal').classList.remove('hidden');
  $('#fTitle').focus();
}

function bindTaskModal() {
  // 顶栏入口 = 新建独立任务；若当前选中某项目则默认归属该项目（仍可改）
  $('#btnAddTask').onclick = () =>
    openTaskModal(selection.type === 'project' ? selection.id : null);
  $('#btnTaskCancel').onclick = () => $('#taskModal').classList.add('hidden');
  $('#btnTaskSave').onclick = () => {
    const title = $('#fTitle').value.trim();
    if (!title) { $('#fTitle').focus(); return; }
    state.tasks.push({
      id: uid(),
      projectId: $('#fProject').value || null,
      title,
      priority: $('#fPriority').value,
      phase: $('#fPhase').value,
      due: $('#fDue').value || '',
      today: $('#fToday').checked,
      finished: $('#fPhase').value === 'done',
      subtasks: [],
    });
    save(); renderAll();
    $('#taskModal').classList.add('hidden');
  };
}

function openProjectModal() {
  $('#pName').value = '';
  $('#pStart').value = todayStr();
  $('#pEnd').value = offsetDate(14);
  $('#projectModal').classList.remove('hidden');
  $('#pName').focus();
}

function bindProjectModal() {
  $('#btnAddProject').onclick = openProjectModal;
  $('#btnProjectCancel').onclick = () => $('#projectModal').classList.add('hidden');
  $('#btnProjectSave').onclick = () => {
    const name = $('#pName').value.trim();
    const start = $('#pStart').value, end = $('#pEnd').value;
    if (!name) { $('#pName').focus(); return; }
    if (!start || !end || end < start) {
      alert('请正确填写起止日期（结束日期不能早于开始日期）');
      return;
    }
    state.projects.push({
      id: uid(), name, start, end,
      color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
    });
    save(); renderAll();
    $('#projectModal').classList.add('hidden');
  };
}

// ============================================================
//  侧栏迷你日历：月视图，截止日用优先级色圆点标记，支持翻月
// ============================================================
let calCursor = new Date(); // 当前显示的月份（取 1 号）

function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const startWeek = new Date(y, m, 1).getDay();          // 1 号是星期几（0=周日）
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = offsetDate(0);

  // 按日期聚合未完成任务的截止（用于彩色圆点 + 悬停提示）
  const dueMap = {};
  state.tasks.forEach(t => {
    if (t.due && t.phase !== 'done') (dueMap[t.due] = dueMap[t.due] || []).push(t);
  });

  let cells = '';
  const total = Math.ceil((startWeek + daysInMonth) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const dayNum = i - startWeek + 1;
    if (dayNum < 1 || dayNum > daysInMonth) { cells += '<span class="mc-cell mc-blank"></span>'; continue; }
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const week = new Date(y, m, dayNum).getDay();
    const dues = dueMap[key] || [];
    const dots = dues.slice(0, 3).map(t => `<i class="mc-dot p-${t.priority}"></i>`).join('');
    const tip = dues.length ? ` title="${escapeHtml(dues.map(t => t.title).join('、'))}"` : '';
    cells += `<span class="mc-cell${key === todayStr ? ' mc-today' : ''}${week === 0 || week === 6 ? ' mc-weekend' : ''}${dues.length ? ' mc-has' : ''}"${tip}>${dayNum}<span class="mc-dots">${dots}</span></span>`;
  }

  $('#miniCal').innerHTML = `
    <div class="mc-head">
      <button class="mc-nav" data-cal="prev" title="上个月">‹</button>
      <span class="mc-title">📅 ${y} 年 ${m + 1} 月</span>
      <button class="mc-nav" data-cal="next" title="下个月">›</button>
    </div>
    <div class="mc-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="mc-grid">${cells}</div>`;
}

function bindCalendar() {
  $('#miniCal').addEventListener('click', e => {
    const btn = e.target.closest('.mc-nav');
    if (!btn) return;
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + (btn.dataset.cal === 'next' ? 1 : -1), 1);
    renderCalendar();
  });
}

// ============================================================
//  右栏倒计时：设了截止日期的任务/项目自动进入 + 手动创建，
//  按到期时间升序（最近的排最前），逐秒跳动，数据随云同步
// ============================================================

/** 合并倒计时条目：任务截止日（未完成）+ 项目结束日 + 手动倒计时 */
function countdownEntries() {
  const items = [];
  state.tasks.forEach(t => {
    if (t.due && t.phase !== 'done') {
      items.push({ key: 't-' + t.id, name: t.title, target: t.due, kind: 'task', priority: t.priority, sel: { type: 'task', id: t.id } });
    }
  });
  state.projects.forEach(p => {
    if (p.end) {
      items.push({ key: 'p-' + p.id, name: p.name, target: p.end, kind: 'project', sel: { type: 'project', id: p.id } });
    }
  });
  (state.countdowns || []).forEach(c => {
    items.push({ key: 'c-' + c.id, name: c.name, target: c.target, kind: 'custom', delId: c.id });
  });
  // 目标日期近的排前面；同日期按名称稳定排序
  items.sort((a, b) => a.target.localeCompare(b.target) || a.name.localeCompare(b.name));
  return items;
}

function renderCountdowns() {
  const list = countdownEntries();
  $('#cdCount').textContent = list.length;
  const ul = $('#cdList');
  if (!list.length) {
    ul.innerHTML = '<div class="empty">⏳ 设置了截止日期的任务/项目会自动出现在这里</div>';
    return;
  }
  ul.innerHTML = list.map(c => {
    // 任务显示优先级圆点（与看板配色一致），项目/手动显示类型小标
    const badge = c.kind === 'task'
      ? `<i class="cd-pri p-${c.priority}" title="${{ high: '高优先级', mid: '中优先级', low: '低优先级' }[c.priority]}"></i>`
      : c.kind === 'project' ? '<span class="cd-badge" title="项目结束日">📁</span>' : '<span class="cd-badge" title="手动添加">🔖</span>';
    const del = c.delId ? `<button class="cd-del" data-id="${c.delId}" title="删除该倒计时">✕</button>` : '';
    const selAttr = c.sel ? ` data-sel="${c.sel.type}:${c.sel.id}" title="点击定位到对应${c.kind === 'task' ? '任务' : '项目'}"` : '';
    return `
    <li class="cd-item${c.sel ? ' cd-link' : ''}" data-key="${c.key}" data-target="${c.target}"${selAttr}>
      ${badge}
      <div class="cd-info">
        <span class="cd-name">${escapeHtml(c.name)}</span>
        <span class="cd-date">🎯 ${c.target}</span>
      </div>
      <div class="cd-right">
        <span class="cd-days"></span>
        <span class="cd-clock"></span>
      </div>
      ${del}
    </li>`;
  }).join('');
  cdTick();
}

/** 逐秒刷新倒计时数字（只改文本，不重新渲染列表） */
function cdTick() {
  document.querySelectorAll('.cd-item').forEach(li => {
    const diff = new Date(li.dataset.target + 'T00:00:00') - Date.now();
    const days = li.querySelector('.cd-days');
    const clock = li.querySelector('.cd-clock');
    if (diff <= 0) {
      const past = Math.floor(-diff / 86400000);
      days.textContent = past === 0 ? '🎉 已到达' : `已过 ${past} 天`;
      days.className = 'cd-days ' + (past === 0 ? 'cd-now' : 'cd-past');
      clock.textContent = '';
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor(diff % 86400000 / 3600000);
    const mi = Math.floor(diff % 3600000 / 60000);
    const s = Math.floor(diff % 60000 / 1000);
    days.textContent = `剩 ${d} 天`;
    days.className = 'cd-days' + (d === 0 ? ' cd-urgent' : '');
    clock.textContent = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });
}

function bindCountdowns() {
  const add = () => {
    const name = $('#cdNameInput').value.trim();
    const date = $('#cdDateInput').value;
    if (!name) { $('#cdNameInput').focus(); return; }
    if (!date) { $('#cdDateInput').focus(); return; }
    if (!state.countdowns) state.countdowns = [];
    state.countdowns.push({ id: uid(), name, target: date });
    $('#cdNameInput').value = '';
    save(); renderCountdowns();
    $('#cdNameInput').focus();
  };
  $('#btnCdAdd').onclick = add;
  $('#cdNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#cdList').addEventListener('click', e => {
    // 手动倒计时可删除；任务/项目自动项跟随源数据（删任务/清截止日即消失）
    const del = e.target.closest('.cd-del');
    if (del) {
      state.countdowns = (state.countdowns || []).filter(c => c.id !== del.dataset.id);
      save(); renderCountdowns();
      return;
    }
    // 点击任务/项目倒计时 → 定位到对应项目/任务视图
    const li = e.target.closest('.cd-item');
    if (li && li.dataset.sel) {
      const [type, id] = li.dataset.sel.split(':');
      selection = { type, id };
      renderAll();
    }
  });
  $('#cdDateInput').value = offsetDate(0);
  setInterval(cdTick, 1000);
}

// 点击遮罩 / Esc 关闭弹窗；给所有弹窗右上角统一注入 ✕ 关闭按钮
function bindModalDismiss() {
  document.querySelectorAll('.modal').forEach(modal => {
    if (modal.querySelector('.modal-close')) return;
    const btn = document.createElement('button');
    btn.className = 'modal-close';
    btn.title = '关闭';
    btn.textContent = '✕';
    btn.addEventListener('click', () => modal.closest('.modal-mask').classList.add('hidden'));
    modal.appendChild(btn);
  });
  document.querySelectorAll('.modal-mask').forEach(mask => {
    mask.addEventListener('click', e => {
      if (e.target === mask) mask.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-mask').forEach(m => m.classList.add('hidden'));
    }
  });
}

// ============================================================
//  粘贴导入：自动识别表格中的标题/时间节点/优先级/阶段/其他信息
// ============================================================
let importResult = []; // 解析后的待导入记录 [{title, due, priority, phase, project, note}]

/** 解析网页/Excel 粘贴的 HTML 表格为二维数组 */
function parseHtmlTable(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = doc.querySelectorAll('table');
  if (!tables.length) return null;
  // 取行数最多的表格（避免嵌套小表格）
  let best = tables[0];
  tables.forEach(t => {
    if (t.querySelectorAll('tr').length > best.querySelectorAll('tr').length) best = t;
  });
  return [...best.querySelectorAll('tr')]
    .map(tr => [...tr.querySelectorAll('th,td')].map(c => c.textContent.replace(/\s+/g, ' ').trim()))
    .filter(r => r.length && r.some(v => v));
}

/** 解析纯文本为二维数组：优先制表符（Excel），其次多空格，再次逗号等分隔符 */
function parsePlainRows(text) {
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      if (l.includes('\t')) return l.split('\t').map(c => c.trim());
      if (/\S\s{2,}\S/.test(l)) return l.split(/\s{2,}/).map(c => c.trim());
      if (/[,，;；|]/.test(l)) return l.split(/[,，;；|]/).map(c => c.trim());
      return [l];
    });
}

const pad2 = n => String(n).padStart(2, '0');

/** 尝试将单元格内容规范化为 yyyy-MM-dd，无法识别返回空串 */
function normalizeDate(cell) {
  const v = cell.trim();
  if (!v) return '';
  // Excel 日期序列号（1900 日期系统），如 46265 → 2026/9/1 附近
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const n = Math.floor(+v);
    if (n > 25569 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30));
      d.setUTCDate(d.getUTCDate() + n);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    return '';
  }
  // 2026-09-01 / 2026/9/1 / 2026.9.1 / 2026年9月1日（允许带时间后缀）
  let m = v.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  // 9/1、9月1日（无年份，默认当年）
  m = v.match(/^(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?$/);
  if (m) return `${new Date().getFullYear()}-${pad2(m[1])}-${pad2(m[2])}`;
  return '';
}

/** 识别优先级：高/紧急/重要→high，中/一般→mid，低/次要→low */
function detectPriority(v) {
  const s = v.trim();
  if (/^(高|紧急|特急|重要|最高|P0|P1)$/i.test(s)) return 'high';
  if (/^(中|一般|普通|P2)$/i.test(s)) return 'mid';
  if (/^(低|次要|不紧急|P3)$/i.test(s)) return 'low';
  return '';
}

/** 识别阶段：规划/执行/监控/完成及其常见近义词 */
function detectPhase(v) {
  const s = v.trim();
  if (/^(规划|计划|待开始|未开始)$/.test(s)) return 'plan';
  if (/^(执行|进行|进行中|开发|实施)$/.test(s)) return 'exec';
  if (/^(监控|跟踪|测试|验收|联调)$/.test(s)) return 'monitor';
  if (/^(完成|已完成|结束|已上线)$/.test(s)) return 'done';
  return '';
}

/** 根据表头文字判断列角色 */
function classifyHeader(cell) {
  if (!cell) return 'other';
  if (/截止|时间|日期|节点|deadline/i.test(cell)) return 'due';
  if (/优先级|紧急|重要/.test(cell)) return 'priority';
  if (/阶段|状态|进度/.test(cell)) return 'phase';
  if (/项目/.test(cell)) return 'project';
  if (/标题|任务|名称|事项|主题|内容/.test(cell)) return 'title';
  if (/备注|说明|其他|负责|详情|描述/.test(cell)) return 'note';
  return 'other';
}

/** 无表头时按内容抽样推断列角色 */
function detectColumnRole(cells) {
  const vals = cells.filter(Boolean);
  if (!vals.length) return 'skip';
  if (vals.filter(v => normalizeDate(v)).length / vals.length >= 0.5) return 'due';
  if (vals.filter(v => detectPriority(v)).length / vals.length >= 0.5) return 'priority';
  if (vals.filter(v => detectPhase(v)).length / vals.length >= 0.5) return 'phase';
  return 'text';
}

/** 核心：把粘贴内容解析为结构化任务记录 */
function parseImportContent(text, html) {
  let rows = null;
  if (html && /<table/i.test(html)) rows = parseHtmlTable(html);
  if (!rows || !rows.length) rows = parsePlainRows(text || '');
  rows = rows.filter(r => r.some(c => c));
  if (!rows.length) return [];

  const colCount = Math.max(...rows.map(r => r.length));
  let roles, dataRows;

  // 1) 判断首行是否为表头（含已知关键字且不含数字）
  const headerRoles = rows[0].map(classifyHeader);
  const known = headerRoles.filter(r => r !== 'other').length;
  if (known >= 2 && !rows[0].some(c => /\d/.test(c))) {
    roles = headerRoles;
    dataRows = rows.slice(1);
  } else {
    roles = [];
    for (let i = 0; i < colCount; i++) {
      roles.push(detectColumnRole(rows.map(r => (r[i] || '').trim())));
    }
    dataRows = rows;
  }

  // 2) 补齐标题列：没有显式标题列时，取第一个文本列作为标题
  if (!roles.includes('title')) {
    const idx = roles.findIndex(r => r === 'text' || r === 'other');
    if (idx >= 0) roles[idx] = 'title';
  }

  // 3) 逐行生成记录，无法归类的信息归入“其他信息”
  const result = [];
  for (const row of dataRows) {
    const rec = { title: '', due: '', priority: 'mid', phase: 'exec', project: '', note: [] };
    row.forEach((raw, i) => {
      const v = (raw || '').trim();
      if (!v) return;
      const role = roles[i] || 'other';
      if (role === 'title') {
        if (!rec.title) rec.title = v; else rec.note.push(v);
      } else if (role === 'due') {
        const d = normalizeDate(v);
        if (d) rec.due = d; else rec.note.push(v);
      } else if (role === 'priority') {
        const p = detectPriority(v);
        if (p) rec.priority = p; else rec.note.push(v);
      } else if (role === 'phase') {
        const ph = detectPhase(v);
        if (ph) rec.phase = ph; else rec.note.push(v);
      } else if (role === 'project') {
        rec.project = v;
      } else {
        // 文本列：若与已有项目同名则当作项目，否则作为附带信息
        const matched = state.projects.find(p => p.name.trim() === v);
        if (matched && !rec.project) rec.project = matched.name;
        else rec.note.push(v);
      }
    });
    if (rec.title) result.push(rec);
  }
  return result;
}

function renderImportPreview() {
  const wrap = $('#importPreview');
  if (!importResult.length) {
    wrap.classList.add('hidden');
    $('#importCount').textContent = '';
    return;
  }
  wrap.classList.remove('hidden');
  $('#importPreviewBody').innerHTML = importResult.map(r => `
    <tr>
      <td>${escapeHtml(r.title)}</td>
      <td>${r.due || '<span class="imp-due-empty">—</span>'}</td>
      <td><span class="tag tag-p-${r.priority}">${PRIORITY_NAME[r.priority]}</span></td>
      <td>${PHASE_NAME[r.phase]}</td>
      <td class="imp-note">${r.project ? `【${escapeHtml(r.project)}】` : ''}${escapeHtml(r.note.join('；'))}</td>
    </tr>`).join('');
  $('#importCount').textContent = `已识别 ${importResult.length} 条任务`;
}

function parseAndPreview(html) {
  importResult = parseImportContent($('#importText').value, html);
  renderImportPreview();
}

function bindImportModal() {
  $('#btnImport').onclick = () => {
    $('#importText').value = '';
    importResult = [];
    renderImportPreview();
    // 默认归属：首项“独立任务”，选中项目时默认归入该项目（项目行匹配优先）
    $('#importProject').innerHTML =
      '<option value="">📌 独立任务</option>' +
      state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    if (selection.type === 'project') $('#importProject').value = selection.id;
    $('#importModal').classList.remove('hidden');
    $('#importText').focus();
  };
  $('#btnImportCancel').onclick = () => $('#importModal').classList.add('hidden');

  // 粘贴时优先解析 HTML 表格（从网页/Excel 复制时携带）
  $('#importText').addEventListener('paste', e => {
    const html = e.clipboardData.getData('text/html') || '';
    setTimeout(() => parseAndPreview(html), 0);
  });
  // 手动输入/修改时实时重新解析（纯文本模式）
  $('#importText').addEventListener('input', () => parseAndPreview(''));

  $('#btnImportSave').onclick = () => {
    if (!importResult.length) return;
    const defaultPid = $('#importProject').value || null;
    for (const r of importResult) {
      let pid = defaultPid;
      if (r.project) {
        const matched = state.projects.find(p => p.name.trim() === r.project.trim());
        if (matched) pid = matched.id;
      }
      state.tasks.push({
        id: uid(),
        projectId: pid,
        title: r.title,
        priority: r.priority,
        phase: r.phase,
        due: r.due,
        today: r.due === todayStr(),   // 截止日是今天则自动加入今日待办
        finished: r.phase === 'done',
        note: r.note.join('；'),
        subtasks: [],
      });
    }
    save(); renderAll();
    $('#importModal').classList.add('hidden');
  };
}

// ============================================================
//  云同步（Supabase）
// ============================================================
function cloudHeaders() {
  return { apikey: CLOUD_KEY, Authorization: `Bearer ${CLOUD_KEY}` };
}

/** 拉取云端当前同步码对应的数据；无数据返回 null */
async function cloudPull() {
  const url = `${CLOUD_URL}/rest/v1/${CLOUD_TABLE}?sync_code=eq.${encodeURIComponent(syncConf.code)}&select=data,updated_at`;
  const res = await fetch(url, { headers: cloudHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

/** 把本地全量数据写入云端（按同步码覆盖更新） */
async function cloudPush() {
  if (!cloudReady()) return;
  const res = await fetch(`${CLOUD_URL}/rest/v1/${CLOUD_TABLE}`, {
    method: 'POST',
    headers: { ...cloudHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ sync_code: syncConf.code, data: state, updated_at: new Date().toISOString() }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  syncConf.lastSync = Date.now();
  localStorage.setItem(SYNC_KEY, JSON.stringify(syncConf));
}

/** 云端数据采纳：验证后替换本地（不回推，不丢数据） */
function adoptCloudData(row) {
  if (!isValidState(row.data)) throw new Error('云端数据格式异常');
  suppressPush = true;
  state = normalizeState(row.data);
  save();
  suppressPush = false;
  renderAll();
}

/** 启动时合并：云端与本地比时间戳，新者为准，保证多设备最终一致 */
async function syncOnLoad() {
  if (!cloudReady()) return;
  try {
    const row = await cloudPull();
    const localTime = parseInt(localStorage.getItem(LOCAL_UPDATED_KEY) || '0', 10);
    if (!row) {
      if (localTime) await cloudPush();      // 云端无数据 → 本地推上去建底
      return;
    }
    const cloudTime = Date.parse(row.updated_at) || 0;
    if (cloudTime > localTime) adoptCloudData(row);   // 云端更新 → 采纳
    else if (localTime > cloudTime) await cloudPush(); // 本地更新 → 推上去
  } catch (e) { /* 网络异常时先用本地数据，下次操作再同步 */ }
}

/** 同步设置弹窗：同步码管理 + 连接/断开 */
function bindSyncModal() {
  const status = $('#syncStatus');
  const setStatus = (msg, cls = '') => {
    status.textContent = msg;
    status.className = `sync-status${cls ? ' ' + cls : ''}`;
  };

  $('#btnSync').onclick = () => {
    $('#syncCode').value = syncConf.code || '';
    if (!CLOUD_URL || !CLOUD_KEY) {
      setStatus('云服务尚未配置：请将 Supabase 的 Project URL 和 anon key 提供给开发者填入代码后启用。');
    } else if (syncConf.code) {
      setStatus(syncConf.lastSync
        ? `已连接 · 上次同步 ${new Date(syncConf.lastSync).toLocaleString()}`
        : '已连接 · 等待首次同步', 'ok');
    } else {
      setStatus('尚未设置同步码：点「生成」或自行输入，所有设备填同一个码即可共享数据。');
    }
    $('#syncModal').classList.remove('hidden');
  };

  // 生成随机同步码（去掉易混淆字符，4 位一组）
  $('#btnGenCode').onclick = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 12; i++) code += chars[Math.floor(Math.random() * chars.length)];
    $('#syncCode').value = code.match(/.{1,4}/g).join('-');
  };

  $('#btnSyncCancel').onclick = () => $('#syncModal').classList.add('hidden');

  // 断开：只清本机同步码，不碰云端数据，本地数据保留
  $('#btnSyncOff').onclick = () => {
    syncConf = {};
    localStorage.removeItem(SYNC_KEY);
    $('#syncCode').value = '';
    setStatus('已断开，本设备今后仅使用本地数据。');
  };

  // 保存并连接：新设备接入入口 —— 云端已有数据时一律以云端为准，
  // 避免新浏览器自动生成的示例数据覆盖真实数据；云端无数据才用本机建底
  $('#btnSyncSave').onclick = async () => {
    const code = $('#syncCode').value.trim();
    if (!CLOUD_URL || !CLOUD_KEY) { setStatus('云服务未配置，暂无法连接。', 'err'); return; }
    if (code.length < 6) { setStatus('同步码至少 6 位，请点「生成」或加长输入。', 'err'); return; }
    syncConf.code = code;
    localStorage.setItem(SYNC_KEY, JSON.stringify(syncConf));
    setStatus('正在连接云端…');
    try {
      const row = await cloudPull();
      if (row) {
        adoptCloudData(row);
        setStatus('连接成功！已载入云端最新数据。', 'ok');
      } else {
        await cloudPush();
        setStatus('连接成功！已用本设备内容创建云端数据。', 'ok');
      }
    } catch (e) {
      setStatus(`连接失败（${e.message}）：请确认数据库表已创建成功后重试。`, 'err');
    }
  };
}

// ============================================================
//  意见反馈（写入 Supabase app_feedback 表，开发者在后台查看）
// ============================================================
const FEEDBACK_TABLE = 'app_feedback';

function bindFeedback() {
  const status = $('#fbStatus');
  const setStatus = (msg, cls = '') => {
    status.textContent = msg;
    status.className = `sync-status${cls ? ' ' + cls : ''}`;
  };

  $('#btnFeedback').onclick = () => {
    $('#fbContent').value = '';
    $('#fbContact').value = '';
    setStatus('匿名提交即可；留下联系方式可收到回复。');
    $('#feedbackModal').classList.remove('hidden');
  };

  $('#btnFbCancel').onclick = () => $('#feedbackModal').classList.add('hidden');

  $('#btnFbSubmit').onclick = async () => {
    const content = $('#fbContent').value.trim();
    if (!content) { setStatus('请先填写反馈内容～', 'err'); return; }
    setStatus('正在提交…');
    $('#btnFbSubmit').disabled = true;
    try {
      const res = await fetch(`${CLOUD_URL}/rest/v1/${FEEDBACK_TABLE}`, {
        method: 'POST',
        headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          contact: $('#fbContact').value.trim() || null,
        }),
      });
      if (res.status !== 201 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      setStatus('提交成功，感谢您的反馈！❤️', 'ok');
      $('#fbContent').value = '';
      $('#fbContact').value = '';
    } catch (e) {
      setStatus(`提交失败（${e.message}），请稍后重试或直接联系开发者。`, 'err');
    } finally {
      $('#btnFbSubmit').disabled = false;
    }
  };
}

// ============================================================
//  初始化
// ============================================================
function init() {
  load();
  viewMode = localStorage.getItem(VIEW_KEY) || 'card';
  tlScale = localStorage.getItem(TL_SCALE_KEY) || 'month';
  applyViewMode();

  bindSidebarEvents();
  bindViewSwitch();
  bindListEvents();
  bindTaskModal();
  bindProjectModal();
  bindImportModal();
  bindTaskDetail();
  bindTodayEvents();
  bindCalendar();
  bindCountdowns();
  bindTimelineScale();
  bindSyncModal();
  bindFeedback();
  bindModalDismiss();

  renderAll();
  syncOnLoad(); // 异步拉取云端最新数据（已配置同步码时）
}

init();
