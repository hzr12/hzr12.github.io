/**
 * 圆圈地图 - 主应用控制器
 * ============================================
 * 协调 MapManager、GPSManager 与 UI 交互
 * 是所有模块的入口
 */

class App {
  constructor() {
    this.mapManager = new MapManager();
    this.gpsManager = new GPSManager();
    this.circleRadius = CONFIG.DEFAULT_RADIUS;
    this.center = null;          // 当前标记位置
    this.myPosition = null;      // 我的位置（GCJ-02，由 GPS 定位设置）
    this.myPositionTime = null;  // 上次定位成功时间戳（毫秒，用于过期检测）
    this.mode = 'click';
    this._circleListEl = null;   // 圆列表 DOM
    this._statusEl = null;       // GPS 状态条
    this._isWatching = false;    // 持续追踪开关
    this._prevDistances = {};    // circleId → 上次距离（米），用于趋势判断
    this._firstFix = true;       // 是否是首次定位
    this._relocating = false;    // 是否正在自动重定位
    this._lastRelocateAttempt = 0; // 上次自动重定位时间戳
    this._lastRawPos = null;     // 上次原始 WGS84 坐标，用于移动距离判断
    this._lastDistPos = null;    // 上次刷新距离的位置，用于 5m 位移节流
    this._panelCollapsed = window.innerWidth <= CONFIG.MOBILE_BREAKPOINT; // 移动端面板默认收起
    this._watchingBeforeHide = false; // 切后台前是否在追踪
    this._restoringView = false;      // 从后台恢复时不飞地图
    this._recentFixes = [];           // 最近定位记录（最多 10 条）
    this._lastRecordedFix = null;     // 上次记录的定位
    this.trail = new Trail();         // #18 轨迹管理独立模块
    this._followMode = false;         // #12 地图跟随模式
    this._isManualPosition = false;   // #13 是否手动设置的位置
    this._manualCenter = false;       // 用户是否通过点击/输入手动设过中心点
    this._dirty = false;              // 是否有未持久化的状态变更
    this._intervalId = null;          // 定时刷新 interval ID
    this._resizeHandler = null;       // 地图 resize 事件处理器引用
    this._visibilityHandler = null;   // visibilitychange 处理器引用
    this._pageHideHandler = null;     // pagehide 处理器引用
    this._pageShowHandler = null;     // pageshow 处理器引用
    this._lastSpeed = null;           // 上次速度（m/s）
    this._lastAltitude = null;        // 上次海拔（米）
    this._lastCalcPos = null;         // 上一个连续定位位置（用于自行计算速度）
    this._lastCalcTime = null;        // 上一个连续定位时间戳
    this._lastAccuracy = null;        // 最近一次定位精度（米），用于精度圈范围判断
    this._theme = 'dark';             // 主题：dark | light
    this._trailSmoothing = true;      // 轨迹平滑开关
    this._processQueue = Promise.resolve(); // GPS 位置处理串行队列
  }

  /**
   * 应用入口
   */
  init() {
    // 初始化地图
    this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

    // 注册中心点变化回调（含选中圆圈回调）
    this.mapManager.onCenterChange = (center, circle) => this._onCenterChanged(center, circle);

    // #13 — 长按地图：GPS 过期时设为手动位置，否则快速创建圆
    this.mapManager.onLongPress = (pos) => this._onMapLongPress(pos);

    // 初始化 UI
    this._setupUI();

    // 移动端面板默认收起 + 响应横竖屏旋转（#4）
    if (this._panelCollapsed) {
      this._bottomPanel.classList.add('collapsed');
    }
    this._panelMediaQuery = window.matchMedia(`(max-width: ${CONFIG.MOBILE_BREAKPOINT}px)`);
    this._panelMediaQuery.addEventListener('change', (e) => {
      this._panelCollapsed = e.matches;
      this._bottomPanel.classList.toggle('collapsed', e.matches);
    });

    // 读取 URL 参数
    this._checkUrlParams();

    // 恢复主题偏好
    this._restoreTheme();

    // 恢复轨迹平滑偏好
    try {
      const pref = localStorage.getItem('circlemap_trail_smooth');
      if (pref !== null) this._trailSmoothing = pref === '1';
    } catch (e) { /* 静默 */ }

    // 从 localStorage 恢复数据
    this._loadState();

    // 初始化轨迹 UI 状态
    this._updateTrailUI();

    // 暴露到全局，方便控制台模拟轨迹
    window._app = this;

    // 天气获取
    this._weatherHtml = '';
    this._fetchWeather();

    // 进入页面后自动启动持续 GPS 追踪
    this._startWatching();

    // 页面可见性变化：后台停 GPS，前台恢复（#6 加 pagehide 兜底 iOS）
    this._pageHideHandler = () => {
      if (this._isWatching) {
        this._watchingBeforeHide = true;
        this._stopWatching();
      }
      if (this.trail.positions.length > 0) {
        Storage.saveTrail(this.trail); // 切后台时保存轨迹
      }
    };
    this._pageShowHandler = () => {
      if (this._watchingBeforeHide) {
        this._watchingBeforeHide = false;
        this._restoringView = true;
        this._startWatching();
      }
    };
    this._visibilityHandler = () => {
      if (document.hidden) {
        this._pageHideHandler();
      } else {
        this._pageShowHandler();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
    window.addEventListener('pagehide', this._pageHideHandler);
    window.addEventListener('pageshow', this._pageShowHandler);

    // 定时刷新状态 & 持久化 & 自动重定位（每 60s）
    this._intervalId = setInterval(() => {
      if (this.myPosition) {
        this._updateStatusBar(true);
        this._updateInfo();
        this._updateCircleList();
        if (this._isPositionStale() && !this._isWatching) {
          this._autoRelocate();
        }
      }
      this._saveState();
    }, CONFIG.POSITION_STALE_MS / 10); // 每 60s
  }

  /* ============= UI 事件绑定 ============= */

  _setupUI() {
    // —— 缓存高频 DOM 元素 ——
    this._latInput = document.getElementById('lat');
    this._lngInput = document.getElementById('lng');
    this._radiusSlider = document.getElementById('radius-slider');
    this._radiusInput = document.getElementById('radius-input');
    this._gpsBtn = document.getElementById('gps-btn');
    this._circleCountEl = document.getElementById('circle-count');
    this._bottomPanel = document.getElementById('bottomPanel');
    this._panelHandle = document.querySelector('.panel-handle');

    // —— 模式切换 ——
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });

    // —— 坐标输入 ——
    let inputTimer;
    const handleCoordInput = () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => this._onCoordInput(), CONFIG.INPUT_DEBOUNCE_MS);
    };

    this._latInput.addEventListener('input', handleCoordInput);
    this._lngInput.addEventListener('input', handleCoordInput);

    // —— 智能粘贴：自动解析多种坐标格式 ——
    const handlePaste = (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const parsed = this._parseCoordText(text);
      if (!parsed) return;
      e.preventDefault();
      this._latInput.value = parsed.lat.toFixed(6);
      this._lngInput.value = parsed.lng.toFixed(6);
      this._onCoordInput();
      Toast.show('✅ 已识别坐标');
    };
    this._latInput.addEventListener('paste', handlePaste);
    this._lngInput.addEventListener('paste', handlePaste);

    // —— 智能解析输入框：粘贴/输入自动读取 ——
    const parseInput = document.getElementById('parse-input');
    let parseTimer;
    parseInput.addEventListener('input', () => {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(() => {
        const text = parseInput.value.trim();
        if (!text) return;
        const parsed = this._parseCoordText(text);
        if (!parsed) return;
        this._latInput.value = parsed.lat.toFixed(6);
        this._lngInput.value = parsed.lng.toFixed(6);
        this._onCoordInput();
        Toast.show('✅ 已识别坐标');
      }, CONFIG.PARSE_DELAY_MS);
    });
    // 回车直接解析
    parseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(parseTimer);
        const text = parseInput.value.trim();
        if (!text) return;
        const parsed = this._parseCoordText(text);
        if (!parsed) return;
        this._latInput.value = parsed.lat.toFixed(6);
        this._lngInput.value = parsed.lng.toFixed(6);
        this._onCoordInput();
        Toast.show('✅ 已识别坐标');
      }
    });

    // —— 半径滑块 & 数字输入双向绑定（#11 对数映射） ——
    const sliderToVal = (sliderPos) => {
      const v = sliderToRadius(sliderPos / (this._radiusSlider.max - this._radiusSlider.min));
      this._radiusInput.value = v;
      this.circleRadius = v;
      return v;
    };
    const valToSlider = (v) => {
      this._setRadiusSliderValue(v);
    };

    this._radiusSlider.addEventListener('input', () => {
      const val = sliderToVal(parseInt(this._radiusSlider.value, 10));
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, val);
        this._dirty = true;
        this._updateInfo();
        this._updateCircleList(true);
      }
    });

    this._radiusInput.addEventListener('change', () => {
      let val = parseInt(this._radiusInput.value, 10);
      if (isNaN(val) || val < CONFIG.MIN_RADIUS) val = CONFIG.MIN_RADIUS;
      if (val > CONFIG.MAX_RADIUS) val = CONFIG.MAX_RADIUS;
      valToSlider(val);
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, val);
        this._dirty = true;
        this._updateCircleList(true);
        this._updateInfo();
      }
    });

    // —— 半径预设快捷按钮 ——
    document.querySelector('.radius-presets').addEventListener('click', (e) => {
      const btn = e.target.closest('.preset-btn');
      if (!btn) return;
      const radius = parseInt(btn.dataset.radius, 10);
      if (isNaN(radius) || radius < CONFIG.MIN_RADIUS || radius > CONFIG.MAX_RADIUS) return;
      this._setRadiusSliderValue(radius);
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, radius);
        this._dirty = true;
        this._updateCircleList(true);
        this._updateInfo();
      }
    });

    // —— #14 设为我当前位置按钮 ——
    document.getElementById('set-mypos-btn').addEventListener('click', () => {
      const lat = parseFloat(this._latInput.value);
      const lng = parseFloat(this._lngInput.value);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        Toast.show('⚠️ 请输入有效的坐标');
        return;
      }
      this._setManualPosition({ lat, lng });
      Toast.show('📍 已设为我当前位置');
    });

    // —— 绘制按钮 ——
    document.getElementById('draw-btn').addEventListener('click', () => this._drawCircle());

    // —— 清除按钮 ——
    document.getElementById('clear-btn').addEventListener('click', () => this._clearAll());

    // —— 轨迹记录按钮 ——
    document.getElementById('trail-record-btn').addEventListener('click', () => this._toggleTrailRecording());
    document.getElementById('trail-clear-btn').addEventListener('click', () => this._clearTrail());
    document.getElementById('trail-export-btn').addEventListener('click', () => this._exportGpx());
    document.getElementById('trail-stats-btn').addEventListener('click', () => this._showTrailStats());
    document.getElementById('trail-smooth-btn').addEventListener('click', () => this._toggleTrailSmoothing());

    // —— 对方位置标记（复用坐标输入区） ——
    this._targetInfoEl = document.getElementById('target-info');
    this._targetClearBtn = document.getElementById('target-clear-btn');
    this._targetRange = document.getElementById('target-range');
    this._targetRangeInput = document.getElementById('target-range-input');
    this._targetRangeRow = document.getElementById('target-range-row');
    document.getElementById('target-set-btn').addEventListener('click', () => this._setTargetPosition());
    this._targetClearBtn.addEventListener('click', () => this._clearTarget());
    // 精度范围：滑块 ↔ 输入框双向同步
    this._targetRange.addEventListener('input', () => {
      const v = parseInt(this._targetRange.value);
      this._targetRangeInput.value = v;
      if (this._targetPos) this.mapManager.setTargetRange(v);
    });
    this._targetRangeInput.addEventListener('input', () => {
      let v = parseInt(this._targetRangeInput.value) || 0;
      if (v < 0) v = 0;
      if (v > 5000) v = 5000;
      this._targetRange.value = v;
      if (this._targetPos) this.mapManager.setTargetRange(v);
    });

    // —— 复制我方坐标 ——
    document.getElementById('copy-mypos-btn').addEventListener('click', () => {
      if (!this.myPosition) {
        Toast.show('⚠️ 尚无定位，请先定位');
        return;
      }
      const text = `${this.myPosition.lat.toFixed(6)}, ${this.myPosition.lng.toFixed(6)}`;
      navigator.clipboard.writeText(text).then(() => {
        Toast.show(`📋 已复制: ${text}`);
      }).catch(() => {
        Toast.show('⚠️ 复制失败');
      });
    });

    // —— GPS 状态条缓存 + #12 点击切换跟随模式 ——
    this._statusEl = document.getElementById('gps-status');
    this._statusEl.addEventListener('click', () => this._toggleFollowMode());
    this._statusEl.style.cursor = 'pointer';

    // —— GPS 按钮：短按单次定位，长按切换持续追踪 ——
    let pressTimer = null;
    let isLongPress = false;
    this._gpsBtn.addEventListener('pointerdown', () => {
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        this._toggleGps();
        pressTimer = null;
      }, CONFIG.LONGPRESS_THRESHOLD_MS);
    });
    this._gpsBtn.addEventListener('pointerup', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!isLongPress) this._locateMe();
    });
    this._gpsBtn.addEventListener('pointerleave', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });

    // —— 底部面板折叠切换 ——
    this._panelHandle.addEventListener('click', () => {
      this._panelCollapsed = !this._panelCollapsed;
      this._bottomPanel.classList.toggle('collapsed', this._panelCollapsed);
    });

    // —— 主题切换按钮 ——
    document.getElementById('theme-btn').addEventListener('click', () => this._toggleTheme());

    // —— 圆列表事件委托（选中/编辑/删除） ——
    this._circleListEl = document.getElementById('circle-list');
    this._circleListEl.addEventListener('click', (e) => {
      const item = e.target.closest('.circle-item');
      const editBtn = e.target.closest('.circle-edit');
      const delBtn = e.target.closest('.circle-del');
      if (!item) return;
      const id = parseInt(item.dataset.id);
      if (editBtn) {
        this._editCircle(id);
      } else if (delBtn) {
        this._deleteCircle(id);
      } else {
        this._selectCircle(id);
      }
    });

    // —— 点击坐标复制 ——
    document.getElementById('info-center').addEventListener('click', function () {
      const text = this.textContent;
      if (!text || text === '--') return;
      navigator.clipboard.writeText(text).then(() => {
        const app = window.app;
        if (app) Toast.show('✅ 已复制坐标');
      }).catch(() => {
        // clipboard API 可能被拒绝，降级
      });
    });
  }

  /**
   * 统一设置半径滑块 + 数字输入 + 当前半径
   * 替代 5 处重复的 slider/input 赋值（DRY）
   * @param {number} v 半径值（米）
   */
  _setRadiusSliderValue(v) {
    const sMin = parseInt(this._radiusSlider.min, 10);
    this._radiusSlider.value = Math.round(radiusToSlider(v) * (this._radiusSlider.max - this._radiusSlider.min)) + sMin;
    this._radiusInput.value = v;
    this.circleRadius = v;
  }

  /* ============= 核心交互方法 ============= */

  /**
   * 切换选择模式
   * @param {'click'|'input'} mode
   */
  _setMode(mode) {
    this.mode = mode;
    this.mapManager.setMode(mode);

    // 切换标签状态
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // 显示/隐藏输入区
    const inputGroup = document.getElementById('inputGroup');
    inputGroup.classList.toggle('visible', mode === 'input');

    // 显示/隐藏点击提示
    const clickHint = document.getElementById('clickHint');
    clickHint.classList.toggle('hidden', mode === 'input');
  }

  /**
   * 中心点变更 / 圆圈选中的回调
   * @param {{lat:number,lng:number}} center
   * @param {object} [circle] - 选中的圆圈对象
   */
  _onCenterChanged(center, circle) {
    this.center = center;

    // 同步到输入框
    this._latInput.value = center.lat.toFixed(6);
    this._lngInput.value = center.lng.toFixed(6);

    if (circle) {
      // 通过点击圆心选中 → 更新半径滑块和信息面板（#11 对数映射）
      this._setRadiusSliderValue(circle.maxRadius);
    }
    this._updateInfo();
    this._updateCircleList(true);
    this._manualCenter = true; // 用户点击/选中标记 → 不再被 GPS 覆盖
    this._dirty = true;
  }

  /**
   * 智能解析粘贴文本中的经纬度
   * 支持格式：
   *   "23.1291, 113.2644"         → 逗号分隔
   *   "23.1291 113.2644"           → 空格分隔
   *   "lat 23.1291 lng 113.2644"   → 带标签
   *   "纬度:23.1291 经度:113.2644" → 中文标签
   *   "39.9°N 116.4°E"             → 度分秒简写
   *   "N 39.9 E 116.4"             → 前缀格式（#8）
   * @param {string} text
   * @returns {{lat:number,lng:number}|null}
   */
  _parseCoordText(text) {
    if (!text) return null;
    // 提取所有数字（含负号和小数点）
    const nums = text.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 2) return null;

    // 判断是否带 N/S/E/W 方向标识（#8 修正重复字符）
    const hasNS = /[北n]|north/i.test(text);
    const hasEW = /[东e]|east/i.test(text);

    // 根据上下文确定 lat/lng
    if (hasNS && hasEW) {
      // 方向标识模式：找到含 N/S 的作为纬度，含 E/W 的作为经度
      const parts = text.split(/[,，\s]+/).filter(Boolean);
      let lat, lng;
      for (const p of parts) {
        const n = parseFloat(p);
        if (isNaN(n)) continue;
        // 只匹配明确的 N/S/E/W 方向标记，防止字母 s 误匹配 "East" 等单词
        if (/(?:北|南|(?:^|[°\s])[nNsS](?:$|[°\s])|[nN]orth|[sS]outh)/i.test(p)) lat = n;
        if (/(?:东|西|(?:^|[°\s])[eEwW](?:$|[°\s])|[eE]ast|[wW]est)/i.test(p)) lng = n;
      }
      if (lat != null && lng != null) return { lat, lng };
    }

    // 检测中文/英文标签
    const hasLatLabel = /(纬度?|lat)/i.test(text);
    const hasLngLabel = /(经度?|lng|lon|long)/i.test(text);

    if (hasLatLabel || hasLngLabel) {
      const latMatch = text.match(/(?:纬度?|lat)\s*[:：=\s]*(-?\d+\.?\d*)/i);
      const lngMatch = text.match(/(?:经度?|lng|lon|long)\s*[:：=\s]*(-?\d+\.?\d*)/i);
      const lat = latMatch ? parseFloat(latMatch[1]) : NaN;
      const lng = lngMatch ? parseFloat(lngMatch[1]) : NaN;
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // 方向前缀格式："N 39.9 E 116.4" 或 "N39.9 E116.4"（#8）
    const prefixMatch = text.match(/^[NnSs]\s*([\d.]+)\s*[EeWw]\s*([\d.]+)/);
    if (prefixMatch) {
      const lat = parseFloat(prefixMatch[1]);
      const lng = parseFloat(prefixMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // 默认：取前两个数字作 lat, lng
    const lat = parseFloat(nums[0]);
    const lng = parseFloat(nums[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };

    return null;
  }

  /**
   * 手动输入坐标 → 仅定位，不自动绘制
   */
  _onCoordInput() {
    const lat = parseFloat(this._latInput.value);
    const lng = parseFloat(this._lngInput.value);

    if (!isNaN(lat) && !isNaN(lng) &&
        lat >= -90 && lat <= 90 &&
        lng >= -180 && lng <= 180) {
      this.center = { lat, lng };
      this.mapManager.setCenter(this.center);
      this._manualCenter = true; // 手动输入坐标 → 不再被 GPS 覆盖
      this._dirty = true;
    }
  }

  /**
   * #13 — 长按地图回调
   * GPS 过期/手动模式时设为当前位置；否则快速创建圆
   */
  _onMapLongPress(pos) {
    if (!pos) return;
    if (this._isPositionStale() || this._isManualPosition) {
      this._setManualPosition(pos);
      Toast.show('📍 已设为当前位置（手动）');
    } else {
      // 直接以当前半径创建圆
      if (!this.center) {
        this.center = pos;
        this.mapManager.setCenter(pos);
      }
      this._drawCircle();
    }
  }

  /**
   * #13 — 手动设置"我的位置"
   * @param {{lat:number,lng:number}} pos
   */
  _setManualPosition(pos) {
    this.myPosition = pos;
    this.myPositionTime = Date.now();
    this._isManualPosition = true;
    this._prevDistances = {};
    this._lastAccuracy = 50;
    this.mapManager.setLocation(pos, 50); // 手动定位默认精度 50m
    this._recordFix({ ...pos, accuracy: 50 }, pos, true); // 手动定位加入最近列表
    this._updateStatusBar(true);
    this._updateCircleList(true);
    this._updateInfo();
    this._dirty = true;
    this._saveState();
    // 手动定位也刷新天气
    this._fetchWeather();
  }

  /**
   * 添加一个同心圆
   */
  _drawCircle() {
    if (!this.center) {
      Toast.show('请先选择中心点（点击地图或输入坐标）');
      return;
    }
    // 直接从输入框读取半径值（绕过 change 事件不触发问题）
    const inputVal = parseInt(this._radiusInput.value, 10);
    const radius = (!isNaN(inputVal) && inputVal >= CONFIG.MIN_RADIUS && inputVal <= CONFIG.MAX_RADIUS)
      ? inputVal
      : this.circleRadius;
    this.circleRadius = radius;

    if (this.circleRadius <= 0) {
      Toast.show('请输入有效的半径');
      return;
    }

    this.mapManager.addCircle(this.center, this.circleRadius);
    this._updateInfo();
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();
    Toast.show(`已创建同心圆，半径 ${
      this.circleRadius >= 1000
        ? (this.circleRadius / 1000).toFixed(1) + ' km'
        : this.circleRadius + ' m'
    }`);
  }

  /**
   * 切换持续追踪（长按 GPS 按钮）
   */
  _toggleGps() {
    if (this._isWatching) {
      this._stopWatching();
    } else {
      this._startWatching();
    }
  }

  /**
   * 单次定位（短按 GPS 按钮）
   * 获取一次位置并飞到该处，不开启持续追踪
   */
  async _locateMe() {
    if (this._isWatching) return;
    if (this._relocating) return;
    this._relocating = true;

    this._gpsBtn.classList.add('loading');
    this._gpsBtn.disabled = true;

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.center = convPos;
      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._isManualPosition = false; // #13 GPS 定位覆盖手动
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
      this._lastCalcTime = pos.timestamp || Date.now();
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);

      this.mapManager.setCenter(convPos);
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading); // #17 精度环
      this.mapManager.flyTo(convPos);

      this._latInput.value = convPos.lat.toFixed(6);
      this._lngInput.value = convPos.lng.toFixed(6);

      this._updateStatusBar(true);
      this._updateCircleList(true);
      this._updateInfo();

      this._gpsBtn.classList.add('located');
      setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);

      Toast.show(`✅ 定位成功（精度 ±${pos.accuracy.toFixed(0)} 米）`);
    } catch (err) {
      Toast.show('❌ ' + err.message);
      this._gpsBtn.classList.remove('located');
    } finally {
      this._gpsBtn.classList.remove('loading');
      this._gpsBtn.disabled = false;
      this._relocating = false;
    }
  }

  /**
   * 启动持续 GPS 追踪（纯 watchPosition）
   */
  _startWatching() {
    if (this._isWatching) return;

    this._isWatching = true;
    this._firstFix = true;
    this._manualCenter = false; // 重新开启 GPS 追踪 → 取消手动锁定

    this._gpsBtn.classList.add('watching');
    this._gpsBtn.title = '正在持续追踪位置';

    this.gpsManager.onPositionChange = (pos) => {
      this._processQueue = this._processQueue
        .then(() => this._processPosition(pos))
        .catch(() => {}); // 防止队列断裂
    };
    this.gpsManager.onError = (err) => {
      console.warn('[GPS] 追踪出错:', err.message);
      Toast.show('⚠️ GPS 追踪异常：' + err.message);
    };
    this.gpsManager.startWatching();

    Toast.show('📍 持续追踪已开启');
  }

  /**
   * 停止持续 GPS 追踪
   */
  _stopWatching() {
    if (!this._isWatching) return;
    this._isWatching = false;

    this.gpsManager.stopWatching();
    this._prevDistances = {};

    this._gpsBtn.classList.remove('watching');
    this._gpsBtn.title = '定位到我的位置';

    Toast.show('⏹ 持续追踪已关闭');
  }

  /**
   * 获取渲染用的轨迹坐标数组（根据平滑开关决定是否平滑）
   * @returns {Array}
   */
  _getTrailPositions() {
    return this._trailSmoothing
      ? this.trail.getSmoothedPositions()
      : this.trail.positions;
  }

  /**
   * 清除历史轨迹
   */
  _clearTrail() {
    const savedPositions = this.trail.positions.slice();
    const savedLastPos = this.trail.lastPos;

    this.trail.clear();
    this.mapManager.clearTrail();
    this._updateTrailUI();
    Storage.saveTrail(this.trail); // 清除持久化

    this._showUndoToast('轨迹已清除', () => {
      this.trail.positions = savedPositions;
      this.trail.lastPos = savedLastPos;
      if (savedPositions.length >= 2) {
        this.mapManager.setTrail(this._getTrailPositions());
      }
      this._updateTrailUI();
      Storage.saveTrail(this.trail);
    });
  }

  /**
   * 切换轨迹记录状态
   */
  _toggleTrailRecording() {
    if (this.trail.isRecording) {
      this.trail.stop();
      Storage.saveTrail(this.trail); // 停止时保存最终轨迹
      Toast.show('⏹ 轨迹记录已停止');
    } else {
      this.trail.start();
      this.mapManager.clearTrail();
      Toast.show('⏺ 轨迹记录已开始');
    }
    this._updateTrailUI();
  }

  /**
   * 导出 GPX 文件（#18 — 委托给 GpxExport 模块，含#7 schema修复）
   */
  _exportGpx() {
    const trajectories = this.trail.positions;
    if (trajectories.length < 2) {
      Toast.show('⚠️ 轨迹点太少，无法导出（至少需要 2 个点）');
      return;
    }
    const ok = GpxExport.export(trajectories);
    if (ok) {
      Toast.show('✅ 已导出 GPX（' + trajectories.length + ' 个点，' + this._getTrailDistance() + '）');
    }
  }

  /**
   * 切换轨迹平滑开关
   */
  _toggleTrailSmoothing() {
    this._trailSmoothing = !this._trailSmoothing;
    // 保存偏好
    try {
      localStorage.setItem('circlemap_trail_smooth', this._trailSmoothing ? '1' : '0');
    } catch (e) { /* 静默 */ }
    // 刷新轨迹渲染
    if (this.trail.positions.length >= 2) {
      this.mapManager.setTrail(this._getTrailPositions());
    }
    this._updateTrailUI();
    Toast.show(this._trailSmoothing ? '✨ 轨迹平滑已开启' : '⬜ 轨迹平滑已关闭');
  }

  /**
   * 显示轨迹统计面板
   */
  _showTrailStats() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show('⚠️ 轨迹点数不足（至少 2 个点）');
      return;
    }

    const totalDist = this.trail.getDistance();

    // 总时长（用首尾点的时间戳）
    const firstTime = pos[0].time || null;
    const lastTime = pos[pos.length - 1].time || null;
    let durationMs = 0;
    if (firstTime && lastTime && lastTime > firstTime) {
      durationMs = lastTime - firstTime;
    }

    // 最高速度
    let maxSpeed = 0;
    let hasSpeed = false;
    for (const p of pos) {
      if (p.speed != null && p.speed > maxSpeed) {
        maxSpeed = p.speed;
        hasSpeed = true;
      }
    }

    // 平均速度（总距离 / 总时长）
    const avgSpeed = durationMs > 0 ? totalDist / (durationMs / 1000) : 0;

    // 格式化时间
    const fmtTime = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const fmtDate = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const datePart = (d.getMonth() + 1) + '/' + d.getDate();
      return datePart + ' ' + fmtTime(ts);
    };

    // 格式化时长（秒 → HH:MM:SS）
    const fmtDuration = (ms) => {
      if (ms <= 0) return '--';
      const totalSec = Math.round(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
      return `${s}秒`;
    };

    // 填充或创建 modal
    const overlay = document.getElementById('stats-modal');
    if (overlay) {
      // 填充数据
      document.getElementById('stat-distance').textContent = formatDistance(totalDist);
      document.getElementById('stat-duration').textContent = fmtDuration(durationMs);
      document.getElementById('stat-avg-speed').textContent = avgSpeed > 0
        ? (avgSpeed * 3.6).toFixed(1) + ' km/h'
        : (hasSpeed ? '--' : '--');
      document.getElementById('stat-max-speed').textContent = hasSpeed
        ? (maxSpeed * 3.6).toFixed(1) + ' km/h'
        : '--';
      document.getElementById('stat-points').textContent = pos.length;
      document.getElementById('stat-start-time').textContent = fmtDate(firstTime);
      document.getElementById('stat-end-time').textContent = fmtDate(lastTime);
      overlay.classList.add('show');
      return;
    }

    // 首次创建 modal
    const html = `<div id="stats-modal" class="modal-overlay show">
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">📊 轨迹统计</span>
          <button class="modal-close" id="stats-close-btn">✕</button>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><span class="stat-label">总距离</span><span class="stat-value" id="stat-distance">${formatDistance(totalDist)}</span></div>
          <div class="stat-card"><span class="stat-label">总时长</span><span class="stat-value" id="stat-duration">${fmtDuration(durationMs)}</span></div>
          <div class="stat-card"><span class="stat-label">平均速度</span><span class="stat-value" id="stat-avg-speed">${avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">最高速度</span><span class="stat-value warning" id="stat-max-speed">${hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">轨迹点数</span><span class="stat-value accent2" id="stat-points">${pos.length}</span></div>
          <div class="stat-card"><span class="stat-label">开始时间</span><span class="stat-value" id="stat-start-time">${fmtDate(firstTime)}</span></div>
          <div class="stat-card full"><span class="stat-label">结束时间</span><span class="stat-value" id="stat-end-time">${fmtDate(lastTime)}</span></div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    // 点击 overlay 外部区域关闭
    const mo = document.getElementById('stats-modal');
    const box = mo.querySelector('.modal-box');
    mo.addEventListener('click', (e) => {
      if (!box.contains(e.target)) {
        mo.classList.remove('show');
        setTimeout(() => mo.remove(), 300);
      }
    });
    document.getElementById('stats-close-btn').addEventListener('click', () => {
      mo.classList.remove('show');
      setTimeout(() => mo.remove(), 300);
    });
  }

  /**
   * 计算轨迹总移动距离
   */
  _getTrailDistance() {
    const dist = this.trail.getDistance();
    return formatDistance(dist);
  }

  /**
   * 更新轨迹 UI（按钮状态 + 距离显示）
   */
  _updateTrailUI() {
    const btn = document.getElementById('trail-record-btn');
    const clearBtn = document.getElementById('trail-clear-btn');
    const exportBtn = document.getElementById('trail-export-btn');
    const statsBtn = document.getElementById('trail-stats-btn');
    const smoothBtn = document.getElementById('trail-smooth-btn');
    const distEl = document.getElementById('trail-distance');

    // 记录按钮
    if (btn) {
      btn.classList.toggle('recording', this.trail.isRecording);
      btn.innerHTML = this.trail.isRecording
        ? '<span class="trail-dot"></span> 记录中...'
        : '<span class="trail-dot"></span> 开始记录';
    }

    // 距离
    const dist = this.trail.getDistance();
    if (distEl) {
      distEl.textContent = dist > 0 ? formatDistance(dist) : '0m';
    }

    // 操作按钮状态
    const hasPoints = this.trail.positions.length > 0;
    if (clearBtn) clearBtn.disabled = !hasPoints;
    if (exportBtn) exportBtn.disabled = this.trail.positions.length < 2;
    if (statsBtn) statsBtn.disabled = this.trail.positions.length < 2;

    // 平滑按钮状态
    if (smoothBtn) {
      smoothBtn.classList.toggle('active', this._trailSmoothing);
      smoothBtn.innerHTML = this._trailSmoothing
        ? '<span class="smooth-icon">✨</span> 平滑'
        : '<span class="smooth-icon">⬜</span> 平滑';
    }
  }

  /* ========== 通用位置处理 ========== */

  /**
   * 记录一次定位到最近列表（最多 10 条）
   */
  _recordFix(pos, convPos, isManual) {
    this._recentFixes.push({
      time: Date.now(),
      lat: convPos.lat,
      lng: convPos.lng,
      accuracy: pos.accuracy || 0,
      speed: pos.speed,
      heading: pos.heading,
      isManual: !!isManual
    });
    if (this._recentFixes.length > CONFIG.MAX_RECENT_FIXES) {
      this._recentFixes = this._recentFixes.slice(-CONFIG.MAX_RECENT_FIXES);
    }
    this._updateRecentFixes();
  }

  /**
   * 渲染最近定位列表
   */
  _updateRecentFixes() {
    const listEl = document.getElementById('fix-list');
    if (!listEl) return;
    const countEl = document.getElementById('fix-count');
    if (!this._recentFixes.length) {
      listEl.innerHTML = '<div class="empty-state">暂无定位数据</div>';
      if (countEl) countEl.textContent = '0';
      return;
    }
    if (countEl) countEl.textContent = this._recentFixes.length;
    let html = '';
    for (let i = this._recentFixes.length - 1; i >= 0; i--) {
      const f = this._recentFixes[i];
      const d = new Date(f.time);
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const accStr = f.accuracy ? `±${f.accuracy.toFixed(0)}m` : '--';
      let accClass = 'acc-poor';
      if (f.accuracy < 15) accClass = 'acc-good';
      else if (f.accuracy < 50) accClass = 'acc-ok';
      const manualTag = f.isManual ? ' <span class="fix-manual">📍 手动</span>' : '';
      const coordStr = `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`;
      html += `<div class="fix-item">
        <span class="fix-time">${timeStr}</span>
        <span class="fix-accuracy ${accClass}">${accStr}</span>
        <span class="fix-coord">${coordStr}${manualTag}</span>
      </div>`;
    }
    listEl.innerHTML = html;
  }

  /**
   * 处理位置数据：GCJ-02 转换 + UI 刷新
   */
  async _processPosition(pos) {
    try {
    // 跟踪原始坐标用于下次位移判断
    this._lastRawPos = {lat: pos.lat, lng: pos.lng};

    const convPos = await this.mapManager.wgs84ToGcj02(pos);

    // 保存速度/海拔
    // 浏览器 speed 常为 null（尤其桌面/首次定位），用连续定位的距离/时间自行计算
    if (pos.speed != null) {
      this._lastSpeed = pos.speed;
    } else if (this._lastCalcPos) {
      const dt = (pos.timestamp || Date.now()) - this._lastCalcTime;
      if (dt > 100) { // 至少 100ms 才计算，避免除零或噪音
        const dist = calcDistance(this._lastCalcPos, convPos);
        this._lastSpeed = dist / (dt / 1000); // m/s
      }
    } else {
      this._lastSpeed = null;
    }
    this._lastAltitude = pos.altitude;
    this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
    this._lastCalcTime = pos.timestamp || Date.now();
    this._lastAccuracy = pos.accuracy;

    // 保存定位信息
    this.myPosition = convPos;
    this.myPositionTime = Date.now();
    this._isManualPosition = false; // #13 GPS 定位覆盖手动
    // 记录到最近列表
    this._recordFix(pos, convPos);

    // GPS 定位成功后刷新天气（使用精确坐标）
    this._fetchWeather();

    // 更新位置标记 + 精度环（#17）
    this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

    if (this._firstFix) {
      this._firstFix = false;

      if (this._restoringView) {
        // 从后台恢复：更新位置但不飞地图，不弹 toast
        this._restoringView = false;
      } else {
        // 首次定位或手动开启追踪：飞到我的位置
        this.center = convPos;
        this.mapManager.flyTo(convPos);

        // 同步到输入框
        this._latInput.value = convPos.lat.toFixed(6);
        this._lngInput.value = convPos.lng.toFixed(6);

        this._gpsBtn.classList.add('located');
        setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);

        Toast.show(`✅ 定位成功（精度 ±${pos.accuracy.toFixed(0)} 米）`);
      }
    } else if (this._isWatching) {
      // 用户手动选过中心点 → 不覆盖 center（GPS 只更新自身位置标记）
      if (!this._manualCenter) {
        this.center = convPos;
      }
      // 同步到输入框（保持输入坐标与当前位置一致）
      this._latInput.value = convPos.lat.toFixed(6);
      this._lngInput.value = convPos.lng.toFixed(6);
      // #12 — 跟随模式：每次位置更新都移动地图视角
      if (this._followMode) {
        this.mapManager.flyTo(convPos);
      }
    }

    // —— 记录历史轨迹（通过 Trail 模块，#18） ——
    if (this.trail.isRecording) {
      const added = this.trail.addPoint({
        lat: convPos.lat,
        lng: convPos.lng,
        wgsLat: pos.lat,
        wgsLng: pos.lng,
        time: pos.timestamp || Date.now(),
        accuracy: pos.accuracy || 0,
        speed: pos.speed,
        heading: pos.heading
      });
      if (added) {
        this.mapManager.setTrail(this._getTrailPositions());
        this._updateTrailUI();
      }
    }

    // 位移 >N 米才重建圆列表（省性能）
    if (!this._lastDistPos || calcDistance(convPos, this._lastDistPos) > CONFIG.MIN_DISPLACEMENT_M) {
      this._lastDistPos = convPos;
      this._updateCircleList(true);
    }
    this._updateStatusBar(true); // 刷新状态条（含 elapsed 时间）
    this._updateInfo();
    // 更新对方距离
    if (this._targetPos) {
      const dist = calcDistance(convPos, this._targetPos);
      this._targetInfoEl.textContent = `${this._targetPos.lat.toFixed(6)}, ${this._targetPos.lng.toFixed(6)} · 距我 ${formatDistance(dist)}`;
    }
    } catch (e) {
      console.error('_processPosition error:', e.message);
    }
  }

  /**
   * 定位过期时的自动重定位（单次尝试，不开启追踪）
   * 由 60s 定时器触发，仅当位置过期且未在追踪时执行
   */
  async _autoRelocate() {
    // 防止并发 / 频繁重试（失败后至少等 N 分钟）
    if (this._relocating) return;
    if (Date.now() - this._lastRelocateAttempt < CONFIG.RELOCATE_INTERVAL_MS) return;

    this._relocating = true;
    Toast.show('⏳ 定位已过期，正在重新定位...');

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._isManualPosition = false; // #13 GPS 定位覆盖手动
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading); // #17 精度环
      this._prevDistances = {}; // 重置趋势缓存

      this._updateStatusBar(true);
      this._updateCircleList(true);
      this._updateInfo();

    } catch (err) {
      console.warn('[AutoRelocate] 重定位失败:', err.message);
      // 失败后留待下一个周期再试（依靠 _lastRelocateAttempt 控制频率）
    } finally {
      this._relocating = false;
      this._lastRelocateAttempt = Date.now();
    }
  }

  /**
   * 设置对方位置标记
   */
  _setTargetPosition() {
    const lat = parseFloat(this._latInput.value);
    const lng = parseFloat(this._lngInput.value);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      Toast.show('⚠️ 请输入有效的坐标');
      return;
    }
    this._targetPos = { lat, lng };
    const range = parseInt(this._targetRange.value) || 0;
    this.mapManager.setTarget(this._targetPos, range);
    this._targetClearBtn.disabled = false;
    this._targetRangeRow.classList.remove('hidden');
    this._targetInfoEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (this.myPosition) {
      const dist = calcDistance(this.myPosition, this._targetPos);
      this._targetInfoEl.textContent += ` · 距我 ${formatDistance(dist)}`;
    }
    Toast.show('📍 已标记对方位置');
  }

  /**
   * 清除对方位置标记
   */
  _clearTarget() {
    this._targetPos = null;
    this.mapManager.setTarget(null);
    this._targetClearBtn.disabled = true;
    this._targetInfoEl.textContent = '';
    this._targetRangeRow.classList.add('hidden');
    this._targetRange.value = 0;
    this._targetRangeInput.value = 0;
  }

  /**
   * 清除所有同心圆（支持撤销）
   */
  _clearAll() {
    const savedCircles = this.mapManager.circles.slice();
    const savedSelectedId = this.mapManager.selectedCircleId;

    this.mapManager.clearCircles();
    document.getElementById('infoArea').classList.add('hidden');
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();

    this._showUndoToast('已清除全部', () => {
      this.mapManager.circles = savedCircles;
      this.mapManager.selectedCircleId = savedSelectedId;
      if (savedSelectedId != null) {
        this._setRadiusSliderValue(
          this.mapManager.circles.find(c => c.id === savedSelectedId)?.maxRadius || CONFIG.DEFAULT_RADIUS
        );
      }
      this.mapManager._scheduleRedraw();
      this._updateInfo();
      this._updateCircleList(true);
      this._updateStatusBar(true);
      this._dirty = true;
      this._saveState();
    });
  }

  /* ============= 状态 & 信息更新 ============= */

  /** 定位过期阈值（毫秒） */
  get POSITION_STALE_MS() { return CONFIG.POSITION_STALE_MS; }

  /**
   * 检查上次定位是否已过期
   */
  _isPositionStale() {
    return this.myPositionTime !== null && (Date.now() - this.myPositionTime) > this.POSITION_STALE_MS;
  }

  /**
   * 格式化解上次定位已过时间
   */
  _formatElapsed() {
    if (this.myPositionTime === null) return '';
    const diff = Date.now() - this.myPositionTime;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min}分钟前`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}小时${m}分钟前` : `${h}小时前`;
  }

  /**
   * 计算距圆心的距离、方位角、范围内外、趋势
   * @param {{id:number,center:{lat:number,lng:number},maxRadius:number}} circle
   * @returns {{dist:number, bearing:number, bearingStr:string, within:boolean, stale:boolean, trend:string, trendHtml:string}}
   */
  _calcCircleTrend(circle) {
    const dist = calcDistance(this.myPosition, circle.center);
    const bearing = calcBearing(this.myPosition, circle.center);
    const bearingStr = `${Math.round(bearing)}° ${bearingToDir(bearing)}`;
    const accuracy = this._lastAccuracy || 0;
    // 三态范围：'inrange' 确定在圆内 / 'maybe' 精度圈与圆重叠 / false 在圆外
    let within = false;
    if (dist <= circle.maxRadius) {
      within = 'inrange';
    } else if (accuracy > 0 && (dist - accuracy) <= circle.maxRadius) {
      within = 'maybe';
    }
    const stale = this._isPositionStale();
    let trend = '';
    let trendHtml = '';
    if (!stale && circle.id in this._prevDistances) {
      const diff = dist - this._prevDistances[circle.id];
      if (Math.abs(diff) > 1) {
        if (diff < 0) {
          trend = ' ↑';
          trendHtml = ' <span class="trend-up">↑ 靠近中</span>';
        } else {
          trend = ' ↓';
          trendHtml = ' <span class="trend-down">↓ 远离中</span>';
        }
      }
    }
    this._prevDistances[circle.id] = dist;
    return { dist, bearing, bearingStr, within, stale, trend, trendHtml };
  }

  /* ============= 主题切换 ============= */

  /**
   * 恢复主题偏好
   */
  _restoreTheme() {
    try {
      const saved = localStorage.getItem('circlemap_theme');
      if (saved === 'light' || saved === 'dark') {
        this._theme = saved;
      }
    } catch (e) { /* 静默 */ }
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    // 等 DOM 就绪后更新按钮图标
    if (document.readyState !== 'loading') {
      this._updateThemeBtn();
    } else {
      document.addEventListener('DOMContentLoaded', () => this._updateThemeBtn());
    }
  }

  /**
   * 切换深色/浅色主题
   */
  _toggleTheme() {
    this._theme = this._theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    try {
      localStorage.setItem('circlemap_theme', this._theme);
    } catch (e) { /* 静默 */ }
    this._updateThemeBtn();
    Toast.show(this._theme === 'light' ? '☀️ 已切换为浅色主题' : '🌙 已切换为深色主题');
  }

  /**
   * 更新主题按钮图标
   */
  _updateThemeBtn() {
    const btn = document.getElementById('theme-btn');
    if (!btn) return;
    const isDark = this._theme === 'dark';
    btn.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.title = isDark ? '切换浅色主题' : '切换深色主题';
  }

  /* ============= 数据持久化 ============= */

  /**
   * 保存状态到 localStorage（circles + 设置）（#18 委托给 Storage 模块）
   */
  _saveState() {
    // 轨迹定期保存（始终写入，空数组可清除 localStorage 旧数据）
    Storage.saveTrail(this.trail);
    if (!this._dirty) return;
    this._dirty = false;
    Storage.saveCircles(this.mapManager, this.circleRadius, this.center);
  }

  /**
   * 从 localStorage 恢复状态（页面启动时调用）（#18 委托给 Storage 模块）
   */
  _loadState() {
    // 恢复圆圈（没有数据就跳过）
    const data = Storage.loadCircles();
    if (data) {
      // 恢复设置（#11 对数映射）
      if (data.circleRadius && !isNaN(data.circleRadius)) {
        this._setRadiusSliderValue(data.circleRadius);
      }

      if (data.center) {
        this.center = data.center;
        this.mapManager.setCenter(data.center);
      }

      // 恢复圆圈
      if (data.circles && Array.isArray(data.circles) && data.circles.length > 0) {
        for (const c of data.circles) {
          this.mapManager.circles.push({
            id: c.id,
            center: c.center,
            maxRadius: c.maxRadius,
            interval: c.interval || CONFIG.CONCENTRIC_INTERVAL,
            createdAt: c.createdAt || Date.now()
          });
        }
        // 恢复选中状态
        if (data.selectedCircleId && this.mapManager.circles.some(c => c.id === data.selectedCircleId)) {
          this.mapManager.selectedCircleId = data.selectedCircleId;
        }
        this._updateInfo();
        this._updateCircleList(true);
        this._updateStatusBar(true);
        this.mapManager._scheduleRedraw();
      }
    }

    // 恢复轨迹数据（独立于 circles，保证有轨迹时总能恢复）
    const trailData = Storage.loadTrail();
    if (trailData && Array.isArray(trailData.positions) && trailData.positions.length > 0) {
      this.trail.positions = trailData.positions;
      this.trail.lastPos = trailData.positions[trailData.positions.length - 1];
      this._updateTrailUI();
      if (trailData.positions.length >= 2) {
        this.mapManager.setTrail(this._getTrailPositions());
      }
    }
  }

  /* ============= 状态 & 信息更新 ============= */

  /**
   * 更新顶部 GPS 状态条
   */
  _updateStatusBar(force) {
    if (!this._statusEl) return;
    if (!this.myPosition) {
      this._statusEl.innerHTML = '<div class="gps-line1"><span class="gps-dot"></span><span class="gps-offline">⊙ 未定位，点击 GPS 按钮定位</span></div>';
      return;
    }
    // 节流：不强制刷新时跳过高频调用
    const now = Date.now();
    if (!force && this._lastStatusUpdate && now - this._lastStatusUpdate < CONFIG.STATUS_THROTTLE_MS) return;
    this._lastStatusUpdate = now;
    // 找最近圆
    const circles = this.mapManager.getCircles();
    let nearest = null;
    let nearDist = Infinity;
    for (const c of circles) {
      const d = calcDistance(this.myPosition, c.center);
      if (d < nearDist) { nearDist = d; nearest = c; }
    }
    let nearStr = '';
    if (nearest) {
      const { within } = this._calcCircleTrend(nearest);
      nearStr = within === 'inrange'
        ? `最近圆 ≤ ${formatDistance(nearest.maxRadius)} ✅`
        : within === 'maybe'
          ? `最近圆 ${formatDistance(nearDist)} ⚠️`
          : `最近圆 ${formatDistance(nearDist)}`;
    }
    const elapsed = this._formatElapsed();
    const stale = this._isPositionStale();
    const isTracking = this._isWatching;
    const isManual = this._isManualPosition; // #13
    // gps-dot 状态
    let dotClass = '';
    if (stale) {
      dotClass = 'gps-dot stale';
    } else if (isTracking) {
      dotClass = 'gps-dot tracking';
    } else {
      dotClass = 'gps-dot online';
    }
    const watchingIcon = isTracking ? ' <span class="gps-tracking">◉</span>' : '';
    const staleIcon = stale ? ' <span class="gps-stale">⚠️ 已过期</span>' : '';
    const followIcon = this._followMode ? ' <span class="gps-follow">📌 跟随中</span>' : ''; // #12
    const manualIcon = isManual ? ' <span class="gps-manual">📍 手动定位</span>' : ''; // #15

    // 信号强度（基于 GPS 精度）
    let signalHtml = '';
    if (this._lastAccuracy != null) {
      let bars, label;
      if (this._lastAccuracy <= 10) { bars = 4; label = '极好'; }
      else if (this._lastAccuracy <= 30) { bars = 3; label = '良好'; }
      else if (this._lastAccuracy <= 100) { bars = 2; label = '一般'; }
      else { bars = 1; label = '弱'; }
      signalHtml = `<span class="gps-signal" title="精度 ±${Math.round(this._lastAccuracy)}m">` +
        `<span class="signal-bar s1${bars >= 1 ? ' on' : ''}"></span>` +
        `<span class="signal-bar s2${bars >= 2 ? ' on' : ''}"></span>` +
        `<span class="signal-bar s3${bars >= 3 ? ' on' : ''}"></span>` +
        `<span class="signal-bar s4${bars >= 4 ? ' on' : ''}"></span>` +
        `</span>`;
    }

    // 第二行：信号 + 速度 + 海拔 + 最近圆
    const line2Parts = [];
    if (signalHtml) line2Parts.push(signalHtml);
    if (this._lastSpeed != null) {
      const kmh = this._lastSpeed * 3.6;
      line2Parts.push(`<span class="gps-speed">${kmh.toFixed(1)}km/h</span>`);
    }
    if (this._lastAltitude != null) {
      line2Parts.push(`<span class="gps-altitude">${Math.round(this._lastAltitude)}m</span>`);
    }
    if (nearStr) line2Parts.push(nearStr);
    // 天气
    if (this._weatherHtml) line2Parts.push(this._weatherHtml);
    const line2 = line2Parts.length ? line2Parts.join(' ｜ ') : '<span style="opacity:0.5">位置待更新</span>';

    this._statusEl.innerHTML =
      `<div class="gps-line1"><span class="${dotClass}"></span><span class="gps-online">${isManual ? '📍' : '◉'} 已定位</span>${manualIcon}${watchingIcon}${followIcon} <span class="gps-elapsed">(${elapsed})</span>${staleIcon}</div>` +
      `<div class="gps-line2">${line2}</div>`;
  }

  /**
   * #12 — 点击状态条切换"地图跟随"模式
   * 跟随模式开启时，每次位置更新都 flyTo 当前位置
   */
  _toggleFollowMode() {
    if (!this.myPosition) {
      Toast.show('📍 请先获取位置');
      return;
    }
    this._followMode = !this._followMode;
    if (this._followMode) {
      // 开启时立即飞一次
      this.mapManager.flyTo(this.myPosition);
      Toast.show('📍 地图跟随已开启');
    } else {
      Toast.show('📍 地图跟随已关闭');
    }
    this._updateStatusBar(true);
  }

  /**
   * Open-Meteo 天气代码 → 中文描述
   */
  static _weatherCodeToZh(code) {
    const map = {
      0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
      45: '雾', 48: '雾凇',
      51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
      56: '冻毛毛雨', 57: '大冻毛毛雨',
      61: '小雨', 63: '中雨', 65: '大雨',
      66: '冻雨', 67: '大冻雨',
      71: '小雪', 73: '中雪', 75: '大雪',
      77: '雪粒',
      80: '小阵雨', 81: '阵雨', 82: '大阵雨',
      85: '小阵雪', 86: '大阵雪',
      95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '大雷阵雨伴冰雹'
    };
    return map[code] || '';
  }

  /**
   * 获取当前天气（主用 Open-Meteo，备用 wttr.in）
   * 两个 API 均原生支持 CORS，无需代理
   */
  _fetchWeather() {
    if (!navigator.onLine) return;
    const pos = this.myPosition;
    const lat = pos?.lat ?? 39.9;
    const lng = pos?.lng ?? 116.4;
    // 主用 Open-Meteo（免费、快速、无需注册）
    this._fetchWeatherOpenMeteo(lat, lng)
      .catch(() => this._fetchWeatherWttr(lat, lng));
  }

  /**
   * Open-Meteo 天气 API（主用）
   * 免费、无需 API key、原生 CORS
   */
  _fetchWeatherOpenMeteo(lat, lng) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`;
    return fetch(url, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(data => {
        const cur = data.current;
        if (!cur) throw new Error('no data');
        const temp = cur.temperature_2m;
        const humidity = cur.relative_humidity_2m;
        const wind = cur.wind_speed_10m;
        const code = cur.weather_code;
        const desc = App._weatherCodeToZh(code);
        const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
        this._weatherHtml = `<span class="gps-weather" title="湿度 ${humidity}%">🌡${temp}°C 💨${wind}km/h${humidityText}${desc ? ' ' + desc : ''}</span>`;
        this._updateStatusBar(true);
      });
  }

  /**
   * wttr.in 备用天气
   */
  _fetchWeatherWttr(lat, lng) {
    const url = (lat && lng)
      ? `https://wttr.in/${lat},${lng}?format=j1`
      : 'https://wttr.in/?format=j1';
    return fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(data => {
        const cur = data.current_condition?.[0];
        if (!cur) return;
        const temp = cur.temp_C;
        const wind = cur.windspeedKmph;
        const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '';
        const humidity = cur.humidity;
        const humidityText = humidity ? ` 湿度${humidity}%` : '';
        this._weatherHtml = `<span class="gps-weather" title="湿度 ${humidity}%">🌡${temp}°C 💨${wind}km/h${humidityText}${desc ? ' ' + desc : ''}</span>`;
        this._updateStatusBar(true);
      })
      .catch(() => {});
  }

  /**
   * 更新信息展示区（显示选中圆圈的信息）
   */
  _updateInfo() {
    const infoArea = document.getElementById('infoArea');
    const sel = this.mapManager.getSelectedCircle();

    if (!sel) {
      infoArea.classList.add('hidden');
      return;
    }

    infoArea.classList.remove('hidden');

    document.getElementById('info-center').textContent =
      `${sel.center.lat.toFixed(6)}, ${sel.center.lng.toFixed(6)}`;

    document.getElementById('info-radius').textContent =
      sel.maxRadius >= 1000
        ? `${(sel.maxRadius / 1000).toFixed(2)} km`
        : `${sel.maxRadius} m`;

    const area = Math.PI * sel.maxRadius * sel.maxRadius;
    document.getElementById('info-area').textContent =
      area >= 1e6
        ? `${(area / 1e6).toFixed(2)} km²`
        : `${area.toFixed(0)} m²`;

    const ringCount = Math.ceil(sel.maxRadius / sel.interval);
    document.getElementById('info-rings').textContent = `${ringCount} 圈`;

    // —— 距我距离 ——
    const distEl = document.getElementById('info-distance');
    if (this.myPosition && distEl) {
      const { dist, bearingStr, within, stale, trendHtml } = this._calcCircleTrend(sel);
      const manualTag = this._isManualPosition ? ' <span class="tag-manual">手动</span>' : ''; // #15
      let rangeTag = '';
      if (within === 'inrange') rangeTag = ' <span class="tag-inrange">范围内</span>';
      else if (within === 'maybe') rangeTag = ' <span class="tag-maybe">可能范围内</span>';
      distEl.innerHTML = `${formatDistance(dist)} ${trendHtml} · 方位${bearingStr}${rangeTag}${stale ? ' <span class="tag-stale">可能过期</span>' : ''}${manualTag}`;
    } else if (distEl) {
      distEl.textContent = '--';
    }
  }

  /* ============= 删除恢复（撤销 toast） ============= */

  /**
   * 显示可撤销操作的 toast
   * @param {string} message 操作提示
   * @param {Function} onUndo 撤销回调
   * @param {number} [duration=5000] 超时自动关闭（毫秒）
   */
  _showUndoToast(message, onUndo, duration) {
    const existing = document.querySelector('.toast-msg');
    if (existing) existing.remove();

    const ms = duration || 5000;
    const toast = document.createElement('div');
    toast.className = 'toast-msg toast-action';
    toast.innerHTML = `${message} <button class="toast-undo-btn">撤销</button>`;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    const undoBtn = toast.querySelector('.toast-undo-btn');
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      undoBtn.disabled = true;
      onUndo();
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
    }, ms);
  }

  /* ============= 圆列表管理 ============= */

  /**
   * 选中一个圆
   */
  _selectCircle(id) {
    this.mapManager.selectCircle(id);
    const sel = this.mapManager.getSelectedCircle();
    if (sel) {
      // 同步半径滑块到该圆的数值（#11 对数映射）
      this._setRadiusSliderValue(sel.maxRadius);
      // 地图飞到圆心
      this.mapManager.setCenter(sel.center);
    }
    this._updateInfo();
    this._updateCircleList(true);
    this._updateStatusBar(true);
  }

  /**
   * 删除一个圆（支持撤销）
   */
  _deleteCircle(id) {
    // 保存用于恢复
    const circle = this.mapManager.circles.find(c => c.id === id);
    if (!circle) return;
    const wasSelected = this.mapManager.selectedCircleId === id;

    this.mapManager.removeCircle(id);
    this._updateInfo();
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();
    // 清除已删除圆的趋势缓存
    delete this._prevDistances[id];

    this._showUndoToast('已删除', () => {
      this.mapManager.circles.push(circle);
      if (wasSelected) {
        this.mapManager.selectedCircleId = circle.id;
      }
      this.mapManager._scheduleRedraw();
      this._updateInfo();
      this._updateCircleList(true);
      this._updateStatusBar(true);
      this._dirty = true;
      this._saveState();
    });
  }

  /**
   * 编辑圆的半径（选中 + 跳转到半径滑块）
   */
  _editCircle(id) {
    this._selectCircle(id);
    // 滚动面板到半径设置区
    const radiusSection = document.querySelector('.radius-section');
    if (radiusSection && this._bottomPanel) {
      this._bottomPanel.scrollTo({
        top: radiusSection.offsetTop - this._bottomPanel.offsetTop - 10,
        behavior: 'smooth'
      });
    }
    // 高亮滑块提示可调
    this._radiusSlider.classList.add('editing');
    // 聚焦数字输入
    this._radiusInput.focus();
    setTimeout(() => this._radiusSlider.classList.remove('editing'), CONFIG.EDIT_HIGHLIGHT_MS);
    Toast.show('✏️ 拖动滑块调整半径');
  }

  /**
   * 渲染圆列表
   */
  _updateCircleList(force) {
    const circles = this.mapManager.getCircles();
    const selId = this.mapManager.selectedCircleId;

    // 节流
    const now = Date.now();
    if (!force && this._lastCircleUpdate && now - this._lastCircleUpdate < CONFIG.LIST_THROTTLE_MS) return;
    this._lastCircleUpdate = now;

    if (!circles.length) {
      this._circleListEl.innerHTML = `<div class="empty-state">暂无同心圆，点击「绘制圆形」添加</div>`;
      this._circleCountEl.textContent = '0';
      return;
    }

    this._circleCountEl.textContent = circles.length;

    let html = '';
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const isSel = c.id === selId;
      const ringCount = Math.max(1, Math.floor(c.maxRadius / c.interval));
      const radiusStr = c.maxRadius >= 1000
        ? (c.maxRadius / 1000).toFixed(1) + ' km'
        : c.maxRadius + ' m';
      const coordStr = c.center.lat.toFixed(4) + ', ' + c.center.lng.toFixed(4);
      // 格式化创建时间
      const createDate = new Date(c.createdAt || Date.now());
      const nowDate = new Date();
      const timeStr = createDate.toTimeString().slice(0, 8); // HH:MM:SS
      const dateStr = createDate.toDateString() === nowDate.toDateString()
        ? timeStr
        : `${createDate.getMonth() + 1}/${createDate.getDate()} ${timeStr}`;

      // 距离信息 + 趋势
      let distStr = '';
      let distClass = '';
      if (this.myPosition) {
        const { dist, bearingStr, within, stale, trend } = this._calcCircleTrend(c);
        distStr = formatDistance(dist) + trend + (stale ? ' ⚠' : '') + (this._isManualPosition ? ' 📍' : '') + ` 方位${bearingStr}`; // #15 手动标记
        distClass = within === 'inrange' ? 'dist-within' : within === 'maybe' ? 'dist-maybe' : '';
      }

      html += `<div class="circle-item${isSel ? ' active' : ''}" data-id="${c.id}">
        <span class="circle-idx">#${i + 1}</span>
        <div class="circle-summary">
          <div class="circle-name">${radiusStr} <span class="circle-created">${dateStr}</span></div>
          <div class="circle-meta">${ringCount}圈 · ${coordStr}</div>
        </div>
        <span class="circle-dist ${distClass}">${distStr}</span>
        <button class="circle-edit" aria-label="编辑半径">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            <path d="m15 5 4 4"/>
          </svg>
        </button>
        <button class="circle-del" aria-label="删除此圆">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
    }
    this._circleListEl.innerHTML = html;
  }

  /* ============= URL 参数 ============= */

  /**
   * 从 URL 参数读取初始状态
   * 支持：?lat=39.9&lng=116.4&radius=1000
   */
  _checkUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const lat = parseFloat(params.get('lat'));
      const lng = parseFloat(params.get('lng'));
      const radius = parseInt(params.get('radius'), 10);

      if (!isNaN(lat) && !isNaN(lng) &&
          lat >= -90 && lat <= 90 &&
          lng >= -180 && lng <= 180) {
        this.center = { lat, lng };
        this.mapManager.setCenter(this.center);

        if (!isNaN(radius) && radius >= CONFIG.MIN_RADIUS && radius <= CONFIG.MAX_RADIUS) {
          this._setRadiusSliderValue(radius);
          this.mapManager.addCircle(this.center, radius);
          this._updateInfo();
          this._updateCircleList(true);
          this._dirty = true;
          this._saveState();
        }
      }
    } catch (e) {
      // 静默忽略 URL 解析错误
    }
  }

  /**
   * 销毁应用，清理所有定时器和事件监听器
   */
  destroy() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._pageHideHandler) {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    if (this._pageShowHandler) {
      window.removeEventListener('pageshow', this._pageShowHandler);
      this._pageShowHandler = null;
    }
    this.mapManager.destroy();
  }
}

/* ============= 启动 ============= */

let _appInitialized = false;

function _bootApp() {
  if (_appInitialized) return;
  _appInitialized = true;
  const app = new App();
  app.init();
  // 暴露到全局便于调试
  window.app = app;
}

// DOM 就绪后启动（脚本在 </body> 前，readyState 为 interactive，两个路径可能都执行）
document.addEventListener('DOMContentLoaded', _bootApp);

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  _bootApp();
}
