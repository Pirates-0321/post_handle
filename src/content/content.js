/**
 * 内容脚本：注入 163 邮箱相关页面的所有 frame。
 * 职责：
 *   1. 扫描邮件列表（div[sign="letter"] 行），对命中重点名单的行高亮 + 星标；
 *   2. MutationObserver 监听列表变化，识别新到达的重点未读邮件并上报通知；
 *   3. 监听发件人 title 属性变化，学习"显示名→地址"映射（悬停发件人时
 *      163 会懒填充地址），学习后地址/域名规则即可命中；
 *   4. 响应 popup 的"当前页面发件人"查询。
 *
 * 诊断：所有日志带 [PH] 前缀，控制台过滤 "[PH]" 即可观察扩展工作状态。
 */

(function () {
  'use strict';

  const HIGHLIGHT_CLASS = 'ph-vip-row';
  const BADGE_CLASS = 'ph-vip-badge';
  const BADGE_ATTR = 'data-ph-badge';

  function log(...args) { console.log('[PH]', ...args); }
  function warn(...args) { console.warn('[PH]', ...args); }

  /** 本 frame 生命周期内已上报过的邮件 key（跨 frame 去重由 service worker 负责） */
  const reportedKeys = new Set();
  let watchlist = [];
  let settings = { desktopNotify: true, highlightColor: '#fff1b8' };
  let nameEmailMap = {};
  let baselineDone = false;
  let scanSummaryLogged = false;

  async function init() {
    log('content script 已注入 frame:', location.href.slice(0, 150));
    try {
      [watchlist, settings, nameEmailMap] = await Promise.all([
        PH_Storage.getWatchlist(),
        PH_Storage.getSettings(),
        PH_Storage.getNameEmailMap()
      ]);
    } catch (e) {
      warn('读取存储失败，扩展上下文可能已失效，请刷新页面', e);
      return;
    }
    log(`名单 ${watchlist.length} 条，已学习地址 ${Object.keys(nameEmailMap).length} 个，桌面通知 ${settings.desktopNotify ? '开' : '关'}`);
    applyHighlightColor();

    // 名单/设置/学习映射变化时实时刷新
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.watchlist) {
        watchlist = (changes.watchlist.newValue || []).map(i => PH_Storage._migrate(i)).filter(Boolean);
        log('名单已更新，重新扫描，共', watchlist.length, '条');
        scan(false, { refreshOnly: true });
      }
      if (area === 'sync' && changes.settings) {
        settings = { ...settings, ...(changes.settings.newValue || {}) };
        applyHighlightColor();
      }
      if (area === 'local' && changes.nameEmailMap) {
        nameEmailMap = changes.nameEmailMap.newValue || {};
        scan(false, { refreshOnly: true });
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

    scan(true);
    observe();
    observeTitleLearning();
  }

  function applyHighlightColor() {
    document.documentElement.style.setProperty('--ph-highlight', settings.highlightColor);
  }

  /** 解析一行并补充学习到的地址；解析失败返回 null */
  function resolveRow(row) {
    const info = PH_Selectors.parseRow(row);
    if (!info) return null;
    if (!info.email && nameEmailMap[info.name]) {
      info.email = nameEmailMap[info.name];
    }
    return info;
  }

  /** 收集本 frame 内可见的发件人（供 popup 展示） */
  function collectVisibleSenders() {
    const out = [];
    const seen = new Set();
    for (const row of PH_Selectors.findMailRows(document)) {
      const info = resolveRow(row);
      if (!info || seen.has(info.name)) continue;
      seen.add(info.name);
      out.push({ name: info.name, email: info.email || null, subject: info.subject });
    }
    return out.slice(0, 20);
  }

  /**
   * 扫描当前 document 的邮件列表。
   * @param {boolean} isBaseline 是否基线扫描（基线只记录、不通知）
   * @param {object} opts refreshOnly: 名单/映射变化后重刷高亮，不触发通知
   */
  function scan(isBaseline, opts = {}) {
    if (!document.body) return;
    if (watchlist.length === 0) {
      if (!scanSummaryLogged) {
        scanSummaryLogged = true;
        log('重点名单为空，跳过扫描（点击工具栏扩展图标可一键关注发件人）');
      }
      return;
    }

    const rows = PH_Selectors.findMailRows(document);
    if ((isBaseline || !scanSummaryLogged) && rows.length > 0) {
      log(`扫描：识别邮件行 ${rows.length} 行`);
      scanSummaryLogged = true;
    }

    let matchedCount = 0;
    for (const row of rows) {
      const info = resolveRow(row);
      if (!info) continue;

      const matched = PH_Storage.matchWatchlist({ name: info.name, email: info.email }, watchlist);
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
        warn('未识别到任何邮件行。若你正停留在邮件列表页，163 页面结构可能已改版，'
          + '请反馈给开发者适配 selectors.js');
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
      badge.title = `重点关注：${matchedItem.note || matchedItem.value}`;
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
    log('发现重点新邮件，上报通知:', info.name, info.subject);
    try {
      chrome.runtime.sendMessage({
        type: 'PH_NEW_VIP_MAIL',
        mail: {
          key: info.key,
          senderName: info.name,
          email: info.email || '',
          subject: info.subject,
          timeText: info.timeText,
          note: matchedItem.note || ''
        }
      });
    } catch (e) {
      warn('上报通知失败，扩展上下文可能已失效，请刷新页面', e);
    }
  }

  /** 监听 DOM 结构变化，去抖后重扫 */
  function observe() {
    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => scan(false), 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * 学习"显示名→地址"：监听 title 属性变化。
   * 悬停发件人时 163 会懒填充其 title（可能含完整地址），抓住机会记录映射。
   */
  function observeTitleLearning() {
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        const el = m.target;
        if (!(el instanceof Element)) continue;
        const cell = el.closest && el.closest(PH_Selectors.SENDER_CELL);
        if (!cell) continue;
        const email = PH_Selectors.extractEmail(el.getAttribute('title'));
        if (!email) continue;
        const row = el.closest(PH_Selectors.ROW);
        const name = (cell.textContent || '').trim();
        if (!name || nameEmailMap[name] === email) continue;
        nameEmailMap[name] = email;
        PH_Storage.learnNameEmail(name, email).then(added => {
          if (added) log(`学习到地址：${name} → ${email}`);
        });
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['title']
    });
  }

  init();
})();
