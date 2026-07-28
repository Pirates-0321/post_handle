/**
 * 163 网页邮箱 DOM 解析层。
 *
 * 注意：163 邮箱（js6 经典版）页面结构复杂、类名混淆且可能随网易改版变化，
 * 因此本模块不依赖具体类名，采用多策略启发式解析：
 *   1. 发件人列通常带 title 属性（"姓名 <addr@mail.com>"）或 mailto: 链接；
 *   2. 从发件人节点向上回溯找到"邮件行"容器；
 *   3. 未读状态通过加粗字体 / 未读图标等特征推断。
 *
 * 如需适配改版，原则上只改这一个文件。
 */

const PH_Selectors = {
  EMAIL_RE: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  TIME_RE: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}月\d{1,2}日)|(\d{1,2}:\d{2})/,

  /** 可能是"发件人列"的元素 */
  SENDER_CANDIDATE: '[title*="@"], a[href^="mailto:"]',

  /**
   * 从任意文本中提取第一个邮箱地址，返回小写纯地址；没有则返回 null。
   * "张三 <zhangsan@163.com>" -> "zhangsan@163.com"
   */
  extractEmail(text) {
    if (!text) return null;
    const m = String(text).match(this.EMAIL_RE);
    return m ? m[0].toLowerCase() : null;
  },

  /**
   * 在一份 document 中找出所有邮件行。
   * 返回 Array<{ row: Element, senderNode: Element }>
   */
  findMailRows(doc) {
    const results = [];
    const seenRows = new Set();
    const candidates = doc.querySelectorAll(this.SENDER_CANDIDATE);
    for (const node of candidates) {
      const email = this.extractEmail(
        node.getAttribute('title') || node.getAttribute('href') || ''
      );
      if (!email) continue;
      const row = this.findRowContainer(node);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      results.push({ row, senderNode: node });
    }
    return results;
  },

  /**
   * 从发件人节点向上回溯，找到"邮件行"容器。
   * 判定：一个祖先元素，其内部除发件人外还包含时间文本或主题链接，
   * 且尺寸不至于过大（防止一路爬到整个列表容器）。
   */
  findRowContainer(node) {
    let el = node.parentElement;
    let best = null;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      // 命中表格行 / 列表项 / ARIA 行，优先采用
      if (el.matches('tr, li, [role="row"], [mid], [id^="row"]')) return el;
      const rect = el.getBoundingClientRect();
      // 行高一般在 20~80px；超过则说明爬过了头，返回上一个最佳候选
      if (rect.height > 90) break;
      if (rect.height >= 16 && this.TIME_RE.test(el.textContent || '')) {
        best = el;
      }
      // 同层出现 2 个以上邮箱地址，说明已到列表级容器，停止
      const emailsInEl = (el.textContent || '').match(new RegExp(this.EMAIL_RE.source, 'g'));
      if (emailsInEl && emailsInEl.length > 1) break;
    }
    return best;
  },

  /** 推断邮件行是否未读：加粗字体或未读图标 */
  isUnread(row) {
    if (row.querySelector('img[src*="unread" i], i[class*="unread" i], b[class*="unread" i]')) {
      return true;
    }
    // 未读行通常发件人/主题为粗体
    const probes = row.querySelectorAll('span, a, div, b, font');
    for (const p of probes) {
      const fw = parseInt(getComputedStyle(p).fontWeight, 10);
      if (fw >= 600) return true;
    }
    return false;
  },

  /** 提取主题：行内最长的非邮箱、非时间文本片段 */
  extractSubject(row) {
    let subject = '';
    const nodes = row.querySelectorAll('a, span, div');
    for (const n of nodes) {
      if (n.children.length > 0) continue; // 只看叶子文本
      const text = (n.textContent || '').trim();
      if (!text || this.EMAIL_RE.test(text) || this.TIME_RE.test(text)) continue;
      if (text.length > subject.length) subject = text;
    }
    return subject.slice(0, 80);
  },

  /** 提取时间文本（用于生成去重 key） */
  extractTimeText(row) {
    const m = (row.textContent || '').match(this.TIME_RE);
    return m ? m[0] : '';
  },

  /**
   * 解析一行，返回标准化信息对象；解析不出地址返回 null。
   * key 用于新邮件去重（发件人+主题+时间）。
   */
  parseRow(row, senderNode) {
    const raw = senderNode.getAttribute('title') || senderNode.getAttribute('href') || '';
    const email = this.extractEmail(raw);
    if (!email) return null;
    const senderName = raw.includes('<')
      ? raw.split('<')[0].trim()
      : (senderNode.textContent || '').trim();
    const subject = this.extractSubject(row);
    const timeText = this.extractTimeText(row);
    return {
      email,
      senderName: senderName || email,
      subject,
      timeText,
      unread: this.isUnread(row),
      key: `${email}|${subject}|${timeText}`
    };
  }
};

globalThis.PH_Selectors = PH_Selectors;
