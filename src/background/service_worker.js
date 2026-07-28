/**
 * Service Worker：接收 content script 上报的重点新邮件，弹桌面通知。
 * 通知去重放在这里（chrome.storage.session 可跨 worker 重启、跨 frame 共享），
 * 保证同一封邮件只提醒一次。
 */

const MAIL_URL_PATTERNS = ['https://mail.163.com/*', 'https://email.163.com/*'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'PH_NEW_VIP_MAIL' && msg.mail) {
    notifyOnce(msg.mail);
  }
});

/**
 * 去重后弹通知。同一 key（发件人+主题+时间）只提醒一次。
 */
async function notifyOnce(mail) {
  const { notified = [] } = await chrome.storage.session.get({ notified: [] });
  if (notified.includes(mail.key)) return;

  // 队列上限，防止 session 内无限膨胀
  notified.push(mail.key);
  if (notified.length > 500) notified.splice(0, notified.length - 500);
  await chrome.storage.session.set({ notified });

  const title = mail.note
    ? `📮 重点邮件 · ${mail.note}`
    : '📮 收到重点联系人邮件';
  const message = `${mail.senderName} <${mail.email}>\n${mail.subject || '(无主题)'}`;

  chrome.notifications.create(`ph-${hashKey(mail.key)}`, {
    type: 'basic',
    iconUrl: '../../icons/icon128.png',
    title,
    message,
    priority: 2
  });
}

/** 点击通知：聚焦已打开的 163 邮箱标签页，否则新开一个 */
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('ph-')) return;
  chrome.notifications.clear(notificationId);

  const tabs = await chrome.tabs.query({ url: MAIL_URL_PATTERNS });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: 'https://mail.163.com/' });
  }
});

/** 简单稳定 hash，用于通知 ID */
function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
