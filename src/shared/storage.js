/**
 * 存储层封装：重点名单、用户设置、显示名→地址学习映射。
 *
 * 名单项结构（v0.3 起）：{ type, value, note, enabled }
 *   type = 'email'  完整地址，如 boss@company.com（扩展"学习"到该行地址后命中）
 *   type = 'domain' 域名规则，如 @company.com（同上）
 *   type = 'name'   显示名规则，如 裴一发（163 列表 DOM 只有显示名，立即可用）
 * 旧版 { email, note, enabled } 数据在读取时自动迁移。
 * 名单与设置用 chrome.storage.sync（跨设备同步），学习映射用 chrome.storage.local。
 */

const PH_DEFAULT_SETTINGS = {
  desktopNotify: true,
  highlightColor: '#fff1b8'
};

const PH_Storage = {
  /* ---------- 名单 ---------- */

  async getWatchlist() {
    const data = await chrome.storage.sync.get({ watchlist: [] });
    const migrated = data.watchlist.map(item => this._migrate(item)).filter(Boolean);
    if (JSON.stringify(migrated) !== JSON.stringify(data.watchlist)) {
      await this.setWatchlist(migrated);
    }
    return migrated;
  },

  async setWatchlist(list) {
    await chrome.storage.sync.set({ watchlist: list });
  },

  /** 旧版数据 { email, note, enabled } → 新版 { type, value, note, enabled } */
  _migrate(item) {
    if (!item) return null;
    if (item.type && typeof item.value === 'string') return item;
    if (typeof item.email === 'string') {
      return {
        type: item.email.startsWith('@') ? 'domain' : 'email',
        value: item.email.toLowerCase(),
        note: item.note || '',
        enabled: item.enabled !== false
      };
    }
    return null;
  },

  /**
   * 识别规则类型：完整地址 / @域名 / 显示名；无法识别返回 null。
   */
  detectRuleType(input) {
    const v = (input || '').trim();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return 'email';
    if (/^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return 'domain';
    if (v.length >= 1 && v.length <= 50 && !v.includes('@') && !/[<>\\/"']/.test(v)) return 'name';
    return null;
  },

  /** 添加一条规则，返回 { ok, reason?, type? } */
  async addWatchItem(input, note = '') {
    const raw = (input || '').trim();
    const type = this.detectRuleType(raw);
    if (!type) return { ok: false, reason: 'invalid' };
    const value = type === 'name' ? raw : raw.toLowerCase();
    const list = await this.getWatchlist();
    if (list.some(i => i.type === type && i.value === value)) {
      return { ok: false, reason: 'duplicate' };
    }
    list.push({ type, value, note: note.trim(), enabled: true });
    await this.setWatchlist(list);
    return { ok: true, type };
  },

  /** 删除一条规则 */
  async removeWatchItem(type, value) {
    const list = await this.getWatchlist();
    await this.setWatchlist(list.filter(i => !(i.type === type && i.value === value)));
  },

  /**
   * 判断一封邮件是否命中名单。
   * @param {object} mail { name: 显示名, email: 地址（可为空） }
   * @returns 命中的名单项或 null
   */
  matchWatchlist(mail, watchlist) {
    const name = (mail.name || '').trim();
    const email = (mail.email || '').toLowerCase();
    for (const item of watchlist) {
      if (!item.enabled) continue;
      if (item.type === 'name' && name && item.value === name) return item;
      if (item.type === 'email' && email && item.value === email) return item;
      if (item.type === 'domain' && email && email.endsWith(item.value)) return item;
    }
    return null;
  },

  /* ---------- 设置 ---------- */

  async getSettings() {
    const data = await chrome.storage.sync.get({ settings: {} });
    return { ...PH_DEFAULT_SETTINGS, ...data.settings };
  },

  async updateSettings(patch) {
    const settings = await this.getSettings();
    await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
  },

  /* ---------- 显示名→地址 学习映射 ---------- */

  async getNameEmailMap() {
    const data = await chrome.storage.local.get({ nameEmailMap: {} });
    return data.nameEmailMap;
  },

  /** 记录一条 显示名→地址 映射；有实际新增时返回 true */
  async learnNameEmail(name, email) {
    name = (name || '').trim();
    email = (email || '').toLowerCase();
    if (!name || !email) return false;
    const map = await this.getNameEmailMap();
    if (map[name] === email) return false;
    map[name] = email;
    const keys = Object.keys(map);
    if (keys.length > 1000) delete map[keys[0]]; // 容量保护
    await chrome.storage.local.set({ nameEmailMap: map });
    return true;
  }
};

globalThis.PH_Storage = PH_Storage;
globalThis.PH_DEFAULT_SETTINGS = PH_DEFAULT_SETTINGS;
