"use strict";

/* -------------------------------------------------------------------------- */
/*  时光提醒 · 一个不依赖任何框架的本地待办提醒页                                 */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = "shiguang.tasks.v1";
const SETTINGS_KEY = "shiguang.settings.v1";
const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

const PRIORITY = {
  normal: { label: "普通", weight: 1 },
  important: { label: "重要", weight: 2 },
  urgent: { label: "紧急", weight: 3 },
};

const FISH_MOODS = [
  { mood: "sad", max: 25, label: "忧郁", src: "whale/sad.webp", text: "做得这么慢，本鱼哪里来的token。" },
  { mood: "hungry", max: 50, label: "饿饿", src: "whale/hungry.webp", text: "做快点做快点，我要吃token啦" },
  { mood: "happy", max: 75, label: "开心", src: "whale/happy.webp", text: "要做完啦，等做完了我也分你一点token" },
  { mood: "joy", max: 99, label: "超开心", src: "whale/joy.webp", text: "嗯嗯，我分你的token已经准备好啦" },
  { mood: "full", max: 100, label: "捧着饭碗", src: "whale/full.webp", text: "喔喔，真厉害，这是给你的token" },
];

const state = {
  tasks: [],
  filter: "all",
  editingId: null,
  priority: "normal",
  sound: true,
  activeAlert: null,
  preview: false,
  queue: [],
  lastCompletedId: null,
  returnFocus: null,
};

const els = {};
let audioCtx = null;
let nextEls = null;
let tickTimer = null;
let titleFlashTimer = null;
let greetingCache = "";
let resizeRaf = 0;
let lastFishMood = null;
let fishClickTimer = 0;
const baseTitle = document.title;

/* -------------------------------------------------------------------------- */
/*  小工具                                                                     */
/* -------------------------------------------------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const pad2 = (n) => String(n).padStart(2, "0");
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toLocalInputValue(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    "T",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
  ].join("");
}

function parseLocalInput(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function defaultDeadline() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15);
  return date.getTime();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function fmtTime(timestamp) {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  if (dayDiff === 0) return `今天 ${fmtTime(timestamp)}`;
  if (dayDiff === 1) return `明天 ${fmtTime(timestamp)}`;
  if (dayDiff === -1) return `昨天 ${fmtTime(timestamp)}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${fmtTime(timestamp)}`;
}

function effectiveDue(task) {
  return task.snoozedUntil && task.snoozedUntil > task.deadline
    ? task.snoozedUntil
    : task.deadline;
}

function describeTask(task) {
  const now = Date.now();
  const due = effectiveDue(task);
  const diff = due - now;
  const snoozed = Boolean(task.snoozedUntil && task.snoozedUntil > now && task.snoozedUntil > task.deadline);

  if (diff <= 0) {
    const late = -diff;
    if (late < 60000) return { text: "刚刚到期", state: "overdue" };
    if (late < 3600000) return { text: `已逾期 ${Math.floor(late / 60000)} 分钟`, state: "overdue" };
    if (late < 86400000) return { text: `已逾期 ${Math.floor(late / 3600000)} 小时`, state: "overdue" };
    return { text: `已逾期 ${Math.floor(late / 86400000)} 天`, state: "overdue" };
  }

  if (snoozed) return { text: `已推迟至 ${fmtTime(due)}`, state: "snoozed" };
  if (diff < 60000) return { text: "即将截止", state: "soon" };
  if (diff < 3600000) {
    return { text: `还有 ${Math.max(1, Math.ceil(diff / 60000))} 分钟`, state: "soon" };
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return {
      text: minutes ? `还有 ${hours} 小时 ${minutes} 分` : `还有 ${hours} 小时`,
      state: diff < 3 * 3600000 ? "soon" : "normal",
    };
  }
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return {
    text: hours && days < 7 ? `还有 ${days} 天 ${hours} 小时` : `还有 ${days} 天`,
    state: "normal",
  };
}

function formatElapsed(late) {
  if (late < 3600000) {
    return `${pad2(Math.floor(late / 60000))}:${pad2(Math.floor((late % 60000) / 1000))}`;
  }
  if (late < 86400000) {
    return `${pad2(Math.floor(late / 3600000))}:${pad2(Math.floor((late % 3600000) / 60000))}`;
  }
  return `${Math.floor(late / 86400000)} 天`;
}

/* -------------------------------------------------------------------------- */
/*  数据                                                                       */
/* -------------------------------------------------------------------------- */

function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 90) : "";
  const deadline = Number(raw.deadline);
  if (!title || !Number.isFinite(deadline)) return null;

  const priority = Object.prototype.hasOwnProperty.call(PRIORITY, raw.priority) ? raw.priority : "normal";
  const done = Boolean(raw.done);
  const completedAt = done ? toNumberOrNull(raw.completedAt) ?? Date.now() : null;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
    title,
    deadline,
    priority,
    done,
    createdAt: toNumberOrNull(raw.createdAt) ?? Date.now(),
    completedAt,
    alertedFor: toNumberOrNull(raw.alertedFor),
    snoozedUntil: toNumberOrNull(raw.snoozedUntil),
  };
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: state.tasks }));
  } catch (error) {
    console.warn("任务保存失败：", error);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sound: state.sound }));
  } catch (error) {
    console.warn("设置保存失败：", error);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tasks)) {
        state.tasks = parsed.tasks.map(normalizeTask).filter(Boolean);
      }
    }
  } catch (error) {
    console.warn("任务读取失败：", error);
  }

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.sound === "boolean") state.sound = parsed.sound;
    }
  } catch (error) {
    console.warn("设置读取失败：", error);
  }
}

function seedTasks() {
  const now = Date.now();
  const at = (dayOffset, hours, minutes = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  };
  const inTwoHours = Math.ceil((now + 2 * 3600000) / 300000) * 300000;

  return [
    {
      id: uid(),
      title: "给妈妈打个电话",
      deadline: inTwoHours,
      priority: "important",
      done: false,
      createdAt: now - 20 * 60000,
      completedAt: null,
      alertedFor: null,
      snoozedUntil: null,
    },
    {
      id: uid(),
      title: "完成本周的项目周报",
      deadline: at(1, 10),
      priority: "urgent",
      done: false,
      createdAt: now - 90 * 60000,
      completedAt: null,
      alertedFor: null,
      snoozedUntil: null,
    },
    {
      id: uid(),
      title: "预约下个月的牙医检查",
      deadline: at(3, 9),
      priority: "normal",
      done: false,
      createdAt: now - 3 * 3600000,
      completedAt: null,
      alertedFor: null,
      snoozedUntil: null,
    },
    {
      id: uid(),
      title: "整理本周的待办清单",
      deadline: at(0, 9),
      priority: "normal",
      done: true,
      createdAt: now - 5 * 3600000,
      completedAt: now - 35 * 60000,
      alertedFor: null,
      snoozedUntil: null,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  元素缓存                                                                   */
/* -------------------------------------------------------------------------- */

function cacheElements() {
  const ids = [
    "composer",
    "titleInput",
    "deadlineInput",
    "cancelEdit",
    "submitBtn",
    "submitLabel",
    "tabs",
    "tabIndicator",
    "clearCompleted",
    "taskList",
    "emptyState",
    "emptyTitle",
    "emptyText",
    "emptyAction",
    "liveClock",
    "todayLabel",
    "greeting",
    "ringBar",
    "ringPercent",
    "progressChip",
    "progressHint",
    "statActive",
    "statDone",
    "statOverdue",
    "nextCard",
    "nextBody",
    "soundToggle",
    "notifyStatus",
    "notifyBtn",
    "previewBtn",
    "toastLayer",
    "alertModal",
    "alertKicker",
    "alertTitle",
    "alertTaskName",
    "alertTaskTime",
    "alertDone",
    "alertSnooze",
    "alertDismiss",
    "confetti",
    "fishPercent",
    "fishBar",
    "fishProgressBar",
    "fishProgressNote",
    "fishBubble",
    "fishBubbleText",
    "fishButton",
    "fishImage",
    "fishParticles",
  ];
  ids.forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

/* -------------------------------------------------------------------------- */
/*  渲染                                                                       */
/* -------------------------------------------------------------------------- */

function activeTasks() {
  return state.tasks
    .filter((task) => !task.done)
    .sort((a, b) => a.deadline - b.deadline || PRIORITY[b.priority].weight - PRIORITY[a.priority].weight);
}

function completedTasks() {
  return state.tasks
    .filter((task) => task.done)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}

function taskNode(task, index) {
  const card = document.createElement("article");
  card.className = `task${task.done ? " is-done" : ""}${task.id === state.lastCompletedId ? " just-completed" : ""}`;
  card.dataset.id = task.id;
  card.dataset.priority = task.priority;
  card.style.setProperty("--delay", `${Math.min(index, 7) * 42}ms`);

  const countdown = describeTask(task);
  const priorityTag = task.priority !== "normal"
    ? `<span class="prio-tag prio-${task.priority}">${PRIORITY[task.priority].label}</span>`
    : "";
  const chipState = task.done ? "done" : countdown.state;
  const chipText = task.done ? "已完成" : countdown.text;

  card.innerHTML = `
    <button class="check" type="button" aria-pressed="${task.done}" aria-label="${task.done ? "恢复为未完成" : "标记为已完成"}" title="${task.done ? "恢复为未完成" : "完成"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 6.8"></path></svg>
    </button>
    <div class="task-main">
      <div class="task-top">
        <h3 class="task-title"><span class="title-text">${escapeHtml(task.title)}</span></h3>
        ${priorityTag}
      </div>
      <div class="task-meta">
        <span class="deadline-chip" data-state="${chipState}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"></circle><path d="M12 7.4V12l3 2"></path></svg>
          <span class="deadline-text">${chipText}</span>
        </span>
        <span class="task-sub">${fmtDate(task.deadline)} 截止</span>
      </div>
    </div>
    <div class="task-actions">
      ${task.done ? "" : `
        <button class="icon-btn edit" type="button" aria-label="编辑任务" title="编辑">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4.2L19.4 8.8a2.7 2.7 0 10-3.8-3.8L4.4 16.2 4 20z"></path><path d="M13.8 6.8l3.8 3.8"></path></svg>
        </button>`}
      <button class="icon-btn delete" type="button" aria-label="删除任务" title="删除">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15"></path><path d="M9.2 7V5.6c0-.9.7-1.6 1.6-1.6h2.4c.9 0 1.6.7 1.6 1.6V7"></path><path d="M6.6 7l.8 12c.1 1 .9 1.8 1.9 1.8h5.4c1 0 1.8-.8 1.9-1.8l.8-12"></path><path d="M10.4 11v6M13.6 11v6"></path></svg>
      </button>
    </div>`;

  return card;
}

function renderList() {
  const previous = new Map();
  $$(".task", els.taskList).forEach((node) => {
    previous.set(node.dataset.id, node.getBoundingClientRect());
  });

  els.taskList.innerHTML = "";
  const active = activeTasks();
  const done = completedTasks();
  const showActive = state.filter !== "done";
  const showDone = state.filter !== "active";
  let index = 0;

  if (showActive) {
    active.forEach((task) => els.taskList.appendChild(taskNode(task, index++)));
  }

  if (showDone && done.length) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.innerHTML = `<span>已完成</span><span class="label-count">${done.length}</span>`;
    els.taskList.appendChild(label);
    done.forEach((task) => els.taskList.appendChild(taskNode(task, index++)));
  }

  const visibleCount = (showActive ? active.length : 0) + (showDone ? done.length : 0);

  if (visibleCount === 0) {
    const copy = {
      all: ["现在没有待办", "去添加一件想做的事，或者享受这份从容。"],
      active: ["进行中的任务都清空了", "先松一口气，新的任务会出现在这里。"],
      done: ["还没有完成的任务", "勾选完成后，它们会安静地待在这里。"],
    }[state.filter];
    els.emptyTitle.textContent = copy[0];
    els.emptyText.textContent = copy[1];
  }
  els.emptyState.hidden = visibleCount > 0;

  $$(".task", els.taskList).forEach((node) => {
    const oldRect = previous.get(node.dataset.id);
    if (!oldRect) {
      node.classList.add("is-new");
      node.addEventListener("animationend", (event) => {
        if (event.target === node && event.animationName === "card-in") {
          node.classList.remove("is-new");
        }
      });
      return;
    }

    const newRect = node.getBoundingClientRect();
    const deltaX = oldRect.left - newRect.left;
    const deltaY = oldRect.top - newRect.top;
    if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
      node.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
    }
  });
}

function renderTabs() {
  const active = activeTasks().length;
  const done = completedTasks().length;
  const counts = { all: state.tasks.length, active, done };

  $$(".tab", els.tabs).forEach((tab) => {
    const key = tab.dataset.filter;
    const selected = key === state.filter;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.setAttribute("tabindex", selected ? "0" : "-1");
    const badge = $(".count", tab);
    if (badge) badge.textContent = String(counts[key]);
  });

  els.clearCompleted.hidden = done === 0;
  requestAnimationFrame(moveTabIndicator);
}

function moveTabIndicator() {
  const activeTab = $(".tab.active", els.tabs);
  if (!activeTab || !els.tabIndicator) return;
  els.tabIndicator.style.width = `${activeTab.offsetWidth}px`;
  els.tabIndicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
}

function fishMoodFor(percent) {
  return FISH_MOODS.find((item) => percent <= item.max) || FISH_MOODS[FISH_MOODS.length - 1];
}

function updateFish(done, total, percent) {
  const info = fishMoodFor(percent);
  els.fishButton.dataset.mood = info.mood;
  els.fishButton.setAttribute("aria-label", `${info.label}的鲸鱼娘，点击戳一戳`);
  if (els.fishImage.getAttribute("src") !== info.src) {
    els.fishImage.src = info.src;
  }
  els.fishPercent.textContent = `${percent}%`;
  els.fishBar.style.width = `${percent}%`;
  els.fishProgressBar.setAttribute("aria-valuenow", String(percent));
  els.fishProgressBar.setAttribute("aria-valuetext", `已完成 ${done} 件，共 ${total} 件`);
  els.fishProgressNote.textContent = total === 0
    ? "还没有任务，本鱼先饿着"
    : done === total
      ? "全部完成，token 已到账"
      : `已完成 ${done} / ${total} 件`;

  if (els.fishBubbleText.textContent !== info.text) {
    els.fishBubbleText.textContent = info.text;
    if (lastFishMood !== null) {
      els.fishBubble.classList.remove("pop");
      void els.fishBubble.offsetWidth;
      els.fishBubble.classList.add("pop");
    }
  }

  lastFishMood = info.mood;
}

function renderStats() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.done).length;
  const active = total - done;
  const now = Date.now();
  const overdue = state.tasks.filter((task) => !task.done && now >= effectiveDue(task)).length;
  const ratio = total ? done / total : 0;
  const percent = Math.round(ratio * 100);

  els.ringPercent.textContent = `${percent}%`;
  els.ringBar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
  els.progressChip.textContent = `${done} / ${total}`;
  els.statActive.textContent = String(active);
  els.statDone.textContent = String(done);
  els.statOverdue.textContent = String(overdue);
  els.statOverdue.style.color = overdue > 0 ? "var(--danger)" : "";
  updateFish(done, total, percent);

  let hint = "添加第一个任务，开始专注。";
  if (total > 0) {
    if (done === total) hint = "全部完成，今天过得很认真。";
    else if (overdue > 0) hint = `有 ${overdue} 件需要你留意，先处理它们吧。`;
    else hint = `再完成 ${active} 件，就全部搞定了。`;
  }
  els.progressHint.textContent = hint;
}

function renderNext() {
  const next = activeTasks()[0];
  els.nextCard.classList.remove("is-overdue");
  nextEls = null;

  if (!next) {
    els.nextBody.innerHTML = `
      <div class="next-empty">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M7.5 12.4l3 3 6-6.4"></path></svg>
        <p>目前没有待办，享受当下。</p>
      </div>`;
    return;
  }

  els.nextBody.innerHTML = `
    <p class="next-label"><span class="pulse-dot"></span><span class="next-label-text">NEXT DEADLINE</span></p>
    <div class="next-time">--:--:--</div>
    <p class="next-title"></p>
    <div class="next-meta"><span class="next-date"></span><span class="next-rel"></span></div>
    <div class="next-bar"><i></i></div>`;

  nextEls = {
    id: next.id,
    label: $(".next-label-text", els.nextBody),
    time: $(".next-time", els.nextBody),
    title: $(".next-title", els.nextBody),
    date: $(".next-date", els.nextBody),
    rel: $(".next-rel", els.nextBody),
    bar: $(".next-bar i", els.nextBody),
  };
  nextEls.title.textContent = next.title;
  nextEls.date.textContent = `${fmtDate(next.deadline)} 截止`;
  tickNext();
}

function tickNext() {
  if (!nextEls) return;
  const task = state.tasks.find((item) => item.id === nextEls.id);
  if (!task || task.done) {
    renderNext();
    return;
  }

  const now = Date.now();
  const due = effectiveDue(task);
  const diff = due - now;
  const late = -diff;
  const snoozed = Boolean(task.snoozedUntil && task.snoozedUntil > now && task.snoozedUntil > task.deadline);
  const overdue = diff <= 0;

  els.nextCard.classList.toggle("is-overdue", overdue && !snoozed);
  nextEls.label.textContent = snoozed && !overdue ? "SNOOZED" : overdue ? "OVERDUE" : "NEXT DEADLINE";

  const span = task.deadline - task.createdAt;
  const progress = span > 0 ? clamp(((now - task.createdAt) / span) * 100, 0, 100) : 100;

  if (overdue) {
    nextEls.time.textContent = formatElapsed(late);
    nextEls.rel.textContent = "已超时";
  } else {
    if (diff < 86400000) {
      nextEls.time.textContent = `${pad2(Math.floor(diff / 3600000))}:${pad2(Math.floor((diff % 3600000) / 60000))}:${pad2(Math.floor((diff % 60000) / 1000))}`;
    } else {
      nextEls.time.textContent = `${Math.floor(diff / 86400000)} 天`;
    }
    nextEls.rel.textContent = snoozed ? "已推迟" : `已过 ${Math.round(progress)}%`;
  }

  nextEls.bar.style.width = `${progress}%`;
}

function render() {
  renderList();
  renderTabs();
  renderStats();
  renderNext();
}

/* -------------------------------------------------------------------------- */
/*  时钟与提醒检查                                                             */
/* -------------------------------------------------------------------------- */

function greetingFor(hour) {
  if (hour < 5) return "夜深了，做完这件事就去休息吧。";
  if (hour < 9) return "早上好，今天也要从容一点。";
  if (hour < 12) return "上午好，把重要的事放在前面。";
  if (hour < 14) return "中午好，记得给自己留一点空隙。";
  if (hour < 18) return "下午好，今天也要从容一点。";
  return "晚上好，慢慢来，也是在前进。";
}

function updateClock() {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  if (els.liveClock.textContent !== time) els.liveClock.textContent = time;

  const weekday = "日一二三四五六"[now.getDay()];
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 星期${weekday}`;
  if (els.todayLabel.textContent !== dateLabel) els.todayLabel.textContent = dateLabel;

  const greeting = greetingFor(now.getHours());
  if (greeting !== greetingCache) {
    greetingCache = greeting;
    els.greeting.textContent = greeting;
  }
}

function updateTaskTimers() {
  $$(".task", els.taskList).forEach((node) => {
    const task = state.tasks.find((item) => item.id === node.dataset.id);
    if (!task || task.done) return;
    const chip = $(".deadline-chip", node);
    const text = $(".deadline-text", node);
    if (!chip || !text) return;
    const info = describeTask(task);
    if (text.textContent !== info.text) text.textContent = info.text;
    if (chip.dataset.state !== info.state) chip.dataset.state = info.state;
  });
}

function checkDueTasks() {
  const now = Date.now();
  state.tasks.forEach((task) => {
    if (task.done) return;
    const due = effectiveDue(task);
    if (now >= due && task.alertedFor !== due) {
      task.alertedFor = due;
      if (task.id !== state.activeAlert && !state.queue.includes(task.id)) {
        state.queue.push(task.id);
      }
    }
  });
  showNextAlert();
}

function tick() {
  updateClock();
  updateTaskTimers();
  tickNext();
  checkDueTasks();
}

function startTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}

/* -------------------------------------------------------------------------- */
/*  提醒弹窗                                                                   */
/* -------------------------------------------------------------------------- */

function showNextAlert() {
  if (state.activeAlert) return;
  while (state.queue.length) {
    const id = state.queue.shift();
    const task = state.tasks.find((item) => item.id === id);
    if (!task || task.done) continue;
    openAlert(task);
    return;
  }
}

function openAlert(task = null) {
  const isPreview = !task;
  state.activeAlert = isPreview ? "__preview__" : task.id;
  state.preview = isPreview;
  state.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  els.alertModal.classList.toggle("is-preview", isPreview);
  els.alertKicker.textContent = isPreview ? "PREVIEW" : "DEADLINE";
  els.alertTitle.textContent = isPreview ? "提醒效果预览" : "时间到了";
  els.alertTaskName.textContent = isPreview ? "喝口水，伸个懒腰" : task.title;
  els.alertTaskTime.textContent = isPreview
    ? "真实任务到期时，会像这样出现在屏幕中央"
    : `${fmtDate(task.deadline)} 截止 · ${describeTask(task).text}`;
  els.alertDone.hidden = isPreview;
  els.alertSnooze.hidden = isPreview;
  els.alertDismiss.textContent = isPreview ? "关闭预览" : "稍后处理";

  els.alertModal.classList.add("show");
  els.alertModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  playAlarm();
  if (!isPreview) {
    showDesktopNotification(task);
    startTitleFlash();
  }

  window.setTimeout(() => {
    const target = isPreview ? els.alertDismiss : els.alertDone;
    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      target.focus();
    }
  }, 180);
}

function closeAlert() {
  const wasPreview = state.preview;
  els.alertModal.classList.remove("show");
  els.alertModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  stopTitleFlash();

  state.activeAlert = null;
  state.preview = false;
  if (!wasPreview) saveTasks();

  const restore = state.returnFocus;
  state.returnFocus = null;
  if (restore && document.contains(restore)) {
    try {
      restore.focus({ preventScroll: true });
    } catch (error) {
      /* 元素可能已经被重新渲染，忽略即可 */
    }
  }

  window.setTimeout(showNextAlert, 380);
}

function startTitleFlash() {
  stopTitleFlash();
  let visible = false;
  titleFlashTimer = window.setInterval(() => {
    visible = !visible;
    document.title = visible ? "⏰ 任务到期 · 时光提醒" : baseTitle;
  }, 900);
}

function stopTitleFlash() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
  }
  document.title = baseTitle;
}

/* -------------------------------------------------------------------------- */
/*  桌面通知                                                                   */
/* -------------------------------------------------------------------------- */

function notificationsSupported() {
  return typeof window.Notification !== "undefined";
}

function updateNotifyUI() {
  if (!notificationsSupported()) {
    els.notifyStatus.textContent = "当前浏览器不支持";
    els.notifyBtn.textContent = "不可用";
    els.notifyBtn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    els.notifyStatus.textContent = "已开启，切到后台也能收到";
    els.notifyBtn.textContent = "已开启";
    els.notifyBtn.disabled = true;
  } else if (Notification.permission === "denied") {
    els.notifyStatus.textContent = "被浏览器阻止，可在站点设置中开启";
    els.notifyBtn.textContent = "查看说明";
    els.notifyBtn.disabled = false;
  } else {
    els.notifyStatus.textContent = "未开启，仅页面内提醒";
    els.notifyBtn.textContent = "开启";
    els.notifyBtn.disabled = false;
  }
}

async function requestNotifications() {
  if (!notificationsSupported()) {
    toast("当前浏览器不支持桌面通知，页面内提醒仍然有效");
    return;
  }
  if (Notification.permission === "granted") return;
  if (Notification.permission === "denied") {
    toast("通知已被浏览器阻止，请在地址栏的站点设置里允许通知");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    updateNotifyUI();
    if (permission === "granted") {
      toast("桌面通知已开启，切到后台也会提醒你");
    } else {
      toast("没关系，页面内的提醒仍然有效");
    }
  } catch (error) {
    toast("通知开启失败，页面内提醒仍然有效");
  }
}

function showDesktopNotification(task) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
    const notification = new Notification("⏰ 任务到期", {
      body: `${task.title}\n${fmtDate(task.deadline)} 截止`,
      tag: `shiguang-${task.id}`,
      silent: true,
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    /* 某些浏览器禁止页面直接创建通知，忽略即可 */
  }
}

/* -------------------------------------------------------------------------- */
/*  声音                                                                       */
/* -------------------------------------------------------------------------- */

function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    audioCtx = new AudioCtor();
  } catch (error) {
    audioCtx = null;
  }
  return audioCtx;
}

function withAudio(callback) {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().then(() => callback(ctx)).catch(() => {});
  } else {
    callback(ctx);
  }
}

function tone(ctx, frequency, start, duration, volume, type = "sine") {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.06);
}

function playAlarm() {
  if (!state.sound) return;
  withAudio((ctx) => {
    const start = ctx.currentTime + 0.05;
    [0, 0.9].forEach((offset) => {
      [880, 1108.73, 1318.51].forEach((frequency, index) => {
        tone(ctx, frequency, start + offset + index * 0.13, 0.55, 0.075);
      });
      tone(ctx, 440, start + offset, 0.5, 0.035, "triangle");
    });
  });
}

function playDone() {
  if (!state.sound) return;
  withAudio((ctx) => {
    const start = ctx.currentTime + 0.02;
    tone(ctx, 659.25, start, 0.22, 0.055);
    tone(ctx, 987.77, start + 0.09, 0.38, 0.045);
  });
}

function playFishBoop() {
  if (!state.sound) return;
  withAudio((ctx) => {
    const start = ctx.currentTime + 0.01;
    tone(ctx, 523.25, start, 0.12, 0.045);
    tone(ctx, 783.99, start + 0.055, 0.16, 0.035);
    tone(ctx, 1046.5, start + 0.12, 0.12, 0.022, "triangle");
  });
}

function spawnFishParticles() {
  if (!els.fishParticles) return;
  for (let index = 0; index < 7; index += 1) {
    const particle = document.createElement("span");
    particle.className = `fish-particle${index % 2 === 0 ? " star" : ""}`;
    particle.style.setProperty("--x", `${(Math.random() - 0.5) * 150}px`);
    particle.style.setProperty("--y", `${-48 - Math.random() * 58}px`);
    particle.style.setProperty("--r", `${(Math.random() - 0.5) * 220}deg`);
    particle.style.setProperty("--delay", `${index * 28}ms`);
    els.fishParticles.appendChild(particle);
    window.setTimeout(() => particle.remove(), 1400);
  }
}

function handleFishClick() {
  if (!els.fishButton) return;
  els.fishButton.classList.remove("is-clicked");
  void els.fishButton.offsetWidth;
  els.fishButton.classList.add("is-clicked");
  spawnFishParticles();
  playFishBoop();
  window.clearTimeout(fishClickTimer);
  fishClickTimer = window.setTimeout(() => els.fishButton.classList.remove("is-clicked"), 760);
}

/* -------------------------------------------------------------------------- */
/*  任务操作                                                                   */
/* -------------------------------------------------------------------------- */

function setPriority(priority) {
  if (!PRIORITY[priority]) return;
  state.priority = priority;
  $$(".priority-btn", els.composer).forEach((button) => {
    const selected = button.dataset.priority === priority;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
}

function resetComposer() {
  state.editingId = null;
  els.titleInput.value = "";
  els.deadlineInput.value = toLocalInputValue(defaultDeadline());
  setPriority("normal");
  els.submitLabel.textContent = "添加任务";
  els.cancelEdit.hidden = true;
  els.composer.classList.remove("is-editing");
}

function startEdit(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.done) return;

  state.editingId = id;
  els.titleInput.value = task.title;
  els.deadlineInput.value = toLocalInputValue(task.deadline);
  setPriority(task.priority);
  els.submitLabel.textContent = "保存修改";
  els.cancelEdit.hidden = false;
  els.composer.classList.add("is-editing");
  els.composer.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => {
    els.titleInput.focus({ preventScroll: true });
    els.titleInput.select();
  }, 260);
}

function cancelEdit() {
  if (!state.editingId) return;
  resetComposer();
}

function addTask(title, deadline, priority) {
  const task = {
    id: uid(),
    title,
    deadline,
    priority,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    alertedFor: null,
    snoozedUntil: null,
  };
  state.tasks.push(task);
  saveTasks();
  resetComposer();
  render();
  els.titleInput.focus();
  toast(`已添加 · ${fmtDate(deadline)} 提醒你`);
}

function updateTask(id, title, deadline, priority) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const deadlineChanged = task.deadline !== deadline;

  task.title = title;
  task.deadline = deadline;
  task.priority = priority;
  if (deadlineChanged) {
    task.alertedFor = null;
    task.snoozedUntil = null;
  }

  saveTasks();
  resetComposer();
  render();
  toast("修改已保存");
}

function toggleTask(id, forceDone) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const nextDone = typeof forceDone === "boolean" ? forceDone : !task.done;
  if (task.done === nextDone) return;

  task.done = nextDone;
  task.completedAt = nextDone ? Date.now() : null;

  if (nextDone) {
    task.snoozedUntil = null;
    state.lastCompletedId = id;
    state.queue = state.queue.filter((queuedId) => queuedId !== id);
  } else if (state.lastCompletedId === id) {
    state.lastCompletedId = null;
  }

  saveTasks();
  render();

  if (nextDone) {
    playDone();
    const allDone = state.tasks.length > 0 && state.tasks.every((item) => item.done);
    if (allDone) {
      window.setTimeout(launchConfetti, 240);
      toast("全部完成，今天很棒 ✦", { duration: 4200 });
    }
  }

  window.setTimeout(() => {
    if (state.lastCompletedId === id) state.lastCompletedId = null;
  }, 900);
}

function deleteTask(id) {
  const index = state.tasks.findIndex((item) => item.id === id);
  if (index < 0) return;

  const [task] = state.tasks.splice(index, 1);
  state.queue = state.queue.filter((queuedId) => queuedId !== id);
  if (state.activeAlert === id) closeAlert();
  state.lastCompletedId = null;
  saveTasks();
  render();

  toast("任务已删除", {
    action: "撤销",
    duration: 6000,
    onAction: () => {
      if (state.tasks.some((item) => item.id === task.id)) return;
      state.tasks.splice(Math.min(index, state.tasks.length), 0, task);
      saveTasks();
      render();
      toast("任务已恢复");
    },
  });
}

function clearCompleted() {
  const removed = state.tasks.filter((task) => task.done);
  if (!removed.length) return;

  state.tasks = state.tasks.filter((task) => !task.done);
  saveTasks();
  render();

  toast(`已清除 ${removed.length} 条已完成`, {
    action: "撤销",
    duration: 6000,
    onAction: () => {
      const existing = new Set(state.tasks.map((task) => task.id));
      state.tasks.push(...removed.filter((task) => !existing.has(task.id)));
      saveTasks();
      render();
      toast("已恢复完成记录");
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  彩纸                                                                       */
/* -------------------------------------------------------------------------- */

function launchConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = els.confetti;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ["#ef6351", "#7869f0", "#2bb99b", "#e39b2f", "#ff9db0", "#5ac8fa"];
  const count = Math.min(150, Math.max(70, Math.round(width / 10)));
  const particles = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.85;
    const speed = 7 + Math.random() * 10;
    return {
      x: width / 2 + (Math.random() - 0.5) * 140,
      y: height * 0.62,
      vx: Math.cos(angle) * speed * (0.7 + Math.random() * 0.6),
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI,
      rotationSpeed: (Math.random() - 0.5) * 0.32,
      shape: Math.random() < 0.28 ? "circle" : "rect",
    };
  });

  const startTime = performance.now();

  function frame(now) {
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, width, height);
    const fade = clamp(1 - Math.max(0, elapsed - 1500) / 1000, 0, 1);
    let alive = false;

    particles.forEach((particle) => {
      particle.vy += 0.27;
      particle.vx *= 0.994;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.rotationSpeed;

      if (fade <= 0 || particle.y > height + 40) return;
      alive = true;
      ctx.save();
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.globalAlpha = fade;
      ctx.fillStyle = particle.color;
      if (particle.shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-particle.size / 2, -particle.size / 3, particle.size, particle.size * 0.66);
      }
      ctx.restore();
    });

    if (alive && elapsed < 2800) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
  }

  requestAnimationFrame(frame);
}

/* -------------------------------------------------------------------------- */
/*  Toast                                                                      */
/* -------------------------------------------------------------------------- */

function toast(message, options = {}) {
  const { action, onAction, duration = 3200 } = options;

  while (els.toastLayer.children.length >= 3) {
    els.toastLayer.firstElementChild.remove();
  }

  const node = document.createElement("div");
  node.className = "toast";
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  node.appendChild(text);

  let timer = 0;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    node.classList.remove("show");
    window.setTimeout(() => node.remove(), 420);
  };

  if (action) {
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "toast-action";
    actionButton.textContent = action;
    actionButton.addEventListener("click", () => {
      clearTimeout(timer);
      dismiss();
      if (typeof onAction === "function") onAction();
    });
    node.appendChild(actionButton);
  }

  els.toastLayer.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  timer = window.setTimeout(dismiss, duration);
  return dismiss;
}

function shake(element) {
  if (!element) return;
  element.classList.remove("shake");
  void element.offsetWidth;
  element.classList.add("shake");
  window.setTimeout(() => element.classList.remove("shake"), 500);
}

/* -------------------------------------------------------------------------- */
/*  事件                                                                       */
/* -------------------------------------------------------------------------- */

function handleSubmit(event) {
  event.preventDefault();
  const title = els.titleInput.value.trim();
  const deadline = parseLocalInput(els.deadlineInput.value);
  const priority = state.priority;

  if (!title) {
    shake($(".composer-main", els.composer));
    els.titleInput.focus();
    toast("先写下要做什么吧");
    return;
  }
  if (!deadline) {
    shake(els.deadlineInput.closest(".date-field"));
    els.deadlineInput.focus();
    toast("给这件事选一个截止时间");
    return;
  }
  if (deadline <= Date.now()) {
    shake(els.deadlineInput.closest(".date-field"));
    els.deadlineInput.focus();
    toast("截止时间要晚于现在");
    return;
  }

  if (state.editingId) {
    updateTask(state.editingId, title, deadline, priority);
  } else {
    addTask(title, deadline, priority);
  }
}

function setFilter(filter) {
  if (state.filter === filter) return;
  state.filter = filter;
  render();
}

function bindEvents() {
  els.composer.addEventListener("submit", handleSubmit);

  $$(".priority-btn", els.composer).forEach((button) => {
    button.addEventListener("click", () => setPriority(button.dataset.priority));
  });

  els.cancelEdit.addEventListener("click", cancelEdit);

  $$(".quick-presets button", els.composer).forEach((button) => {
    button.addEventListener("click", () => {
      const preset = button.dataset.preset;
      const date = new Date();
      if (preset === "1h") {
        date.setTime(Date.now() + 3600000);
      } else if (preset === "tonight") {
        date.setHours(20, 0, 0, 0);
        if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
      } else if (preset === "tomorrow") {
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
      } else if (preset === "3d") {
        date.setDate(date.getDate() + 3);
        date.setHours(9, 0, 0, 0);
      }
      els.deadlineInput.value = toLocalInputValue(date.getTime());
      els.titleInput.focus();
    });
  });

  els.tabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) setFilter(tab.dataset.filter);
  });

  els.tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = $$(".tab", els.tabs);
    const currentIndex = tabs.findIndex((tab) => tab.classList.contains("active"));
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    setFilter(tabs[nextIndex].dataset.filter);
    tabs[nextIndex].focus();
    event.preventDefault();
  });

  els.clearCompleted.addEventListener("click", clearCompleted);

  els.taskList.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const card = button.closest(".task");
    if (!card) return;
    const id = card.dataset.id;

    if (button.classList.contains("check")) toggleTask(id);
    else if (button.classList.contains("edit")) startEdit(id);
    else if (button.classList.contains("delete")) deleteTask(id);
  });

  els.emptyAction.addEventListener("click", () => {
    state.filter = "all";
    render();
    els.composer.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => els.titleInput.focus({ preventScroll: true }), 280);
  });

  els.soundToggle.addEventListener("click", () => {
    state.sound = !state.sound;
    els.soundToggle.setAttribute("aria-checked", String(state.sound));
    saveSettings();
    if (state.sound) {
      playDone();
      toast("提醒声音已开启");
    } else {
      toast("提醒声音已关闭");
    }
  });

  els.fishButton.addEventListener("click", handleFishClick);

  els.notifyBtn.addEventListener("click", requestNotifications);
  els.previewBtn.addEventListener("click", () => {
    if (state.activeAlert) {
      toast("先处理当前的提醒吧");
      return;
    }
    openAlert(null);
  });

  els.alertDone.addEventListener("click", () => {
    const id = state.activeAlert;
    if (!id || state.preview || id === "__preview__") return;
    closeAlert();
    toggleTask(id, true);
  });

  els.alertSnooze.addEventListener("click", () => {
    const id = state.activeAlert;
    if (!id || state.preview || id === "__preview__") return;
    closeAlert();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    task.snoozedUntil = Date.now() + 5 * 60000;
    task.alertedFor = null;
    saveTasks();
    render();
    toast("好的，5 分钟后再提醒你");
  });

  els.alertDismiss.addEventListener("click", closeAlert);

  els.alertModal.addEventListener("click", (event) => {
    if (event.target === els.alertModal) closeAlert();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && els.alertModal.classList.contains("show")) {
      const focusable = $$("button:not([hidden])", els.alertModal).filter((element) => element.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!els.alertModal.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    if (event.key === "Escape") {
      if (els.alertModal.classList.contains("show")) {
        event.preventDefault();
        closeAlert();
      } else if (state.editingId) {
        cancelEdit();
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });

  window.addEventListener("focus", tick);

  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(moveTabIndicator);
  });

  const warmAudio = () => {
    ensureAudio();
  };
  document.addEventListener("pointerdown", warmAudio, { once: true, passive: true });
  document.addEventListener("keydown", warmAudio, { once: true });
}

/* -------------------------------------------------------------------------- */
/*  启动                                                                       */
/* -------------------------------------------------------------------------- */

function init() {
  cacheElements();
  loadState();

  let hasSaved = false;
  try {
    hasSaved = localStorage.getItem(STORAGE_KEY) !== null;
  } catch (error) {
    hasSaved = false;
  }

  const firstRun = !hasSaved;
  if (firstRun) {
    state.tasks = seedTasks();
    saveTasks();
  }

  bindEvents();
  setPriority("normal");
  FISH_MOODS.forEach((item) => {
    const image = new Image();
    image.src = item.src;
  });
  els.deadlineInput.value = toLocalInputValue(defaultDeadline());
  els.soundToggle.setAttribute("aria-checked", String(state.sound));
  updateClock();
  render();
  updateNotifyUI();
  startTicker();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(moveTabIndicator).catch(() => {});
  }

  if (firstRun) {
    window.setTimeout(() => {
      toast("已放好 4 条示例任务，随时可以修改或删除", { duration: 4800 });
    }, 800);
  }

  window.setTimeout(tick, 900);
}

init();
