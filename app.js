/* ========== 全局状态 ========== */
let appData = { tasks: [], progress: [], recycleBin: [] };
let settings = {
    categories: ['项目开发', '会议沟通', '文档撰写', '问题处理', '其他'],
    notifyTime: '17:00',
    notifyEnabled: true,
    autoPush: true,
    serverChanKey: '',
    wecomWebhook: '',
    pushplusToken: '',
    wxpusherToken: '',
    wxpusherUid: ''
};
let currentPage = 'tasks';
let currentFilter = 'all';
let currentCat = null;
let currentWeekStart = getWeekStart(new Date());
let recognition = null;
let isRecording = false;
let reportType = 'weekly';
let reminderTimer = null;
let lastRemindDate = '';

// ========== 初始化 ==========
function init() {
    loadData();
    loadSettings();
    migrateData();
    initSpeechRecognition();
    renderAll();
    setupReminder();
    setDefaults();
    bindEvents();
    cleanExpiredRecycle();
}

function loadData() {
    try { const r = localStorage.getItem('wm_data'); if (r) appData = { ...appData, ...JSON.parse(r) }; } catch(e) {}
}
function saveData() { localStorage.setItem('wm_data', JSON.stringify(appData)); }
function loadSettings() {
    try { const r = localStorage.getItem('wm_settings'); if (r) settings = { ...settings, ...JSON.parse(r) }; } catch(e) {}
}
function saveSettings() { localStorage.setItem('wm_settings', JSON.stringify(settings)); }

// 数据迁移：为旧任务添加progress/date/dueDate字段
function migrateData() {
    let changed = false;
    const today = new Date().toISOString().split('T')[0];
    appData.tasks.forEach(t => {
        if (t.progress === undefined) { t.progress = t.completed ? 100 : 0; changed = true; }
        if (t.date === undefined) { t.date = today; changed = true; }
        if (t.dueDate === undefined) { t.dueDate = ''; changed = true; }
    });
    if (!appData.recycleBin) { appData.recycleBin = []; changed = true; }
    if (changed) saveData();
}

function setDefaults() {
    const today = new Date().toISOString().split('T')[0];
    const dateInput = document.getElementById('progressDate');
    if (dateInput) dateInput.value = today;
    const reportWeek = document.getElementById('reportWeek');
    if (reportWeek) reportWeek.value = getWeekInputValue(new Date());
    const reportMonth = document.getElementById('reportMonth');
    if (reportMonth) reportMonth.value = today.slice(0, 7);
}

function bindEvents() {
    document.querySelectorAll('.modal-overlay').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    });
}

function renderAll() {
    renderTasks();
    renderCategoryBar();
    renderCategoryEditor();
    renderCalendar();
    renderProgress();
    renderRecycleBin();
    updateSettingsUI();
}

// ========== 导航 ==========
function switchTab(page, btn) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(page + 'Page').classList.add('active');
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const titles = {
        tasks: '工作事项',
        progress: '工作进度',
        report: '周报月报',
        settings: '设置'
    };
    const titleEl = document.getElementById('pageTitle');
    if (page === 'tasks') {
        titleEl.innerHTML = '工作事项 <small>作者：梁兴宇</small>';
    } else {
        titleEl.textContent = titles[page];
    }
    document.getElementById('voiceFab').style.display = (page === 'progress' || page === 'tasks') ? 'flex' : 'none';
    if (page === 'progress') updateProgressTaskSelect();
}

// ========== 日期解析函数 ==========

// 周X/星期X 映射到 getDay() 值
const WEEKDAY_MAP = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '日': 0, '天': 0
};

function parseWeekdayChar(ch) {
    return WEEKDAY_MAP[ch] !== undefined ? WEEKDAY_MAP[ch] : null;
}

/**
 * 从语音文本中提取事项日期
 * - "周一线下会议" → 本周一
 * - "下周三完成方案" → 下周三
 * - "5月20日开会" → 2025-05-20
 * - 无日期关键字 → 今天
 */
function parseVoiceDate(text) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 匹配 "下周X" / "下星期X"
    let m = text.match(/下周\s*(?:周|星期)?([一二三四五六日天])/);
    if (m) {
        const target = parseWeekdayChar(m[1]);
        if (target !== null) {
            const currentDay = today.getDay();
            let diff = target - currentDay;
            if (diff <= 0) diff += 7;
            diff += 7; // 下周
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return d.toISOString().split('T')[0];
        }
    }

    // 匹配 "本周X" / "这周X" / "周X" / "星期X"
    m = text.match(/(?:本周|这周)?\s*(?:周|星期)([一二三四五六日天])/);
    if (m) {
        const target = parseWeekdayChar(m[1]);
        if (target !== null) {
            const currentDay = today.getDay();
            let diff = target - currentDay;
            if (diff < 0) diff += 7;
            // 如果是今天或未来的那天（本周）
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return d.toISOString().split('T')[0];
        }
    }

    // 匹配 "X月X日" / "X月X号"
    m = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
    if (m) {
        const month = parseInt(m[1]);
        const day = parseInt(m[2]);
        const year = today.getFullYear();
        const d = new Date(year, month - 1, day);
        // 如果日期已过，可能是明年
        if (d < today) {
            d.setFullYear(year + 1);
        }
        return d.toISOString().split('T')[0];
    }

    // 默认今天
    return today.toISOString().split('T')[0];
}

/**
 * 从语音文本中提取截止日期
 * - "5月20日前完成" → 2025-05-20
 * - "12号前完成" → 本月12号
 * - "周五前完成" → 本周五
 * - "下周一前完成" → 下周一
 */
function parseVoiceDueDate(text) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 匹配 "X月X日前/之前" / "X月X号前/之前"
    let m = text.match(/(\d{1,2})月(\d{1,2})[日号]?\s*之?前/);
    if (m) {
        const month = parseInt(m[1]);
        const day = parseInt(m[2]);
        const year = today.getFullYear();
        const d = new Date(year, month - 1, day);
        if (d < today) d.setFullYear(year + 1);
        return d.toISOString().split('T')[0];
    }

    // 匹配 "X号前/之前" / "X日前/之前"
    m = text.match(/(\d{1,2})[日号]\s*之?前/);
    if (m) {
        const day = parseInt(m[1]);
        const year = today.getFullYear();
        const month = today.getMonth();
        let d = new Date(year, month, day);
        if (d < today) d.setMonth(month + 1);
        return d.toISOString().split('T')[0];
    }

    // 匹配 "下周X前/之前"
    m = text.match(/下周\s*(?:周|星期)?([一二三四五六日天])\s*之?前/);
    if (m) {
        const target = parseWeekdayChar(m[1]);
        if (target !== null) {
            const currentDay = today.getDay();
            let diff = target - currentDay;
            if (diff <= 0) diff += 7;
            diff += 7;
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return d.toISOString().split('T')[0];
        }
    }

    // 匹配 "周X前/之前" / "星期X前/之前" / "本周X前/之前"
    m = text.match(/(?:本周|这周)?\s*(?:周|星期)([一二三四五六日天])\s*之?前/);
    if (m) {
        const target = parseWeekdayChar(m[1]);
        if (target !== null) {
            const currentDay = today.getDay();
            let diff = target - currentDay;
            if (diff <= 0) diff += 7;
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return d.toISOString().split('T')[0];
        }
    }

    return '';
}

/**
 * 清理语音文本中的日期关键字，返回干净的任务标题
 */
function removeDateKeywords(text) {
    let clean = text;
    // 移除截止日期表述
    clean = clean.replace(/\d{1,2}月\d{1,2}[日号]?\s*之?前\s*(?:完成|搞定|交)?/, '');
    clean = clean.replace(/\d{1,2}[日号]\s*之?前\s*(?:完成|搞定|交)?/, '');
    clean = clean.replace(/下周\s*(?:周|星期)?[一二三四五六日天]\s*之?前\s*(?:完成|搞定|交)?/, '');
    clean = clean.replace(/(?:本周|这周)?\s*(?:周|星期)[一二三四五六日天]\s*之?前\s*(?:完成|搞定|交)?/, '');
    // 移除日期表述
    clean = clean.replace(/下周\s*(?:周|星期)?[一二三四五六日天]/, '');
    clean = clean.replace(/(?:本周|这周)?\s*(?:周|星期)[一二三四五六日天]/, '');
    clean = clean.replace(/\d{1,2}月\d{1,2}[日号]/, '');
    // 清理多余空格和尾部词
    clean = clean.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/[的]+$/, '').trim();
    return clean;
}

// ========== 语音识别 ==========
function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => {
        isRecording = true;
        document.getElementById('voiceStatus').textContent = '正在聆听...';
        document.getElementById('voiceRecordBtn').classList.add('recording');
        document.getElementById('recordLabel').textContent = '停止录音';
        document.getElementById('voiceRing').classList.add('recording');
    };
    recognition.onresult = (e) => {
        const text = e.results[0][0].transcript.trim();
        document.getElementById('voiceResult').textContent = '识别结果：' + text;
        document.getElementById('voiceResult').classList.add('show');

        // 解析日期和截止日期
        const date = parseVoiceDate(text);
        const dueDate = parseVoiceDueDate(text);
        const cleanText = removeDateKeywords(text);

        // 判断是否为进度更新模式
        const progressMatch = parseVoiceProgress(cleanText || text);
        if (progressMatch) {
            handleVoiceProgress(progressMatch, date);
        } else {
            // 默认添加为工作事项
            const displayTitle = cleanText || text;
            if (confirm('已识别：\n\n"' + text + '"\n\n日期：' + date + (dueDate ? '\n截止日期：' + dueDate : '') + '\n\n添加为工作事项？')) {
                addTaskFromVoice(displayTitle, date, dueDate);
            }
        }
        closeVoicePanel();
    };
    recognition.onerror = () => { showToast('语音识别失败'); stopRecordingUI(); };
    recognition.onend = () => stopRecordingUI();
}

// 解析语音中的进度信息
function parseVoiceProgress(text) {
    // 匹配模式：关键词+完成/进度+百分比
    const patterns = [
        /^(.+?)(?:完成(?:了)?|进度(?:为|是)?)\s*(\d+)\s*%\s*$/,
        /^(.+?)\s+(\d+)\s*%\s*$/,
        /^(.+?)(?:完成(?:了)?)\s*百\s*分\s*之\s*(\d+)\s*$/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return { keyword: match[1].trim(), progress: parseInt(match[2]) };
        }
    }
    return null;
}

// 语音更新进度
function handleVoiceProgress(parsed, date) {
    const { keyword, progress: pct } = parsed;
    const clampedPct = Math.max(0, Math.min(100, pct));

    // 搜索匹配的事项
    const matchedTasks = appData.tasks.filter(t =>
        !t.completed && (t.title.includes(keyword) || keyword.includes(t.title))
    );

    if (matchedTasks.length === 1) {
        const task = matchedTasks[0];
        if (confirm(`找到事项："${task.title}"\n将进度更新为 ${clampedPct}%，确认？`)) {
            updateTaskProgress(task.id, clampedPct, '语音更新', date);
            showToast(`✅ "${task.title}" 进度已更新为 ${clampedPct}%`);
        }
    } else if (matchedTasks.length > 1) {
        // 多个匹配，让用户选择
        const names = matchedTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        const choice = prompt(`找到多个匹配事项：\n${names}\n\n请输入序号（1-${matchedTasks.length}）：`);
        const idx = parseInt(choice) - 1;
        if (idx >= 0 && idx < matchedTasks.length) {
            const task = matchedTasks[idx];
            updateTaskProgress(task.id, clampedPct, '语音更新', date);
            showToast(`✅ "${task.title}" 进度已更新为 ${clampedPct}%`);
        }
    } else {
        // 没有匹配，询问是否新建
        if (confirm(`未找到包含"${keyword}"的事项\n\n是否新建事项"${keyword}"，进度${clampedPct}%？`)) {
            const taskDate = date || new Date().toISOString().split('T')[0];
            const newTask = {
                id: Date.now(), title: keyword, desc: '',
                category: settings.categories[0] || '其他',
                priority: 'medium', progress: clampedPct,
                completed: clampedPct >= 100,
                date: taskDate,
                dueDate: '',
                createdAt: new Date().toISOString()
            };
            appData.tasks.push(newTask);
            addProgressEntry(newTask.id, clampedPct, '语音创建', taskDate);
            saveData(); renderTasks(); renderCalendar(); renderProgress();
            showToast(`✅ 已添加"${keyword}"，进度 ${clampedPct}%`);
        }
    }
}

// 语音添加事项
function addTaskFromVoice(text, date, dueDate) {
    const taskDate = date || new Date().toISOString().split('T')[0];
    const newTask = {
        id: Date.now(), title: text, desc: '',
        category: settings.categories[0] || '其他',
        priority: 'medium', progress: 0,
        completed: false,
        date: taskDate,
        dueDate: dueDate || '',
        createdAt: new Date().toISOString()
    };
    appData.tasks.push(newTask);
    saveData(); renderTasks(); renderProgress();
    showToast('✅ 已添加工作事项');
}

function stopRecordingUI() {
    isRecording = false;
    document.getElementById('voiceStatus').textContent = '点击下方按钮开始说话';
    document.getElementById('voiceRecordBtn').classList.remove('recording');
    document.getElementById('recordLabel').textContent = '开始录音';
    document.getElementById('voiceRing').classList.remove('recording');
}

function toggleVoicePanel() { document.getElementById('voicePanel').classList.toggle('show'); document.getElementById('voiceResult').classList.remove('show'); }
function closeVoicePanel() { document.getElementById('voicePanel').classList.remove('show'); if (isRecording && recognition) recognition.stop(); }
function toggleRecording() {
    if (!recognition) { showToast('浏览器不支持语音识别'); return; }
    isRecording ? recognition.stop() : (document.getElementById('voiceResult').classList.remove('show'), recognition.start());
}

// ========== 工作事项 ==========
function renderTasks() {
    const list = document.getElementById('taskList');
    let tasks = [...appData.tasks];
    if (currentFilter === 'pending') tasks = tasks.filter(t => !t.completed);
    else if (currentFilter === 'completed') tasks = tasks.filter(t => t.completed);
    if (currentCat) tasks = tasks.filter(t => t.category === currentCat);

    const today = new Date().toISOString().split('T')[0];
    const pO = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => {
        // 逾期排最前
        const aOverdue = !a.completed && a.dueDate && a.dueDate < today;
        const bOverdue = !b.completed && b.dueDate && b.dueDate < today;
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        // 未完成排前
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        // 优先级
        return pO[a.priority] - pO[b.priority];
    });

    if (!tasks.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><h4>暂无工作事项</h4><p>点击右上角 + 或用🎤语音添加</p></div>'; return; }
    list.innerHTML = tasks.map(t => {
        const pct = t.progress || 0;
        const isComplete = pct >= 100;
        const fillClass = isComplete ? 'complete' : '';
        const isOverdue = !t.completed && t.dueDate && t.dueDate < today;
        return `
        <div class="task-card ${t.priority} ${t.completed ? 'done' : ''} ${isOverdue ? 'overdue' : ''}">
            <div class="task-check ${t.completed ? 'checked' : ''}" onclick="toggleTask(${t.id})">${t.completed ? '✓' : ''}</div>
            <div class="task-body">
                <div class="task-title">${esc(t.title)}</div>
                ${t.desc ? `<div class="task-desc">${esc(t.desc)}</div>` : ''}
                <div class="task-tags">
                    ${t.category ? `<span class="tag tag-cat">${esc(t.category)}</span>` : ''}
                    <span class="tag tag-${t.priority}">${t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'}优先级</span>
                    ${t.dueDate ? `<span class="tag tag-due">截止 ${t.dueDate}</span>` : ''}
                    ${isOverdue ? '<span class="tag tag-overdue">逾期</span>' : ''}
                </div>
                <div class="task-progress-bar" onclick="openProgressUpdate(${t.id})">
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill ${fillClass}" style="width:${pct}%"></div>
                    </div>
                    <div class="progress-bar-label">
                        <span>点击更新进度</span>
                        <span class="pct ${fillClass}">${pct}%</span>
                    </div>
                </div>
                <div class="task-actions">
                    <button class="task-action-btn progress-btn" onclick="openProgressUpdate(${t.id})">📊 更新进度</button>
                </div>
            </div>
            <button class="task-delete" onclick="deleteTask(${t.id})">×</button>
        </div>`;
    }).join('');
}

function filterTasks(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    renderTasks();
}

function renderCategoryBar() {
    document.getElementById('categoryBar').innerHTML =
        `<span class="cat-chip ${currentCat === null ? 'active' : ''}" onclick="filterCat(null)">全部</span>` +
        settings.categories.map(c => `<span class="cat-chip ${currentCat === c ? 'active' : ''}" onclick="filterCat('${esc(c)}')">${esc(c)}</span>`).join('');
}

function filterCat(cat) { currentCat = cat; renderCategoryBar(); renderTasks(); }

function handleAdd() {
    if (currentPage === 'tasks') showModal('taskModal');
    else if (currentPage === 'progress') { updateProgressTaskSelect(); showModal('progressModal'); }
}

function submitTask() {
    const title = document.getElementById('taskTitle').value.trim();
    if (!title) { showToast('请输入标题'); return; }
    const progress = parseInt(document.getElementById('taskProgressSlider').value) || 0;
    const dueDate = document.getElementById('taskDueDate').value || '';
    const today = new Date().toISOString().split('T')[0];
    appData.tasks.push({
        id: Date.now(), title,
        desc: document.getElementById('taskDesc').value.trim(),
        category: document.getElementById('taskCategory').value,
        priority: document.getElementById('taskPriority').value,
        progress: progress,
        completed: progress >= 100,
        date: today,
        dueDate: dueDate,
        createdAt: new Date().toISOString()
    });
    if (progress > 0) {
        addProgressEntry(Date.now(), progress, '创建时设置', today);
    }
    saveData();
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDesc').value = '';
    document.getElementById('taskProgressSlider').value = 0;
    document.getElementById('taskProgressVal').textContent = '0%';
    document.getElementById('taskDueDate').value = '';
    closeModal('taskModal');
    renderTasks(); renderCalendar(); renderProgress();
    showToast('✅ 已添加');
}

function toggleTask(id) {
    const t = appData.tasks.find(x => x.id === id);
    if (t) {
        t.completed = !t.completed;
        if (t.completed) {
            t.progress = 100;
            addProgressEntry(t.id, 100, '标记完成');
        }
        saveData(); renderTasks(); renderProgress();
    }
}

// 删除任务（进入回收站）
function deleteTask(id) {
    const t = appData.tasks.find(x => x.id === id);
    if (!t) return;
    if (!confirm(`确定删除"${t.title}"？\n可在5天内从回收站恢复`)) return;
    appData.recycleBin.push({
        id: t.id,
        task: { ...t },
        deletedAt: new Date().toISOString()
    });
    appData.tasks = appData.tasks.filter(x => x.id !== id);
    saveData(); renderTasks(); renderRecycleBin();
    showToast('已移至回收站');
}

// 更新事项进度
function updateTaskProgress(taskId, pct, note, date) {
    const t = appData.tasks.find(x => x.id === taskId);
    if (!t) return;
    const oldPct = t.progress || 0;
    t.progress = Math.max(0, Math.min(100, pct));
    if (t.progress >= 100) {
        t.completed = true;
        t.progress = 100;
    } else {
        t.completed = false;
    }
    addProgressEntry(taskId, t.progress, note || `进度更新：${oldPct}% → ${t.progress}%`, date);
    saveData(); renderTasks(); renderProgress(); renderCalendar();
}

// 添加进度记录
function addProgressEntry(taskId, progress, note, date) {
    const entryDate = date || new Date().toISOString().split('T')[0];
    appData.progress.push({
        id: Date.now() + Math.random(),
        taskId: taskId,
        date: entryDate,
        progress: progress,
        note: note || '',
        createdAt: new Date().toISOString()
    });
}

// 点击进度条打开更新弹窗
function openProgressUpdate(taskId) {
    const t = appData.tasks.find(x => x.id === taskId);
    if (!t) return;
    updateProgressTaskSelect();
    document.getElementById('progressTask').value = taskId;
    document.getElementById('progressSlider').value = t.progress || 0;
    document.getElementById('progressVal').textContent = (t.progress || 0) + '%';
    document.getElementById('progressNote').value = '';
    showModal('progressModal');
}

// ========== 工作进度 ==========
function updateProgressTaskSelect() {
    document.getElementById('progressTask').innerHTML =
        appData.tasks.filter(t => !t.completed).map(t => `<option value="${t.id}">${esc(t.title)} (${t.progress || 0}%)</option>`).join('');
    // 监听选择变化，更新滑块
    const sel = document.getElementById('progressTask');
    sel.onchange = function() {
        const t = appData.tasks.find(x => x.id === parseInt(this.value));
        if (t) {
            document.getElementById('progressSlider').value = t.progress || 0;
            document.getElementById('progressVal').textContent = (t.progress || 0) + '%';
        }
    };
}

function renderCalendar() {
    const dots = document.getElementById('weekDots');
    if (!dots) return;
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const today = new Date().toISOString().split('T')[0];
    let html = '';
    for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStart); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        const has = appData.progress.some(p => p.date === ds);
        html += `<div class="week-dot ${ds === today ? 'today' : ''} ${has ? 'has-data' : ''}" onclick="addProgressForDate('${ds}')">
            <div class="dot-name">${days[d.getDay()]}</div><div class="dot-date">${d.getDate()}</div></div>`;
    }
    dots.innerHTML = html;
    const end = new Date(currentWeekStart); end.setDate(end.getDate() + 6);
    document.getElementById('weekRange').textContent = `${currentWeekStart.getMonth() + 1}/${currentWeekStart.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
}

function changeWeek(offset) { currentWeekStart.setDate(currentWeekStart.getDate() + offset * 7); renderCalendar(); renderProgress(); }
function addProgressForDate(date) {
    updateProgressTaskSelect();
    document.getElementById('progressDate').value = date;
    showModal('progressModal');
}

function renderProgress() {
    const list = document.getElementById('progressList');
    if (!list) return;

    const today = new Date().toISOString().split('T')[0];
    const todayObj = new Date();
    const weekday = getWeekday(today);

    // 获取所有未完成事项 (progress < 100)
    const incompleteTasks = appData.tasks.filter(t => !t.completed && (t.progress || 0) < 100);

    if (!incompleteTasks.length) {
        list.innerHTML = `<div class="progress-date-header">${today} ${weekday}</div><div class="empty-state"><div class="empty-icon">📊</div><h4>暂无未完成事项</h4><p>所有事项都已完成</p></div>`;
        return;
    }

    // 排序：逾期优先，再按优先级
    const pO = { high: 0, medium: 1, low: 2 };
    incompleteTasks.sort((a, b) => {
        const aOverdue = a.dueDate && a.dueDate < today;
        const bOverdue = b.dueDate && b.dueDate < today;
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        return pO[a.priority] - pO[b.priority];
    });

    let html = `<div class="progress-date-header">${today} ${weekday}</div>`;

    incompleteTasks.forEach(t => {
        const pct = t.progress || 0;
        const isOverdue = t.dueDate && t.dueDate < today;
        const fillClass = pct >= 100 ? 'complete' : '';

        // 获取最新一条进度记录
        const latestProgress = [...appData.progress]
            .filter(p => p.taskId === t.id)
            .sort((a, b) => b.id - a.id)[0];
        const latestNote = latestProgress ? latestProgress.note : '';

        html += `
        <div class="progress-task-card ${isOverdue ? 'overdue' : ''}" onclick="openProgressUpdate(${t.id})">
            <div class="progress-task-header">
                <span class="progress-task-title">${esc(t.title)}</span>
                ${isOverdue ? '<span class="tag tag-overdue">逾期</span>' : ''}
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill ${fillClass}" style="width:${pct}%"></div>
            </div>
            <div class="progress-task-meta">
                <span class="progress-pct ${fillClass}">${pct}%</span>
                ${latestNote ? `<span class="progress-task-note">${esc(latestNote)}</span>` : ''}
                ${t.dueDate ? `<span class="progress-task-due">截止 ${t.dueDate}</span>` : ''}
            </div>
        </div>`;
    });

    list.innerHTML = html;
}

function submitProgress() {
    const taskId = parseInt(document.getElementById('progressTask').value);
    const progress = parseInt(document.getElementById('progressSlider').value);
    const note = document.getElementById('progressNote').value.trim();
    const date = document.getElementById('progressDate').value;
    if (!taskId) { showToast('请选择关联事项'); return; }
    if (!date) { showToast('请选择日期'); return; }

    // 更新任务进度
    const t = appData.tasks.find(x => x.id === taskId);
    if (t) {
        t.progress = progress;
        if (progress >= 100) { t.completed = true; t.progress = 100; }
        else { t.completed = false; }
    }

    // 添加进度记录
    appData.progress.push({
        id: Date.now() + Math.random(),
        taskId: taskId,
        date: date,
        progress: progress,
        note: note || `进度更新为${progress}%`,
        createdAt: new Date().toISOString()
    });

    saveData();
    document.getElementById('progressNote').value = '';
    closeModal('progressModal');
    renderTasks(); renderCalendar(); renderProgress();
    showToast('✅ 已记录');
}

function deleteProgress(id) {
    appData.progress = appData.progress.filter(p => p.id !== id);
    saveData(); renderCalendar(); renderProgress();
}

// ========== 回收站 ==========
function renderRecycleBin() {
    const container = document.getElementById('recycleBinList');
    const btn = document.getElementById('cleanRecycleBtn');
    if (!appData.recycleBin || !appData.recycleBin.length) {
        container.innerHTML = '<p style="font-size:13px;color:var(--text2);">回收站为空</p>';
        if (btn) btn.style.display = 'none';
        return;
    }
    if (btn) btn.style.display = 'block';
    const now = new Date();
    container.innerHTML = appData.recycleBin.map(r => {
        const delDate = new Date(r.deletedAt);
        const daysLeft = 5 - Math.floor((now - delDate) / 86400000);
        const leftText = daysLeft > 0 ? `剩余${daysLeft}天` : '已过期';
        return `<div class="recycle-item">
            <div class="recycle-info">
                <div class="recycle-title">${esc(r.task.title)}</div>
                <div class="recycle-time">删除于 ${delDate.toLocaleDateString('zh-CN')} | ${leftText}</div>
            </div>
            ${daysLeft > 0 ? `<button class="recycle-restore" onclick="restoreTask(${r.id})">恢复</button>` : ''}
        </div>`;
    }).join('');
}

function restoreTask(taskId) {
    const idx = appData.recycleBin.findIndex(r => r.id === taskId);
    if (idx === -1) return;
    const item = appData.recycleBin[idx];
    appData.tasks.push(item.task);
    appData.recycleBin.splice(idx, 1);
    saveData(); renderTasks(); renderRecycleBin();
    showToast('✅ 已恢复');
}

function cleanExpiredRecycle() {
    const now = new Date();
    const before = appData.recycleBin.length;
    appData.recycleBin = appData.recycleBin.filter(r => {
        const days = (now - new Date(r.deletedAt)) / 86400000;
        return days < 5;
    });
    if (appData.recycleBin.length < before) {
        saveData();
        showToast(`已清除${before - appData.recycleBin.length}条过期记录`);
    }
    renderRecycleBin();
}

// ========== 周报月报 ==========
function switchReport(type, btn) {
    reportType = type;
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('weeklySelect').style.display = type === 'weekly' ? '' : 'none';
    document.getElementById('monthlySelect').style.display = type === 'monthly' ? '' : 'none';
}

function generateReport() { reportType === 'weekly' ? generateWeekly() : generateMonthly(); }

function generateWeekly() {
    const ws = document.getElementById('reportWeek').value;
    if (!ws) { showToast('请选择周次'); return; }
    const { start, end } = parseWeekInput(ws);
    const items = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split('T')[0];
        appData.progress.filter(p => p.date === ds).forEach(p => {
            const task = p.taskId ? appData.tasks.find(t => t.id === p.taskId) : null;
            const recycled = !task && p.taskId ? appData.recycleBin.find(r => r.id === p.taskId) : null;
            const taskName = task ? task.title : (recycled ? recycled.task.title : null);
            items.push({ date: ds, weekday: getWeekday(ds), content: p.note || `进度${p.progress}%`, taskName, category: task ? task.category : '', progress: p.progress });
        });
    }
    renderReportItems(items);
    window._reportData = items; window._reportLabel = ws;
}

function generateMonthly() {
    const ms = document.getElementById('reportMonth').value;
    if (!ms) { showToast('请选择月份'); return; }
    const [y, m] = ms.split('-');
    const start = new Date(y, m - 1, 1), end = new Date(y, m, 0);
    const items = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split('T')[0];
        appData.progress.filter(p => p.date === ds).forEach(p => {
            const task = p.taskId ? appData.tasks.find(t => t.id === p.taskId) : null;
            const recycled = !task && p.taskId ? appData.recycleBin.find(r => r.id === p.taskId) : null;
            const taskName = task ? task.title : (recycled ? recycled.task.title : null);
            items.push({ date: ds, weekday: getWeekday(ds), content: p.note || `进度${p.progress}%`, taskName, category: task ? task.category : '其他', progress: p.progress });
        });
    }
    renderReportItems(items, true);
    window._reportData = items; window._reportLabel = ms;
}

function renderReportItems(items, isMonthly = false) {
    const preview = document.getElementById('reportPreview');
    if (!items.length) { preview.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><h4>该时间段暂无记录</h4></div>'; return; }
    const grouped = {};
    items.forEach(i => { if (!grouped[i.date]) grouped[i.date] = []; grouped[i.date].push(i); });
    let html = '';
    if (isMonthly) {
        const cs = {};
        items.forEach(i => { cs[i.category || '其他'] = (cs[i.category || '其他'] || 0) + 1; });
        html += '<div style="margin-bottom:20px;padding:12px;background:#f8f9fa;border-radius:10px;">';
        html += '<div style="font-weight:700;margin-bottom:8px;color:#667eea;">分类统计</div>';
        Object.entries(cs).forEach(([c, n]) => { html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0;font-size:13px;"><span>${esc(c)}</span><span style="font-weight:600;">${n} 条</span></div>`; });
        html += '</div>';
    }
    Object.entries(grouped).forEach(([date, dayItems]) => {
        html += `<div class="report-day"><div class="report-day-title">${date} ${dayItems[0].weekday}</div>`;
        dayItems.forEach((item, i) => {
            html += `<div class="report-item">${i + 1}. ${esc(item.content)}${item.taskName ? `<span style="color:#667eea;font-size:12px;"> 【${esc(item.taskName)}】</span>` : ''}<span style="color:#48bb78;font-size:12px;font-weight:600;"> ${item.progress}%</span></div>`;
        });
        html += '</div>';
    });
    preview.innerHTML = html;
}

function exportExcel() {
    if (!window._reportData || !window._reportData.length) { showToast('请先生成报告'); return; }
    const headers = ['日期', '星期', '工作内容', '关联事项', '分类', '进度'];
    const rows = window._reportData.map(i => [i.date, i.weekday, i.content, i.taskName || '-', i.category || '-', i.progress + '%']);
    const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadFile(csv, `工作${reportType === 'weekly' ? '周报' : '月报'}_${window._reportLabel || ''}.csv`, 'text/csv;charset=utf-8');
    showToast('✅ 已导出');
}

function shareToWechat() {
    if (!window._reportData || !window._reportData.length) { showToast('请先生成报告'); return; }
    if (navigator.share) {
        const text = window._reportData.map(i => `${i.date} ${i.weekday}: ${i.content}${i.taskName ? ' 【' + i.taskName + '】' : ''} ${i.progress}%`).join('\n');
        const headers = ['日期', '星期', '工作内容', '关联事项', '分类', '进度'];
        const rows = window._reportData.map(i => [i.date, i.weekday, i.content, i.taskName || '-', i.category || '-', i.progress + '%']);
        const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        const file = new File([csv], `工作${reportType === 'weekly' ? '周报' : '月报'}.csv`, { type: 'text/csv' });
        navigator.share({ title: `工作${reportType === 'weekly' ? '周报' : '月报'}`, text, files: [file] }).catch(() => {
            navigator.share({ title: `工作${reportType === 'weekly' ? '周报' : '月报'}`, text }).catch(() => {});
        });
    } else {
        exportExcel();
    }
}

// ========== 分享应用 ==========
function shareApp() {
    const url = 'https://lxy505.github.io/work-memo/';
    const title = '工作备忘录 - 智能工作管理工具';
    const text = '推荐你使用这个工作备忘录应用！可以记录工作事项、追踪进度、生成周报月报，还能语音输入和微信推送。';
    if (navigator.share) {
        navigator.share({ title, text, url }).catch(() => {});
    } else {
        copyAppLink();
    }
}

function copyAppLink() {
    const url = 'https://lxy505.github.io/work-memo/';
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showToast('✅ 链接已复制'));
    } else {
        const input = document.createElement('input');
        input.value = url; document.body.appendChild(input);
        input.select(); document.execCommand('copy');
        document.body.removeChild(input);
        showToast('✅ 链接已复制');
    }
}

// ========== 可读文本导出 ==========
function exportReadableText() {
    let text = '═══════════════════════════════════\n';
    text += '        工作备忘录 数据导出\n';
    text += '        作者：梁兴宇\n';
    text += '        导出时间：' + new Date().toLocaleString('zh-CN') + '\n';
    text += '═══════════════════════════════════\n\n';

    // 工作事项
    text += '【工作事项】\n';
    text += '───────────────────────────────────\n';
    if (appData.tasks.length === 0) {
        text += '  （暂无事项）\n';
    } else {
        appData.tasks.forEach((t, i) => {
            text += `  ${i + 1}. ${t.title}\n`;
            if (t.desc) text += `     描述：${t.desc}\n`;
            text += `     分类：${t.category || '无'} | 优先级：${t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'} | 进度：${t.progress || 0}% | 状态：${t.completed ? '已完成' : '进行中'}\n`;
            if (t.date) text += `     事项日期：${t.date}\n`;
            if (t.dueDate) text += `     截止日期：${t.dueDate}\n`;
            text += `     创建时间：${new Date(t.createdAt).toLocaleString('zh-CN')}\n`;
            if (i < appData.tasks.length - 1) text += '\n';
        });
    }
    text += '\n';

    // 进度记录
    text += '【进度记录】\n';
    text += '───────────────────────────────────\n';
    if (appData.progress.length === 0) {
        text += '  （暂无记录）\n';
    } else {
        const sorted = [...appData.progress].sort((a, b) => b.date.localeCompare(a.date));
        sorted.forEach((p, i) => {
            const task = p.taskId ? appData.tasks.find(t => t.id === p.taskId) : null;
            const recycled = !task && p.taskId ? appData.recycleBin.find(r => r.id === p.taskId) : null;
            const taskName = task ? task.title : (recycled ? recycled.task.title : '未知');
            text += `  ${i + 1}. [${p.date}] ${taskName}\n`;
            text += `     进度：${p.progress}% | 说明：${p.note || '无'}\n`;
            if (i < sorted.length - 1) text += '\n';
        });
    }
    text += '\n';

    // 统计
    const total = appData.tasks.length;
    const completed = appData.tasks.filter(t => t.completed).length;
    const pending = total - completed;
    const today = new Date().toISOString().split('T')[0];
    const overdue = appData.tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today).length;
    const avgProgress = total > 0 ? Math.round(appData.tasks.reduce((s, t) => s + (t.progress || 0), 0) / total) : 0;
    text += '【统计概览】\n';
    text += '───────────────────────────────────\n';
    text += `  总事项数：${total}\n`;
    text += `  已完成：${completed}\n`;
    text += `  进行中：${pending}\n`;
    text += `  逾期：${overdue}\n`;
    text += `  平均进度：${avgProgress}%\n`;
    text += '\n═══════════════════════════════════\n';

    downloadFile(text, `工作备忘录_${new Date().toISOString().split('T')[0]}.txt`, 'text/plain;charset=utf-8');
    showToast('✅ 已导出可读文本');
}

// ========== 备份导入导出 ==========
function exportBackup() {
    const data = JSON.stringify({ data: appData, settings }, null, 2);
    downloadFile(data, `备忘录备份_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
    showToast('✅ 已导出备份');
}

function importBackup() {
    document.getElementById('importFile').click();
}

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            if (imported.data) {
                if (!confirm('导入将覆盖当前所有数据，确定继续？')) return;
                appData = { ...appData, ...imported.data };
                if (imported.settings) {
                    settings = { ...settings, ...imported.settings };
                    saveSettings();
                }
                saveData();
                renderAll();
                showToast('✅ 导入成功');
            } else {
                showToast('❌ 文件格式不正确');
            }
        } catch (err) {
            showToast('❌ 导入失败：文件格式错误');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ========== 微信推送 ==========
function toggleChannel(name) {
    const body = document.getElementById('body-' + name);
    const arrow = document.getElementById('arrow-' + name);
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    arrow.textContent = isOpen ? '›' : '⌄';
}

function updatePushDots() {
    const scKey = document.getElementById('serverChanKey').value.trim();
    const wcHook = document.getElementById('wecomWebhook').value.trim();
    const ppToken = document.getElementById('pushplusToken').value.trim();
    const wxToken = document.getElementById('wxpusherToken').value.trim();
    const wxUid = document.getElementById('wxpusherUid').value.trim();
    document.getElementById('dot-serverchan').classList.toggle('active', !!scKey);
    document.getElementById('dot-wecom').classList.toggle('active', !!wcHook);
    document.getElementById('dot-pushplus').classList.toggle('active', !!ppToken);
    document.getElementById('dot-wxpusher').classList.toggle('active', !!(wxToken && wxUid));
}

async function testServerChan() {
    const key = document.getElementById('serverChanKey').value.trim();
    if (!key) { showToast('请先输入 SendKey'); return; }
    settings.serverChanKey = key;
    saveSettings(); updatePushDots();
    showToast('正在发送...');
    try {
        const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'title=工作备忘录测试&desp=这是一条测试消息，如果你看到了，说明微信推送配置成功！'
        });
        const data = await res.json();
        if (data.code === 0) showToast('✅ 发送成功，请查看微信');
        else showToast('❌ 发送失败：' + (data.message || '未知错误'));
    } catch (e) { showToast('❌ 网络错误：' + e.message); }
}

async function testWeCom() {
    const webhook = document.getElementById('wecomWebhook').value.trim();
    if (!webhook) { showToast('请先输入 Webhook 地址'); return; }
    settings.wecomWebhook = webhook;
    saveSettings(); updatePushDots();
    showToast('正在发送...');
    try {
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'text', text: { content: '📋 工作备忘录测试\n\n这是一条测试消息，如果你看到了，说明企业微信推送配置成功！' } })
        });
        const data = await res.json();
        if (data.errcode === 0) showToast('✅ 发送成功，请查看企业微信');
        else showToast('❌ 发送失败：' + (data.errmsg || '未知错误'));
    } catch (e) { showToast('❌ 网络错误：' + e.message); }
}

async function testPushPlus() {
    const token = document.getElementById('pushplusToken').value.trim();
    if (!token) { showToast('请先输入 Token'); return; }
    settings.pushplusToken = token;
    saveSettings(); updatePushDots();
    showToast('正在发送...');
    try {
        const res = await fetch('https://www.pushplus.plus/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, title: '工作备忘录测试', content: '这是一条测试消息，如果你在微信看到了，说明 PushPlus 配置成功！', template: 'html' })
        });
        const data = await res.json();
        if (data.code === 200) showToast('✅ 发送成功，请查看微信');
        else showToast('❌ 发送失败：' + (data.msg || '未知错误'));
    } catch (e) { showToast('❌ 网络错误：' + e.message); }
}

async function testWxPusher() {
    const token = document.getElementById('wxpusherToken').value.trim();
    const uid = document.getElementById('wxpusherUid').value.trim();
    if (!token || !uid) { showToast('请先输入 Token 和 UID'); return; }
    settings.wxpusherToken = token;
    settings.wxpusherUid = uid;
    saveSettings(); updatePushDots();
    showToast('正在发送...');
    try {
        const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appToken: token, content: '这是一条测试消息，如果你在微信看到了，说明 WxPusher 配置成功！', contentType: 1, uids: [uid] })
        });
        const data = await res.json();
        if (data.code === 1000) showToast('✅ 发送成功，请查看微信');
        else showToast('❌ 发送失败：' + (data.msg || '未知错误'));
    } catch (e) { showToast('❌ 网络错误：' + e.message); }
}

// 构造推送内容
function buildPushContent() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const todayStr = today.toISOString().split('T')[0];
    const incomplete = appData.tasks.filter(t => !t.completed);

    if (incomplete.length === 0) return null;

    let title = `⏰ 工作提醒（${dateStr}）`;
    let text = `**${dateStr}**\n\n`;
    text += `您有 **${incomplete.length}** 个未完成事项：\n\n`;

    const pLabel = { high: '🔴', medium: '🟡', low: '🟢' };
    incomplete.forEach((t, i) => {
        text += `${i + 1}. ${pLabel[t.priority] || ''} ${t.title} (${t.progress || 0}%)`;
        if (t.category) text += ` [${t.category}]`;
        if (t.dueDate && t.dueDate < todayStr) text += ' ⚠️逾期';
        else if (t.dueDate) text += ` 截止${t.dueDate}`;
        text += '\n';
    });

    // 今日进度
    const todayProgress = appData.progress.filter(p => p.date === todayStr);
    if (todayProgress.length > 0) {
        text += `\n---\n**今日进度**（${todayProgress.length} 条）：\n\n`;
        todayProgress.forEach((p, i) => {
            const task = p.taskId ? appData.tasks.find(t => t.id === p.taskId) : null;
            text += `${i + 1}. ${task ? task.title + ' ' : ''}${p.progress}%${p.note ? ' - ' + p.note : ''}\n`;
        });
    }

    text += '\n---\n💡 打开工作备忘录及时更新进度';

    return { title, text };
}

async function pushViaServerChan(title, text) {
    if (!settings.serverChanKey) return false;
    try {
        const res = await fetch(`https://sctapi.ftqq.com/${settings.serverChanKey}.send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(text)}`
        });
        const data = await res.json();
        return data.code === 0;
    } catch (e) { console.error('Server酱推送失败:', e); return false; }
}

async function pushViaWeCom(title, text) {
    if (!settings.wecomWebhook) return false;
    try {
        const content = title + '\n\n' + text.replace(/\*\*/g, '').replace(/---/g, '————————');
        const res = await fetch(settings.wecomWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'text', text: { content } })
        });
        const data = await res.json();
        return data.errcode === 0;
    } catch (e) { console.error('企业微信推送失败:', e); return false; }
}

async function pushViaPushPlus(title, text) {
    if (!settings.pushplusToken) return false;
    try {
        const htmlText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/---/g, '<hr>').replace(/\n/g, '<br>');
        const res = await fetch('https://www.pushplus.plus/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: settings.pushplusToken, title, content: htmlText, template: 'html' })
        });
        const data = await res.json();
        return data.code === 200;
    } catch (e) { console.error('PushPlus推送失败:', e); return false; }
}

async function pushViaWxPusher(title, text) {
    if (!settings.wxpusherToken || !settings.wxpusherUid) return false;
    try {
        const htmlText = '<h3>' + title + '</h3>' + text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/---/g, '<hr>').replace(/\n/g, '<br>');
        const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appToken: settings.wxpusherToken, content: htmlText, contentType: 1, uids: [settings.wxpusherUid] })
        });
        const data = await res.json();
        return data.code === 1000;
    } catch (e) { console.error('WxPusher推送失败:', e); return false; }
}

async function doPush() {
    const content = buildPushContent();
    if (!content) { showToast('所有事项都已完成 👍'); return; }
    let success = false;
    if (settings.serverChanKey) { const ok = await pushViaServerChan(content.title, content.text); if (ok) success = true; }
    if (settings.wecomWebhook) { const ok = await pushViaWeCom(content.title, content.text); if (ok) success = true; }
    if (settings.pushplusToken) { const ok = await pushViaPushPlus(content.title, content.text); if (ok) success = true; }
    if (settings.wxpusherToken && settings.wxpusherUid) { const ok = await pushViaWxPusher(content.title, content.text); if (ok) success = true; }
    if (success) showToast('✅ 已推送到微信');
    else if (!settings.serverChanKey && !settings.wecomWebhook && !settings.pushplusToken && !settings.wxpusherToken) showToast('⚠️ 请先在设置中配置微信推送');
    else showToast('❌ 推送失败，请检查配置');
}

function pushNow() { doPush(); }

// ========== 定时提醒 ==========
function setupReminder() {
    if (reminderTimer) clearInterval(reminderTimer);
    if (!settings.notifyEnabled) return;
    reminderTimer = setInterval(() => {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const todayStr = now.toISOString().split('T')[0];
        if (timeStr === settings.notifyTime && lastRemindDate !== todayStr) {
            lastRemindDate = todayStr;
            checkAndNotify();
        }
    }, 30000);
}

function checkAndNotify() {
    const incomplete = appData.tasks.filter(t => !t.completed);
    if (incomplete.length === 0) return;
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('⏰ 工作提醒', {
            body: `您有 ${incomplete.length} 个未完成事项`,
            icon: 'icons/icon-192.png',
            tag: 'work-reminder'
        });
    }
    showToast(`⏰ ${incomplete.length} 个事项未完成`);
    if (settings.autoPush && (settings.serverChanKey || settings.wecomWebhook || settings.pushplusToken || (settings.wxpusherToken && settings.wxpusherUid))) {
        doPush();
    }
}

// ========== 设置 ==========
function renderCategoryEditor() {
    document.getElementById('categoryEditor').innerHTML = settings.categories.map((c, i) =>
        `<div class="cat-edit-chip">${esc(c)}<button onclick="removeCategory(${i})">×</button></div>`
    ).join('');
}

function addCategory() {
    const input = document.getElementById('newCatInput');
    const val = input.value.trim();
    if (!val) return;
    if (settings.categories.includes(val)) { showToast('分类已存在'); return; }
    settings.categories.push(val);
    input.value = '';
    saveSettings(); renderCategoryEditor(); renderCategoryBar();
}

function removeCategory(index) {
    settings.categories.splice(index, 1);
    saveSettings(); renderCategoryEditor(); renderCategoryBar();
}

function updateSettingsUI() {
    document.getElementById('notifyToggle').checked = settings.notifyEnabled;
    document.getElementById('notifyTime').value = settings.notifyTime;
    document.getElementById('autoPushToggle').checked = settings.autoPush;
    document.getElementById('serverChanKey').value = settings.serverChanKey || '';
    document.getElementById('wecomWebhook').value = settings.wecomWebhook || '';
    document.getElementById('pushplusToken').value = settings.pushplusToken || '';
    document.getElementById('wxpusherToken').value = settings.wxpusherToken || '';
    document.getElementById('wxpusherUid').value = settings.wxpusherUid || '';
    updatePushDots();
}

function saveSettingsFromUI() {
    settings.notifyEnabled = document.getElementById('notifyToggle').checked;
    settings.notifyTime = document.getElementById('notifyTime').value;
    settings.autoPush = document.getElementById('autoPushToggle').checked;
    settings.serverChanKey = document.getElementById('serverChanKey').value.trim();
    settings.wecomWebhook = document.getElementById('wecomWebhook').value.trim();
    settings.pushplusToken = document.getElementById('pushplusToken').value.trim();
    settings.wxpusherToken = document.getElementById('wxpusherToken').value.trim();
    settings.wxpusherUid = document.getElementById('wxpusherUid').value.trim();
    saveSettings();
    setupReminder();
    updatePushDots();
    renderCategoryBar();
}

function clearData() {
    if (!confirm('确定清空所有数据？已删除的事项将从回收站一起清除！')) return;
    appData = { tasks: [], progress: [], recycleBin: [] };
    saveData(); renderAll();
    showToast('已清空');
}

// ========== 工具函数 ==========
function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function getWeekday(ds) { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ds).getDay()]; }
function getWeekStart(date) { const d = new Date(date); const day = d.getDay(); d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); d.setHours(0, 0, 0, 0); return d; }
function getWeekInputValue(date) {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const y = d.getFullYear();
    const w = Math.ceil((((d - new Date(y, 0, 1)) / 86400000) + 1) / 7);
    return `${y}-W${String(w).padStart(2, '0')}`;
}
function parseWeekInput(ws) {
    const [year, week] = ws.split('-W');
    const d = new Date(year, 0, 1);
    const dayNum = d.getDay() || 7;
    d.setDate(d.getDate() + 4 - dayNum + (week - 1) * 7);
    const start = new Date(d); start.setDate(d.getDate() - 3); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { start, end };
}

function showModal(id) {
    document.getElementById(id).classList.add('show');
    const catSel = document.getElementById('taskCategory');
    if (catSel) catSel.innerHTML = settings.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2800);
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
}

// 请求通知权限
if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => {
        document.addEventListener('click', function req() { Notification.requestPermission(); document.removeEventListener('click', req); });
    }, 3000);
}

// 启动
init();

// 监听设置变更
['notifyToggle', 'autoPushToggle'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
});
['notifyTime', 'serverChanKey', 'wecomWebhook', 'pushplusToken', 'wxpusherToken', 'wxpusherUid'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
});
