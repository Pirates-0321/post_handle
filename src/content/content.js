/**
 * 内容脚本：注入 163 邮箱相关页面的所有 frame。
 * 职责：
 *   1. 扫描邮件列表，对命中重点名单的行做高亮标注；
 *   2. 用 MutationObserver 监听列表变化，识别新到达的重点邮件，
 *      通知 service worker 弹桌面提醒；
 *   3. 响应 popup 的"当前页面发件人"查询。
 *
 * 诊断：所有日志带 [PH] 前缀，在控制台过滤 "[PH]" 即可看到扩展的工作状态。
 */

(function () {
  'use strict';

  const HIGHLIGHT_CLASS = 'ph-vip-row';
  const BADGE_CLASS = 'ph-vip-badge';
  const BADGE_ATTR = 'data-ph-badge';

  function log(...args) { console.log('[PH]', ...args); }
  function warn(...args) { console.warn('[PH]', ...args); }

  /** 本 frame 生命周期内已上报过的邮件 key（跨 frame 的去重由 service worker 负责） */
  const reportedKeys = new Set();
  let watchlist = [];
  let settings = { desktopNotify: true, highlightColor: '#fff1b8' };
  /** 首次扫描只建立基线，不对存量邮件发通知 */
  let baselineDone = false;
  /** 每个 frame 只打一次"未找到邮件行"的提示，避免刷屏 */
  let emptyScanLogged = false;

  async function init() {
    log('content script 已注入 frame:', location.href.slice(0, 150));
    try {
      [watchlist, settings] = await Promise.all([
        PH_Storage.getWatchlist(),
        PH_Storage.getSettings()
      ]);
    } catch (e) {
      warn('读取存储失败，扩展上下文可能已失效，请刷新页面', e);
      return;
    }
    log(`名单 ${watchlist.length} 条，桌面通知 ${settings.desktopNotify ? '开' : '关'}`);
    applyHighlightColor();

    // 名单/设置变化时实时刷新
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.watchlist) {
        watchlist = changes.watchlist.newValue || [];
        log('名单已更新，重新扫描，共', watchlist.length, '条');
        scan(false, { refreshOnly: true });
      }
      if (changes.settings) {
        settings = { ...settings, ...(changes.settings.newValue || {}) };
        applyHighlightColor();
      }
    });

    // popup 查询当前页面可见的发件人
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'PH_GET_VISIBLE_SENDERS') {
        const senders = collectVisibleSenders();
        if (senders.length > 0) sendResponse({ senders });
      }
      // 不返回 true：本 frame 没有结果时不占住响应通道，让其它 frame 应答
    });

    // 初始扫描（基线）+ 持续监听
    scan(true);
    observe();
  }

  function applyHighlightColor() {
    document.documentElement.style.setProperty('--ph-highlight', settings.highlightColor);
  }

  /** 收集本 frame 内可见的发件人（供 popup 展示） */
  function collectVisibleSenders() {
    const out = [];
    const seen = new Set();
    for (const { row, senderNode, raw } of PH_Selectors.findMailRows(document)) {
      const info = PH_Selectors.parseRow(row, senderNode, raw);
      if (!info || seen.has(info.email)) continue;
      seen.add(info.email);
      out.push({ email: info.email, senderName: info.senderName, subject: info.subject });
    }
    return out.slice(0, 20);
  }

  /**
   * 扫描当前 document 的邮件列表。
   * @param {boolean} isBaseline 是否基线扫描（基线只记录、不通知）
   * @param {object} opts refreshOnly: 名单变化后重刷高亮，不触发通知
   */
  function scan(isBaseline, opts = {}) {
    if (!document.body) return;
    if (watchlist.length === 0) {
      if (!emptyScanLogged) {
        emptyScanLogged = true;
        log('重点名单为空，跳过扫描（在扩展设置页添加关注地址后开始工作）');
      }
      return;
    }

    const candidates = PH_Selectors.findSenderCandidates(document);
    const rows = PH_Selectors.findMailRows(document);

    if (isBaseline || !emptyScanLogged) {
      log(`扫描：含地址候选 ${candidates.length} 个，识别邮件行 ${rows.length} 行`);
      emptyScanLogged = true;
    }

    let matchedCount = 0;
    for (const { row, senderNode, raw } of rows) {
      const info = PH_Selectors.parseRow(row, senderNode, raw);
      if (!info) continue;

      const matched = PH_Storage.matchWatchlist(info.email, watchlist);
      if (matched) {
        matchedCount++;
        highlightRow(row, matched);
        if (!isBaseline && !opts.refreshOnly && info.unread && !reportedKeys.has(info.key)) {
          reportedKeys.add(info.key);
          reportNewMail(info, matched);
        }
      } else {
        unhighlightRow(row);
      }
    }

    if (isBaseline) {
      baselineDone = true;
      log(`基线完成：命中重点邮件 ${matchedCount} 行（基线不发通知）`);
      if (rows.length === 0) {
        warn('未识别到任何邮件行。如果你正停留在邮件列表页，请把某个发件人元素'
          + '（右键 → 检查）的 outerHTML 反馈给开发者用于适配。');
      }
    }
  }

  /** 高亮一行并打上星标 */
  function highlightRow(row, matchedItem) {
    row.classList.add(HIGHLIGHT_CLASS);
    if (!row.querySelector(`[${BADGE_ATTR}]`)) {
      const badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      badge.setAttribute(BADGE_ATTR, '1');
      badge.textContent = '★';
      badge.title = `重点关注：${matchedItem.note || matchedItem.email}`;
      row.insertBefore(badge, row.firstChild);
    }
  }

  /** 取消高亮（名单移除后调用） */
  function unhighlightRow(row) {
    if (!row.classList.contains(HIGHLIGHT_CLASS)) return;
    row.classList.remove(HIGHLIGHT_CLASS);
    row.querySelectorAll(`[${BADGE_ATTR}]`).forEach(b => b.remove());
  }

  /** 上报给 service worker 弹通知 */
  function reportNewMail(info, matchedItem) {
    if (!settings.desktopNotify) return;
    log('发现重点新邮件，上报通知:', info.senderName, info.subject);
    try {
      chrome.runtime.sendMessage({
        type: 'PH_NEW_VIP_MAIL',
        mail: {
          key: info.key,
          senderName: info.senderName,
          email: info.email,
          subject: info.subject,
          timeText: info.timeText,
          note: matchedItem.note || ''
        }
      });
    } catch (e) {
      warn('上报通知失败，扩展上下文可能已失效，请刷新页面', e);
    }
  }

  /** 监听 DOM 变化，去抖后重扫 */
  function observe() {
    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => scan(false), 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();
