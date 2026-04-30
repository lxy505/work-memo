/* ========== 全局状态 ========== */
let appData = { tasks: [], progress: [] };
let settings = {
    categories: ['项目开发', '会议沟通', '文档撰写', '问题处理', '其他'],
    notifyTime: '17:00',
    notifyEnabled: true,
    autoPush: true,
    serverChanKey: '',
    wecomWebhook: ''
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
    initSpeechRecognition();
    renderAll();
    setupReminder();
    setDefaults();
    bindEvents();
}

function loadData() {
    try { const r = localStorage.getItem('wm_data'); if (r) appData = JSON.parse(r); } catch(e) {}
}
function saveData() { localStorage.setItem('wm_data', JSON.stringify(appData)); }
function loadSettings() {
    try { const r = localStorage.getItem('wm_settings'); if (r) settings = { ...settings, ...JSON.parse(r) }; } catch(e) {}
}
function saveSettings() { localStorage.setItem('wm_settings', JSON.stringify(settings)); }

function setDefaults() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('progressDate').value = today;
    document.getElementById('reportWeek').value = getWeekInputValue(new Date());
    document.getElementById('reportMonth').value = today.slice(0, 7);
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
    updateSettingsUI();
}

// ========== 导航 ==========
function switchTab(page, btn) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(page + 'Page').classList.add('active');
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const titles = { tasks: '工作事项', progress: '工作进度', report: '周报月报', settings: '设置' };
    document.getElementById('pageTitle').textContent = titles[page];
    document.getElementById('voiceFab').style.display = (page === 'progress' || page === 'tasks') ? 'flex' : 'none';
    if (page === 'progress') updateProgressTaskSelect();
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
        const text = e.results[0][0].transcript;
        document.getElementById('voiceResult').textContent = '识别结果：' + text;
        document.getElementById('voiceResult').classList.add('show');
        if (confirm('已识别：\n\n"' + text + '"\n\n添加为工作进度？')) {
            const today = new Date().toISOString().split('T')[0];
            let relTask = null;
            for (const t of appData.tasks) {
                if (!t.completed && text.includes(t.title.substring(0, Math.min(4, t.title.length)))) { relTask = t; break; }
            }
            appData.progress.push({ id: Date.now(), date: today, taskId: relTask ? relTask.id : null, content: text, createdAt: new Date().toISOString() });
            saveData();
            renderCalendar(); renderProgress();
            showToast('✅ 已添加工作进度');
        }
        closeVoicePanel();
    };
    recognition.onerror = () => { showToast('语音识别失败'); stopRecordingUI(); };
    recognition.onend = () => stopRecordingUI();
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
    const pO = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => { if (a.completed !== b.completed) return a.completed ? 1 : -1; return pO[a.priority] - pO[b.priority]; });
    if (!tasks.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><h4>暂无工作事项</h4><p>点击右上角 + 添加</p></div>'; return; }
    list.innerHTML = tasks.map(t => `
        <div class="task-card ${t.priority} ${t.completed ? 'done' : ''}">
            <div class="task-check ${t.completed ? 'checked' : ''}" onclick="toggleTask(${t.id})">${t.completed ? '✓' : ''}</div>
            <div class="task-body">
                <div class="task-title">${esc(t.title)}</div>
                ${t.desc ? `<div class="task-desc">${esc(t.desc)}</div>` : ''}
                <div class="task-tags">
                    ${t.category ? `<span class="tag tag-cat">${esc(t.category)}</span>` : ''}
                    <span class="tag tag-${t.priority}">${t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'}优先级</span>
                </div>
            </div>
            <button class="task-delete" onclick="deleteTask(${t.id})">×</button>
        </div>`).join('');
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
    appData.tasks.push({
        id: Date.now(), title,
        desc: document.getElementById('taskDesc').value.trim(),
        category: document.getElementById('taskCategory').value,
        priority: document.getElementById('taskPriority').value,
        completed: false, createdAt: new Date().toISOString()
    });
    saveData();
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDesc').value = '';
    closeModal('taskModal');
    renderTasks();
    showToast('✅ 已添加');
}

function toggleTask(id) { const t = appData.tasks.find(x => x.id === id); if (t) { t.completed = !t.completed; saveData(); renderTasks(); } }
function deleteTask(id) { appData.tasks = appData.tasks.filter(t => t.id !== id); saveData(); renderTasks(); }

// ========== 工作进度 ==========
function updateProgressTaskSelect() {
    document.getElementById('progressTask').innerHTML = '<option value="">不关联</option>' +
        appData.tasks.filter(t => !t.completed).map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
}

function renderCalendar() {
    const dots = document.getElementById('weekDots');
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
function addProgressForDate(date) { document.getElementById('progressDate').value = date; updateProgressTaskSelect(); showModal('progressModal'); }

function renderProgress() {
    const list = document.getElementById('progressList');
    const end = new Date(currentWeekStart); end.setDate(end.getDate() + 6);
    let items = appData.progress.filter(p => p.date >= currentWeekStart.toISOString().split('T')[0] && p.date <= end.toISOString().split('T')[0]);
    items.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    if (!items.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><h4>本周暂无记录</h4><p>点击日期或 + 添加</p></div>'; return; }
    list.innerHTML = items.map(p => {
        const task = p.taskId ? appData.tasks.find(t => t.id === p.taskId) : null;
        return `<div class="progress-card">
            <div class="progress-date">${p.date} ${getWeekday(p.date)}</div>
            ${task ? `<div class="progress-ref">${esc(task.title)}</div>` : ''}
            <div class="progress-text">${esc(p.content)}</div>
            <button class="progress-del" onclick="deleteProgress(${p.id})">×</button></div>`;
    }).join('');
}

function submitProgress() {
    const date = document.getElementById('progressDate').value;
    const content = document.getElementById('progressContent').value.trim();
    if (!date || !content) { showToast('请填写日期和内容'); return; }
    const taskId = document.getElementById('progressTask').value;
    appData.progress.push({ id: Date.now(), date, taskId: taskId ? parseInt(taskId) : null, content, createdAt: new Date().toISOString() });
    saveData();
    document.getElementById('progressContent').value = '';
    document.getElementById('progressTask').value = '';
    closeModal('progressModal');
    renderCalendar(); renderProgress();
    showToast('✅ 已记录');
}

function deleteProgress(id) { appData.progress = appData.progress.filter(p => p.id !== id); saveData(); renderCalendar(); renderProgress(); }

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
            items.push({ date: ds, weekday: getWeekday(ds), content: p.content, taskName: task ? task.title : null, category: task ? task.category : '' });
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
            items.push({ date: ds, weekday: getWeekday(ds), content: p.content, taskName: task ? task.title : null, category: task ? task.category : '其他' });
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
            html += `<div class="report-item">${i + 1}. ${esc(item.content)}${item.taskName ? `<span style="color:#667eea;font-size:12px;"> 【${esc(item.taskName)}】</span>` : ''}</div>`;
        });
        html += '</div>';
    });
    preview.innerHTML = html;
}

function exportExcel() {
    if (!window._reportData || !window._reportData.length) { showToast('请先生成报告'); return; }
    const headers = ['日期', '星期', '工作内容', '关联事项', '分类'];
    const rows = window._reportData.map(i => [i.date, i.weekday, i.content, i.taskName || '-', i.category || '-']);
    const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadFile(csv, `工作${reportType === 'weekly' ? '周报' : '月报'}_${window._reportLabel || ''}.csv`, 'text/csv;charset=utf-8');
    showToast('✅ 已导出');
}

function shareToWechat() {
    if (!window._reportData || !window._reportData.length) { showToast('请先生成报告'); return; }
    if (navigator.share) {
        const text = window._reportData.map(i => `${i.date} ${i.weekday}: ${i.content}${i.taskName ? ' 【' + i.taskName + '】' : ''}`).join('\n');
        // 生成文件
        const headers = ['日期', '星期', '工作内容', '关联事项', '分类'];
        const rows = window._reportData.map(i => [i.date, i.weekday, i.content, i.taskName || '-', i.category || '-']);
        const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        const file = new File([csv], `工作${reportType === 'weekly' ? '周报' : '月报'}.csv`, { type: 'text/csv' });
        navigator.share({ title: `工作${reportType === 'weekly' ? '周报' : '月报'}`, text, files: [file] }).catch(() => {
            navigator.share({ title: `工作${reportType === 'weekly' ? '周报' : '月报'}`, text }).catch(() => {});
        });
    } else {
        exportExcel();
    }
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
    document.getElementById('dot-serverchan').classList.toggle('active', !!scKey);
    document.getElementById('dot-wecom').classList.toggle('active', !!wcHook);
}

async function testServerChan() {
    const key = document.getElementById('serverChanKey').value.trim();
    if (!key) { showToast('请先输入 SendKey'); return; }
    settings.serverChanKey = key;
    saveSettings();
    updatePushDots();
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
    } catch (e) {
        showToast('❌ 网络错误：' + e.message);
    }
}

async function testWeCom() {
    const webhook = document.getElementById('wecomWebhook').value.trim();
    if (!webhook) { showToast('请先输入 Webhook 地址'); return; }
    settings.wecomWebhook = webhook;
    saveSettings();
    updatePushDots();
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
    } catch (e) {
        showToast('❌ 网络错误：' + e.message);
    }
}

// 构造推送内容
function buildPushContent() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const incomplete = appData.tasks.filter(t => !t.completed);

    if (incomplete.length === 0) return null;

    let title = `⏰ 工作提醒（${dateStr}）`;
    let text = `**${dateStr}**\n\n`;
    text += `您有 **${incomplete.length}** 个未完成事项：\n\n`;

    const pLabel = { high: '🔴', medium: '🟡', low: '🟢' };
    incomplete.forEach((t, i) => {
        text += `${i + 1}. ${pLabel[t.priority] || ''} ${t.title}`;
        if (t.category) text += ` [${t.category}]`;
        text += '\n';
    });

    // 今日进度
    const todayStr = today.toISOString().split('T')[0];
    const todayProgress = appData.progress.filter(p => p.date === todayStr);
    if (todayProgress.length > 0) {
        text += `\n---\n**今日进度**（${todayProgress.length} 条）：\n\n`;
        todayProgress.forEach((p, i) => {
            text += `${i + 1}. ${p.content}\n`;
        });
    }

    text += '\n---\n💡 打开工作备忘录及时更新进度';

    return { title, text };
}

// 通过 Server酱 发送
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

// 通过 企业微信 发送
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

// 执行推送
async function doPush() {
    const content = buildPushContent();
    if (!content) { showToast('所有事项都已完成 👍'); return; }

    let success = false;

    // Server酱
    if (settings.serverChanKey) {
        const ok = await pushViaServerChan(content.title, content.text);
        if (ok) success = true;
    }

    // 企业微信
    if (settings.wecomWebhook) {
        const ok = await pushViaWeCom(content.title, content.text);
        if (ok) success = true;
    }

    if (success) showToast('✅ 已推送到微信');
    else if (!settings.serverChanKey && !settings.wecomWebhook) showToast('⚠️ 请先在设置中配置微信推送');
    else showToast('❌ 推送失败，请检查配置');
}

// 手动推送
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
    }, 30000); // 30秒检查一次
}

function checkAndNotify() {
    const incomplete = appData.tasks.filter(t => !t.completed);
    if (incomplete.length === 0) return;

    // 浏览器通知
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('⏰ 工作提醒', {
            body: `您有 ${incomplete.length} 个未完成事项`,
            icon: 'icons/icon-192.png',
            tag: 'work-reminder'
        });
    }

    // 应用内提醒
    showToast(`⏰ ${incomplete.length} 个事项未完成`);

    // 自动推送微信
    if (settings.autoPush && (settings.serverChanKey || settings.wecomWebhook)) {
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
    updatePushDots();
}

function saveSettingsFromUI() {
    settings.notifyEnabled = document.getElementById('notifyToggle').checked;
    settings.notifyTime = document.getElementById('notifyTime').value;
    settings.autoPush = document.getElementById('autoPushToggle').checked;
    settings.serverChanKey = document.getElementById('serverChanKey').value.trim();
    settings.wecomWebhook = document.getElementById('wecomWebhook').value.trim();
    saveSettings();
    setupReminder();
    updatePushDots();
    renderCategoryBar();
}

function exportBackup() {
    const data = JSON.stringify({ data: appData, settings }, null, 2);
    downloadFile(data, `备忘录备份_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
    showToast('✅ 已导出备份');
}

function clearData() {
    if (!confirm('确定清空所有数据？此操作不可恢复！')) return;
    appData = { tasks: [], progress: [] };
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
['notifyTime', 'serverChanKey', 'wecomWebhook'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
});
