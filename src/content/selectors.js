/**
 * 163 网页邮箱（js6 / React 版）DOM 解析层。
 *
 * 经实测确认的结构（2026-07，6.1b 版本）：
 *   - 邮件行：<div sign="letter" role="link" aria-label="主题 发件人 ： 名字 时间： …">
 *   - 发件人列：行内 <div sign="start-from">，内部 <span class="nui-user"> 只含显示名
 *   - 列表 DOM 不含发件人邮箱地址（地址仅存于 JS 内存 / 悬停时懒填充 title），
 *     因此列表阶段以"显示名"匹配为主，地址匹配依赖学习（见 content.js）。
 * 适配改版时原则上只改这个文件。
 */

const PH_Selectors = {
  EMAIL_RE: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  TIME_RE: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}月\d{1,2}日)|(\d{1,2}:\d{2})/,

  /** 邮件行与发件人列的语义化标记（163 自定义 sign 属性） */
  ROW: '[sign="letter"]',
  SENDER_CELL: '[sign="start-from"]',

  /** 从任意文本中提取第一个邮箱地址（小写）；没有则返回 null */
  extractEmail(text) {
    if (!text) return null;
    const m = String(text).match(this.EMAIL_RE);
    return m ? m[0].toLowerCase() : null;
  },

  /** 找出文档中所有邮件行元素 */
  findMailRows(doc) {
    return Array.from(doc.querySelectorAll(this.ROW));
  },

  /**
   * 查找工具栏"刷新"按钮：按文本匹配（163 显示为"刷 新"，需去空白），
   * 取可见且尺寸最小的候选（按钮本体或其文字节点，点击事件会冒泡到处理器）。
   */
  findRefreshButton(doc) {
    const candidates = [];
    for (const el of doc.querySelectorAll('div, span, a, button')) {
      if (el.children.length > 2) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text !== '刷新') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      candidates.push({ el, area: rect.width * rect.height });
    }
    candidates.sort((a, b) => a.area - b.area);
    return candidates.length ? candidates[0].el : null;
  },

  /**
   * 从行的 aria-label 解析 主题/发件人名/时间。
   * 实测格式："回复：测试重点邮箱收件提醒 发件人 ： 裴一发 时间： 2026年7月28日 10:06 (星期二)"
   */
  parseAriaLabel(label) {
    const result = { subject: '', name: '', timeText: '' };
    if (!label) return result;
    const m = String(label).match(/^(.*?)\s*(?:发件人|收件人)\s*：\s*(.*?)\s*时间：\s*(.*)$/);
    if (m) {
      result.subject = m[1].trim();
      result.name = m[2].trim();
      result.timeText = m[3].replace(/\s*\(.*$/, '').trim();
    }
    return result;
  },

  /** 发件人显示名：优先发件人列文本，兜底 aria-label */
  extractSenderName(row) {
    const cell = row.querySelector(this.SENDER_CELL);
    const name = (cell ? cell.textContent : '').trim();
    if (name) return name;
    return this.parseAriaLabel(row.getAttribute('aria-label')).name;
  },

  /** 发件人列中可提取的地址（悬停懒填充 title 后才可能有，通常为 null） */
  extractEmailFromRow(row) {
    const cell = row.querySelector(this.SENDER_CELL);
    if (!cell) return null;
    const titled = cell.querySelector('[title*="@"]');
    if (titled) return this.extractEmail(titled.getAttribute('title'));
    return this.extractEmail(cell.getAttribute('title') || '');
  },

  extractSubject(row) {
    const fromAria = this.parseAriaLabel(row.getAttribute('aria-label')).subject;
    if (fromAria) return fromAria.slice(0, 80);
    // 兜底：行内最长的非邮箱、非时间叶子文本
    let subject = '';
    for (const n of row.querySelectorAll('a, span, div')) {
      if (n.children.length > 0) continue;
      const text = (n.textContent || '').trim();
      if (!text || this.EMAIL_RE.test(text) || this.TIME_RE.test(text)) continue;
      if (text.length > subject.length) subject = text;
    }
    return subject.slice(0, 80);
  },

  extractTimeText(row) {
    const fromAria = this.parseAriaLabel(row.getAttribute('aria-label')).timeText;
    if (fromAria) return fromAria;
    const m = (row.textContent || '').match(this.TIME_RE);
    return m ? m[0] : '';
  },

  /** 推断未读：未读图标/标记，或行内存在加粗文字 */
  isUnread(row) {
    if (row.querySelector('img[src*="unread" i], [class*="unread" i], [aria-label*="未读"]')) {
      return true;
    }
    for (const p of row.querySelectorAll('span, a, div, b, font')) {
      if (parseInt(getComputedStyle(p).fontWeight, 10) >= 600) return true;
    }
    return false;
  },

  /**
   * 解析一行 → { name, email, subject, timeText, unread, key }；无名返回 null。
   * email 通常为 null（列表不含地址），除非悬停已懒填充 title。
   * key 用于新邮件去重（显示名+主题+时间）。
   */
  parseRow(row) {
    const name = this.extractSenderName(row);
    if (!name) return null;
    const subject = this.extractSubject(row);
    const timeText = this.extractTimeText(row);
    return {
      name,
      email: this.extractEmailFromRow(row),
      subject,
      timeText,
      unread: this.isUnread(row),
      key: `${name}|${subject}|${timeText}`
    };
  }
};

globalThis.PH_Selectors = PH_Selectors;
