/**
 * Options 页：重点名单的增删改查、提醒设置、导入导出。
 */

const tbody = document.getElementById('watch-tbody');
const emptyTip = document.getElementById('empty-tip');
const addMsg = document.getElementById('add-msg');
const ioMsg = document.getElementById('io-msg');

document.addEventListener('DOMContentLoaded', init);
document.getElementById('btn-add').addEventListener('click', onAdd);
document.getElementById('input-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') onAdd();
});
document.getElementById('set-notify').addEventListener('change', onSettingsChange);
document.getElementById('set-color').addEventListener('change', onSettingsChange);
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
      const target = cur.find(w => w.email === item.email);
      if (target) {
        target.enabled = checkbox.checked;
        await PH_Storage.setWatchlist(cur);
      }
    });
    tdEnable.appendChild(checkbox);

    const tdEmail = document.createElement('td');
    tdEmail.textContent = item.email;

    const tdNote = document.createElement('td');
    tdNote.textContent = item.note || '—';

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      await PH_Storage.removeWatchItem(item.email);
      await renderList();
    });
    tdDel.appendChild(delBtn);

    tr.append(tdEnable, tdEmail, tdNote, tdDel);
    tbody.appendChild(tr);
  }
}

async function onAdd() {
  const emailInput = document.getElementById('input-email');
  const noteInput = document.getElementById('input-note');
  const result = await PH_Storage.addWatchItem(emailInput.value, noteInput.value);

  addMsg.className = 'msg ' + (result.ok ? 'ok' : 'err');
  if (result.ok) {
    addMsg.textContent = '已添加';
    emailInput.value = '';
    noteInput.value = '';
    await renderList();
  } else if (result.reason === 'duplicate') {
    addMsg.textContent = '该地址已在名单中';
  } else {
    addMsg.textContent = '格式不正确，应为 user@domain.com 或 @domain.com';
  }
  setTimeout(() => { addMsg.textContent = ''; }, 3000);
}

async function onSettingsChange() {
  await PH_Storage.updateSettings({
    desktopNotify: document.getElementById('set-notify').checked,
    highlightColor: document.getElementById('set-color').value
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
      if (!item || typeof item.email !== 'string') continue;
      const email = item.email.trim().toLowerCase();
      if (!PH_Storage.isValidRule(email)) continue;
      if (cur.some(w => w.email === email)) continue;
      cur.push({
        email,
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
