/**
 * 内容脚本：注入 163 邮箱相关页面的所有 frame。
 * 职责：
 *   1. 扫描邮件列表（div[sign="letter"] 行），对命中重点名单的行高亮 + 星标；
 *   2. MutationObserver 监听列表变化，识别新到达的重点未读邮件并上报通知；
 *   3. 监听发件人 title 属性变化，学习"显示名→地址"映射；
 *   4. 响应 popup 的"当前页面发件人"查询。
 *
 * 新邮件判定：维护"已见过的重点邮件 key"集合。首次见到邮件行的扫描为基线
 * （163 是 React SPA，列表异步渲染，基线必须在列表出现后完成），基线只记录
 * 不通知；之后出现的"新 key"且未读才上报。
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

  /** 本 frame 内已见过的重点邮件 key（跨 frame 通知去重由 service worker 负责） */
  const knownKeys = new Set();
  /** 是否已完成"首次见到邮件行"的基线（列表异步渲染，不能按注入时机算） */
  let sawFirstRows = false;
  let watchlist = [];
  let settings = { desktopNotify: true, highlightColor: '#fff1b8' };
  let nameEmailMap = {};
  let scanSummaryLogged = false;
  let orphanWarned = false;
  let autoRefreshTimer = null;
  let noRefreshBtnWarned = false;

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
        setupAutoRefresh();
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
    setupAutoRefresh();
  }

  /**
   * 定时触发 163 列表的"刷新"按钮。
   * 背景：163 网页版自身按固定间隔轮询服务器，新邮件到达后列表 DOM
   * 不会立刻更新，扩展只能检测 DOM 中的行——主动刷新可把检测延迟
   * 压缩到设定的间隔内。
   */
  function setupAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    const sec = Math.max(Number(settings.autoRefreshSec) || 0, 0);
    if (sec === 0) {
      log('列表自动刷新已关闭（新邮件检测依赖 163 自身刷新节奏）');
      return;
    }
    const interval = Math.max(sec, 30); // 下限 30 秒，避免对服务器造成压力
    autoRefreshTimer = setInterval(tryAutoRefresh, interval * 1000);
    log(`列表自动刷新：每 ${interval} 秒触发一次`);
  }

  function tryAutoRefresh() {
    if (!chrome.runtime || !chrome.runtime.id) return; // 孤儿脚本
    if (!document.body) return;
    // 仅当当前视图是邮件列表时才触发（写信/读信页不打扰）
    if (PH_Selectors.findMailRows(document).length === 0) return;
    const btn = PH_Selectors.findRefreshButton(document);
    if (!btn) {
      if (!noRefreshBtnWarned) {
        noRefreshBtnWarned = true;
        warn('未找到列表"刷新"按钮，自动刷新未生效（163 结构可能已改版）');
      }
      return;
    }
    btn.click();
    log('已自动触发列表刷新（检测新邮件）');
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
   * @param {boolean} isInitScan 是否注入后的首次调用
   * @param {object} opts refreshOnly: 名单/映射变化后重刷高亮，不触发通知
   */
  function scan(isInitScan, opts = {}) {
    // 扩展重载后旧脚本会成为"孤儿"：DOM 操作还在但消息/存储通道已死
    if (!chrome.runtime || !chrome.runtime.id) {
      if (!orphanWarned) {
        orphanWarned = true;
        warn('检测到扩展已重新加载，本页面的扩展脚本已失效，请按 F5 刷新页面');
      }
      return;
    }
    if (!document.body) return;
    if (watchlist.length === 0) {
      if (!scanSummaryLogged) {
        scanSummaryLogged = true;
        log('重点名单为空，跳过扫描（点击工具栏扩展图标可一键关注发件人）');
      }
      return;
    }

    const rows = PH_Selectors.findMailRows(document);
    // 列表尚未渲染出来（React 异步加载）时不算基线
    const isBaselineScan = !sawFirstRows && rows.length > 0;
    if ((isInitScan || !scanSummaryLogged) && rows.length > 0) {
      log(`扫描：识别邮件行 ${rows.length} 行`);
      scanSummaryLogged = true;
    }

    const matchedInfos = [];
    for (const row of rows) {
      const info = resolveRow(row);
      if (!info) continue;

      const matched = PH_Storage.matchWatchlist({ name: info.name, email: info.email }, watchlist);
      if (matched) {
        const isNewKey = !knownKeys.has(info.key);
        if (isNewKey) knownKeys.add(info.key);
        matchedInfos.push(info);
        highlightRow(row, matched);
        if (!isBaselineScan && !opts.refreshOnly && isNewKey && info.unread) {
          reportNewMail(info, matched);
        }
      } else {
        unhighlightRow(row);
      }
    }

    if (isBaselineScan) {
      sawFirstRows = true;
      log(`基线完成：邮件行 ${rows.length} 行，命中重点 ${matchedInfos.length} 行（基线不发通知）`);
      matchedInfos.slice(0, 10).forEach(m =>
        log(`  基线命中: ${m.name} | ${m.unread ? '未读' : '已读'} | ${m.subject}`));
    } else if (isInitScan && rows.length === 0) {
      log('列表尚未渲染（React 异步加载），等待列表出现后再建基线…');
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
    log('发现重点新邮件，上报通知:', info.name, '|', info.subject, '|', info.timeText);
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
      warn('上报通知失败，扩展上下文可能已失效，请按 F5 刷新页面', e);
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
