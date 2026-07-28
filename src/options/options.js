/**
 * Options 页：重点名单的增删改查（显示名/地址/域名三种规则）、
 * 提醒设置、导入导出。
 */

const tbody = document.getElementById('watch-tbody');
const emptyTip = document.getElementById('empty-tip');
const addMsg = document.getElementById('add-msg');
const ioMsg = document.getElementById('io-msg');

const TYPE_LABEL = { email: '地址', domain: '域名', name: '显示名' };

document.addEventListener('DOMContentLoaded', init);
document.getElementById('btn-add').addEventListener('click', onAdd);
document.getElementById('input-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') onAdd();
});
document.getElementById('set-notify').addEventListener('change', onSettingsChange);
document.getElementById('set-color').addEventListener('change', onSettingsChange);
document.getElementById('set-refresh').addEventListener('change', onSettingsChange);
document.getElementById('btn-export').addEventListener('click', onExport);
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-import').click();
});
document.getElementById('file-import').addEventListener('change', onImport);

async function init() {
  await renderList();
  const settings = await PH_Storage.getSettings();
  document.getElementById('set-notify').checked = settings.desktopNotify;
  document.getElementById('set-color').value = settings.highlightColor;
  document.getElementById('set-refresh').value = settings.autoRefreshSec;
}

async function renderList() {
  const list = await PH_Storage.getWatchlist();
  tbody.innerHTML = '';
  emptyTip.hidden = list.length > 0;

  for (const item of list) {
    const tr = document.createElement('tr');

    // 启用开关
    const tdEnable = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.enabled;
    checkbox.addEventListener('change', async () => {
      const cur = await PH_Storage.getWatchlist();
      const target = cur.find(w => w.type === item.type && w.value === item.value);
      if (target) {
        target.enabled = checkbox.checked;
        await PH_Storage.setWatchlist(cur);
      }
    });
    tdEnable.appendChild(checkbox);

    const tdType = document.createElement('td');
    tdType.textContent = TYPE_LABEL[item.type] || item.type;

    const tdValue = document.createElement('td');
    tdValue.textContent = item.value;

    const tdNote = document.createElement('td');
    tdNote.textContent = item.note || '—';

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      await PH_Storage.removeWatchItem(item.type, item.value);
      await renderList();
    });
    tdDel.appendChild(delBtn);

    tr.append(tdEnable, tdType, tdValue, tdNote, tdDel);
    tbody.appendChild(tr);
  }
}

async function onAdd() {
  const emailInput = document.getElementById('input-email');
  const noteInput = document.getElementById('input-note');
  const result = await PH_Storage.addWatchItem(emailInput.value, noteInput.value);

  addMsg.className = 'msg ' + (result.ok ? 'ok' : 'err');
  if (result.ok) {
    addMsg.textContent = `已添加（${TYPE_LABEL[result.type]}规则）`;
    emailInput.value = '';
    noteInput.value = '';
    await renderList();
  } else if (result.reason === 'duplicate') {
    addMsg.textContent = '该规则已在名单中';
  } else {
    addMsg.textContent = '格式不正确：支持显示名、user@domain.com 或 @domain.com';
  }
  setTimeout(() => { addMsg.textContent = ''; }, 3000);
}

async function onSettingsChange() {
  let autoRefreshSec = parseInt(document.getElementById('set-refresh').value, 10);
  if (isNaN(autoRefreshSec) || autoRefreshSec < 0) autoRefreshSec = 0;
  if (autoRefreshSec > 600) autoRefreshSec = 600;
  await PH_Storage.updateSettings({
    desktopNotify: document.getElementById('set-notify').checked,
    highlightColor: document.getElementById('set-color').value,
    autoRefreshSec
  });
}

async function onExport() {
  const list = await PH_Storage.getWatchlist();
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'post_handle_watchlist.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function onImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error('bad format');

    const cur = await PH_Storage.getWatchlist();
    let added = 0;
    for (const item of imported) {
      if (!item || typeof item !== 'object') continue;
      // 兼容新版 { type, value } 与旧版 { email } 两种格式
      const raw = typeof item.value === 'string' ? item.value : item.email;
      const type = PH_Storage.detectRuleType(raw);
      if (!type) continue;
      const value = type === 'name' ? raw.trim() : raw.trim().toLowerCase();
      if (cur.some(w => w.type === type && w.value === value)) continue;
      cur.push({
        type,
        value,
        note: String(item.note || ''),
        enabled: item.enabled !== false
      });
      added++;
    }
    await PH_Storage.setWatchlist(cur);
    await renderList();
    ioMsg.className = 'msg ok';
    ioMsg.textContent = `导入完成，新增 ${added} 条`;
  } catch (err) {
    ioMsg.className = 'msg err';
    ioMsg.textContent = '导入失败：文件格式不正确';
  }
  e.target.value = '';
  setTimeout(() => { ioMsg.textContent = ''; }, 3000);
}
