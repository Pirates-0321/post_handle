/**
 * Popup：展示当前邮箱页面可见的发件人，一键加入重点名单。
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
  if (!tab || !/^https:\/\/(mail|email)\.163\.com\//.test(tab.url || '')) {
    senderListEl.innerHTML = '<div class="empty">请先打开 163 邮箱页面。</div>';
    return;
  }

  let response = null;
  try {
    // 消息会送达所有 frame，含发件人的 frame（通常只有邮件列表那个）会应答
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
  name.textContent = sender.senderName || sender.email;
  const email = document.createElement('div');
  email.className = 'email';
  email.textContent = sender.email;
  info.append(name, email);
  item.appendChild(info);

  const already = watchlist.some(w => w.email === sender.email);
  if (already) {
    const tag = document.createElement('span');
    tag.className = 'added';
    tag.textContent = '✓ 已在名单';
    item.appendChild(tag);
  } else {
    const btn = document.createElement('button');
    btn.textContent = '＋ 关注';
    btn.addEventListener('click', async () => {
      const result = await PH_Storage.addWatchItem(sender.email, sender.senderName);
      if (result.ok) {
        btn.replaceWith(Object.assign(document.createElement('span'), {
          className: 'added', textContent: '✓ 已加入'
        }));
        await refreshCount();
      }
    });
    item.appendChild(btn);
  }
  return item;
}
