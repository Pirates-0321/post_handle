/**
 * 存储层封装：重点名单与用户设置的读写。
 * 使用 chrome.storage.sync（可在同一账号的多设备间同步）。
 *
 * 数据结构：
 *   watchlist: Array<{ email: string, note: string, enabled: boolean }>
 *     - email 支持两种形式：完整地址 "boss@company.com"，或域名规则 "@company.com"
 *   settings: { desktopNotify: boolean, highlightColor: string }
 */

const PH_DEFAULT_SETTINGS = {
  desktopNotify: true,
  highlightColor: '#fff1b8'
};

const PH_Storage = {
  /** 读取重点名单 */
  async getWatchlist() {
    const data = await chrome.storage.sync.get({ watchlist: [] });
    return data.watchlist;
  },

  /** 覆盖写入重点名单 */
  async setWatchlist(list) {
    await chrome.storage.sync.set({ watchlist: list });
  },

  /** 添加一条关注项，返回 { ok, reason } */
  async addWatchItem(email, note = '') {
    email = (email || '').trim().toLowerCase();
    if (!PH_Storage.isValidRule(email)) {
      return { ok: false, reason: 'invalid' };
    }
    const list = await PH_Storage.getWatchlist();
    if (list.some(item => item.email === email)) {
      return { ok: false, reason: 'duplicate' };
    }
    list.push({ email, note: note.trim(), enabled: true });
    await PH_Storage.setWatchlist(list);
    return { ok: true };
  },

  /** 按 email 删除一条关注项 */
  async removeWatchItem(email) {
    const list = await PH_Storage.getWatchlist();
    await PH_Storage.setWatchlist(list.filter(item => item.email !== email));
  },

  /** 读取设置（合并默认值） */
  async getSettings() {
    const data = await chrome.storage.sync.get({ settings: {} });
    return { ...PH_DEFAULT_SETTINGS, ...data.settings };
  },

  /** 局部更新设置 */
  async updateSettings(patch) {
    const settings = await PH_Storage.getSettings();
    await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
  },

  /**
   * 校验规则字符串是否合法：
   *   - 完整地址：user@domain.tld
   *   - 域名规则：@domain.tld
   */
  isValidRule(rule) {
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(rule) ||
           /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(rule);
  },

  /**
   * 判断一个发件人地址是否命中名单中的某项。
   * @param {string} senderAddr 已规范化为小写的纯邮箱地址
   * @param {Array} watchlist
   * @returns {object|null} 命中的名单项，未命中返回 null
   */
  matchWatchlist(senderAddr, watchlist) {
    if (!senderAddr) return null;
    const addr = senderAddr.toLowerCase();
    for (const item of watchlist) {
      if (!item.enabled) continue;
      if (item.email.startsWith('@')) {
        if (addr.endsWith(item.email)) return item;
      } else if (addr === item.email) {
        return item;
      }
    }
    return null;
  }
};

// 同时暴露给 content script（页面内）与 popup/options（扩展页面）。
// 扩展页面里是模块级全局，content script 中作为后续脚本共享的全局对象。
globalThis.PH_Storage = PH_Storage;
globalThis.PH_DEFAULT_SETTINGS = PH_DEFAULT_SETTINGS;
