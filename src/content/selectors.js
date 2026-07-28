/**
 * 163 网页邮箱 DOM 解析层。
 *
 * 注意：163 邮箱（js6 版）页面结构复杂、类名混淆且可能随网易改版变化，
 * 因此本模块不依赖具体类名，采用多策略启发式解析：
 *   策略1：发件人列的 title / mailto: / aria-label 属性中带邮箱地址；
 *   策略2：可见文本节点中直接出现邮箱地址（如 "裴一发 <1316269041@qq.com>"）；
 *   行容器：优先语义化标签（tr/li/[role=row]/[mid]），否则向上找
 *          "父元素含 ≥3 个同标签子元素"的重复行结构（天然排除阅读窗等孤立元素）。
 *
 * 如需适配改版，原则上只改这一个文件。
 */

const PH_Selectors = {
  EMAIL_RE: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  TIME_RE: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}月\d{1,2}日)|(\d{1,2}:\d{2})/,

  /** 属性中可能带邮箱地址的元素 */
  SENDER_CANDIDATE: '[title*="@"], a[href^="mailto:"], [aria-label*="@"], [data-email]',

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
   * 收集 document 中所有"含邮箱地址"的候选节点。
   * 返回 Array<{ node: Element, raw: string }>，raw 为提取邮箱所用的原始文本。
   */
  findSenderCandidates(doc) {
    const results = [];
    const seen = new Set();

    // 策略1：属性中携带地址（title / href / aria-label / data-email）
    for (const el of doc.querySelectorAll(this.SENDER_CANDIDATE)) {
      const raw = el.getAttribute('title')
        || el.getAttribute('href')
        || el.getAttribute('aria-label')
        || el.getAttribute('data-email')
        || '';
      if (this.extractEmail(raw) && !seen.has(el)) {
        seen.add(el);
        results.push({ node: el, raw });
      }
    }

    // 策略2：文本节点里直接写着地址（遍历文本节点比遍历元素子树便宜得多）
    if (doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = walker.nextNode())) {
        const v = t.nodeValue;
        if (!v || v.length > 200 || !this.EMAIL_RE.test(v)) continue;
        const el = t.parentElement;
        if (!el || seen.has(el) || el.closest('script, style, noscript')) continue;
        seen.add(el);
        results.push({ node: el, raw: v.trim() });
      }
    }
    return results;
  },

  /**
   * 在一份 document 中找出所有邮件行。
   * 返回 Array<{ row, senderNode, raw, email }>
   */
  findMailRows(doc) {
    const out = [];
    const seenRows = new Set();
    for (const cand of this.findSenderCandidates(doc)) {
      const row = this.findRowContainer(cand.node);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      out.push({ row, senderNode: cand.node, raw: cand.raw, email: this.extractEmail(cand.raw) });
    }
    return out;
  },

  /**
   * 从候选节点向上回溯，找到"邮件行"容器。
   * 判定（满足其一）：
   *   a) 语义化行标签：tr / li / [role=row] / [mid] / [data-mid]
   *   b) 某祖先元素的父级包含 ≥3 个同标签兄弟 —— 邮件列表是典型的重复行结构，
   *      阅读窗、写信页里的孤立地址元素不满足此条件，可自然排除。
   */
  findRowContainer(node) {
    const semantic = node.closest('tr, li, [role="row"], [mid], [data-mid]');
    if (semantic) return semantic;

    let el = node.parentElement;
    for (let depth = 0; el && el.parentElement && depth < 10; depth++, el = el.parentElement) {
      const parent = el.parentElement;
      let sameTagCount = 0;
      for (const child of parent.children) {
        if (child.tagName === el.tagName) sameTagCount++;
        if (sameTagCount >= 3) break;
      }
      if (sameTagCount >= 3) {
        const rect = el.getBoundingClientRect();
        // 行尺寸合理性检查：过宽过高说明爬到列表级容器了，返回上一层
        if (rect.height > 200) return null;
        return el;
      }
    }
    return null;
  },

  /** 推断邮件行是否未读：未读图标、加粗字体、或 aria 标记 */
  isUnread(row) {
    if (row.querySelector('img[src*="unread" i], [class*="unread" i], [aria-label*="未读"]')) {
      return true;
    }
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
      if (n.children.length > 0) continue;
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
  parseRow(row, senderNode, raw) {
    const email = this.extractEmail(raw || '');
    if (!email) return null;
    let senderName;
    if (raw.includes('<')) {
      senderName = raw.split('<')[0].replace(/^发件人[:：]?\s*/, '').trim();
    } else if (raw.trim().toLowerCase() === email) {
      senderName = (senderNode.textContent || '').replace(this.EMAIL_RE, '').trim() || email;
    } else {
      senderName = (senderNode.textContent || '').trim() || email;
    }
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
