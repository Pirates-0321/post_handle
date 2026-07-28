/**
 * Popup：展示当前邮箱页面可见的发件人，一键加入重点名单。
 * 163 列表只有显示名，优先添加"显示名规则"；若扩展已学习到该名字的
 * 真实地址，则添加更精确的"地址规则"。
 */

const senderListEl = document.getElementById('sender-list');
const watchCountEl = document.getElementById('watch-count');

document.addEventListener('DOMContentLoaded', init);
document.getElementById('refresh').addEventListener('click', loadSenders);
document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function init() {
  await refreshCount();
  await loadSenders();
}

async function refreshCount() {
  const list = await PH_Storage.getWatchlist();
  watchCountEl.textContent = list.length;
}

/** 向当前标签页的 content script 查询可见发件人 */
async function loadSenders() {
  senderListEl.innerHTML = '<div class="empty">正在读取…</div>';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/[a-z0-9.-]*163\.com\//.test(tab.url || '')) {
    senderListEl.innerHTML = '<div class="empty">请先打开 163 邮箱页面。</div>';
    return;
  }

  let response = null;
  try {
    // 消息会送达所有 frame，含邮件列表的 frame（通常只有一个）会应答
    response = await chrome.tabs.sendMessage(tab.id, { type: 'PH_GET_VISIBLE_SENDERS' });
  } catch (e) {
    // 没有 frame 应答（页面未加载完成或不在列表页）
  }

  const senders = (response && response.senders) || [];
  if (senders.length === 0) {
    senderListEl.innerHTML = '<div class="empty">未在页面中识别到发件人，请打开邮件列表后点"刷新"。</div>';
    return;
  }

  const watchlist = await PH_Storage.getWatchlist();
  senderListEl.innerHTML = '';
  for (const s of senders) {
    senderListEl.appendChild(buildSenderItem(s, watchlist));
  }
}

function buildSenderItem(sender, watchlist) {
  const item = document.createElement('div');
  item.className = 'sender-item';

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = sender.name;
  const sub = document.createElement('div');
  sub.className = 'email';
  sub.textContent = sender.email || '（仅显示名）';
  info.append(name, sub);
  item.appendChild(info);

  // 已关注判定：显示名规则命中，或已学习地址的地址规则命中
  const already = watchlist.some(w =>
    (w.type === 'name' && w.value === sender.name) ||
    (sender.email && w.type === 'email' && w.value === sender.email) ||
    (sender.email && w.type === 'domain' && sender.email.endsWith(w.value))
  );

  if (already) {
    const tag = document.createElement('span');
    tag.className = 'added';
    tag.textContent = '✓ 已在名单';
    item.appendChild(tag);
  } else {
    const btn = document.createElement('button');
    btn.textContent = '＋ 关注';
    btn.addEventListener('click', async () => {
      // 已学习到地址则加地址规则（精确），否则加显示名规则（立即可用）
      const rule = sender.email || sender.name;
      const note = sender.email ? sender.name : '';
      const result = await PH_Storage.addWatchItem(rule, note);
      if (result.ok) {
        const typeLabel = { email: '地址', domain: '域名', name: '显示名' }[result.type];
        btn.replaceWith(Object.assign(document.createElement('span'), {
          className: 'added', textContent: `✓ 已加入(${typeLabel})`
        }));
        await refreshCount();
      }
    });
    item.appendChild(btn);
  }
  return item;
}
