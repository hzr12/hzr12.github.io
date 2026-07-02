/**
 * 圆圈地图 - 地图管理器
 * ============================================
 * 使用 Canvas 叠加层绘制同心圆（样式参照 demo.html）
 * 纬向墨卡托投影坐标 → 容器像素转换
 */

class MapManager {
  constructor() {
    this.map = null;
    this.marker = null;
    this.canvas = null;
    this.ctx = null;
    this.center = null;         // 当前标记位置（用于下一个圆）
    this.mode = 'click';
    this.circles = [];          // {id, center:{lat,lng}, maxRadius, interval}
    this.selectedCircleId = null;
    this._idCounter = Date.now(); // #3 时间戳起始 + 递增，避免碰撞
    this.PICK_THRESHOLD = 22;   // 像素距离阈值

    this._rafId = null;
    this._syncCenter = null;    // 地图实际显示中心（我们追踪，不依赖 getCenter）

    this.locationMarker = null; // 我的位置标记（区别于圆心标识）
    this.accuracyCircle = null; // #17 定位精度圆环
    this.trailPolylines = [];   // 历史轨迹线（多段，按速度着色）
    this._targetPos = null;    // 对方位置坐标
    this.targetCircle = null;  // 对方精度范围圈

    // 回调钩子
    this.onCenterChange = null;
    this.onLongPress = null; // #13 长按回调

    this._theme = 'dark';    // 当前主题（影响 Canvas 颜色）
  }

  /**
   * 初始化地图 + Canvas 叠加层
   */
  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);

    // —— Canvas 叠加层 ——
    this.canvas = document.getElementById('circle-canvas');
    this.ctx = this.canvas.getContext('2d');

    // —— 腾讯地图 ——
    this.map = new qq.maps.Map(mapEl, {
      center: new qq.maps.LatLng(center.lat, center.lng),
      zoom: zoom || CONFIG.DEFAULT_ZOOM,
      mapTypeId: qq.maps.MapTypeId.ROADMAP
    });

    // 追踪地图实际显示中心（绕过 getCenter 异步问题）
    this._syncCenter = new qq.maps.LatLng(center.lat, center.lng);

    // 点击选点 / 选取圆心
    qq.maps.event.addListener(this.map, 'click', (event) => {
      if (this.mode !== 'click') return;
      if (!event.latLng) return;

      // 先判断是否点击了已有圆心
      const clickedPt = this._latLngToContainerPoint(event.latLng);
      if (clickedPt) {
        const picked = this._pickCircle(clickedPt);
        if (picked) {
          this.selectedCircleId = picked.id;
          this._scheduleRedraw();
          if (this.onCenterChange) this.onCenterChange(picked.center, picked);
          return;
        }
      }

      this.setCenter({ lat: event.latLng.getLat(), lng: event.latLng.getLng() });
    });

    // #13 — 长按地图触发回调（用于手动设位置或快速创建圆）
    qq.maps.event.addListener(this.map, 'longpress', (event) => {
      if (!event.latLng) return;
      if (this.onLongPress) {
        this.onLongPress({ lat: event.latLng.getLat(), lng: event.latLng.getLng() });
      }
    });

    // 地图变化 → 重绘 Circle Canvas
    qq.maps.event.addListener(this.map, 'center_changed', () => {
      const c = this.map.getCenter();
      if (c) this._syncCenter = c;
    });
    qq.maps.event.addListener(this.map, 'zoom_changed', () => {
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'drag', () => {
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'dragend', () => {
      this._scheduleRedraw();
    });

    // 窗口大小变化
    this._resizeHandler = () => {
      this._resizeCanvas();
      this._scheduleRedraw();
    };
    window.addEventListener('resize', this._resizeHandler);

    // 初始化尺寸
    this._resizeCanvas();
    this._scheduleRedraw();

    return this;
  }

  /* ================================================================
   *  坐标 → 像素 转换
   * ================================================================ */

  /**
   * 经纬度 → 容器像素坐标
   * 使用地图投影计算世界坐标，再根据缩放/中心点换算
   */
  _latLngToContainerPoint(latLng) {
    const proj = this.map.getProjection();
    if (!proj || !this._syncCenter) return null;

    const wp = proj.fromLatLngToPoint(latLng);
    if (!wp || typeof wp.x !== 'number') return null;

    const zoom = this.map.getZoom();
    const cwp = proj.fromLatLngToPoint(this._syncCenter);
    if (!cwp) return null;

    const w = this.canvas.parentElement.offsetWidth;
    const h = this.canvas.parentElement.offsetHeight;
    const scale = Math.pow(2, zoom);

    return {
      x: w / 2 + (wp.x - cwp.x) * scale,
      y: h / 2 + (wp.y - cwp.y) * scale
    };
  }

  /**
   * 地面距离（米）→ 屏幕像素
   * 公式：1px = 156543.03392 * cos(lat) / 2^zoom （米）
   */
  _metersToPixels(meters, latLng) {
    if (meters <= 0) return 0;
    const zoom = this.map.getZoom();
    const lat = latLng.getLat();
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return meters / mpp;
  }

  /* ================================================================
   *  Canvas 尺寸
   * ================================================================ */

  _resizeCanvas() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = parent.offsetWidth * dpr;
    this.canvas.height = parent.offsetHeight * dpr;
    this.canvas.style.width = parent.offsetWidth + 'px';
    this.canvas.style.height = parent.offsetHeight + 'px';
  }

  /* ================================================================
   *  同心圆渲染（核心 — 样式匹配 demo.html）
   * ================================================================ */

  _scheduleRedraw() {
    const minInterval = 1000 / 30; // ~33ms → 30fps 限频

    if (this._rafId) cancelAnimationFrame(this._rafId);

    this._rafId = requestAnimationFrame(() => {
      // #1 距上次绘制不足 33ms → 再排一次，保证请求不被丢弃
      const now = performance.now();
      if (now - (this._lastRedrawTime || 0) < minInterval) {
        this._rafId = requestAnimationFrame(() => {
          this._redraw();
          this._lastRedrawTime = performance.now();
          this._rafId = null;
        });
        return;
      }
      this._redraw();
      this._lastRedrawTime = performance.now();
      this._rafId = null;
    });
  }

  /* ================================================================
   *  同心圆渲染（多圆支持）
   * ================================================================ */

  /**
   * 设置主题（影响 Canvas 颜色适配）
   * @param {'dark'|'light'} theme
   */
  setTheme(theme) {
    this._theme = theme;
    this._scheduleRedraw();
  }

  /**
   * 离屏 Canvas（多圆重叠染色用，懒创建）
   */
  _getOffscreen(w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (!this._offCanvas || this._offCanvas.width !== Math.round(w * dpr) || this._offCanvas.height !== Math.round(h * dpr)) {
      this._offCanvas = document.createElement('canvas');
      this._offCanvas.width = Math.round(w * dpr);
      this._offCanvas.height = Math.round(h * dpr);
    }
    return this._offCanvas;
  }

  _redraw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const parent = this.canvas.parentElement;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.circles.length) return;

    // ── Pass 1: 离屏 Canvas 只画填充（重叠区域自然叠色加深） ──
    const offCanvas = this._getOffscreen(w, h);
    const offCtx = offCanvas.getContext('2d');
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offCtx.clearRect(0, 0, w, h);

    for (const c of this.circles) {
      this._drawCircleFill(offCtx, c);
    }

    // ── 合成离屏结果到主 Canvas（整体控制透明度） ──
    ctx.drawImage(offCanvas, 0, 0, offCanvas.width, offCanvas.height, 0, 0, w, h);

    // ── Pass 2: 主 Canvas 画描边 + 圆心 ──
    for (const c of this.circles) {
      this._drawCircleStrokes(ctx, c);
    }
  }

  /**
   * 根据当前主题返回 Canvas 绘制颜色方案
   */
  _getColors() {
    if (this._theme === 'light') {
      return {
        fillBase:  'rgba(0, 80, 200, 0.08)',
        fillAlt:   'rgba(0, 80, 200, 0.04)',
        strokeInner: 'rgba(0, 60, 150, 0.28)',
        strokeOuter: 'rgba(0, 40, 120, 0.45)',
        dotStroke:   'rgba(0, 60, 150, 0.25)',
        dotFill:     'rgba(0, 50, 140, 0.8)',
        selDotStroke: 'rgba(0, 160, 130, 0.5)',
        selDotFill:   '#00a082',
        selDashStroke: 'rgba(0, 160, 130, 0.55)'
      };
    }
    // dark (default)
    return {
      fillBase:  'rgba(70, 140, 220, 0.12)',
      fillAlt:   'rgba(70, 140, 220, 0.06)',
      strokeInner: 'rgba(15, 50, 120, 0.32)',
      strokeOuter: 'rgba(10, 35, 90, 0.55)',
      dotStroke:   'rgba(15, 50, 120, 0.25)',
      dotFill:     'rgba(15, 50, 120, 0.8)',
      selDotStroke: 'rgba(0, 160, 130, 0.4)',
      selDotFill:   '#00a082',
      selDashStroke: 'rgba(0, 160, 130, 0.5)'
    };
  }

  /**
   * 只画圆的填充区域（离屏 Canvas 用）
   * 重叠区域因为多次 fill 叠加，颜色自然比单个圆深
   */
  _drawCircleFill(ctx, circle) {
    const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return;

    const maxR = circle.maxRadius;
    const interval = circle.interval;
    const mp = this._metersToPixels(maxR, latLng);
    const ip = this._metersToPixels(interval, latLng);
    const { x: cx, y: cy } = cp;

    if (mp < CONFIG.MIN_DRAW_PX) return;

    const drawInner = ip >= 2;
    const ringCount = drawInner ? Math.max(1, Math.floor(mp / ip)) : 0;
    const clr = this._getColors();

    // ── 整体底色 ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.fillStyle = clr.fillBase;
    ctx.fill();

    // ── 间隔填充（偶数圈加深） ──
    if (drawInner) {
      for (let i = ringCount; i >= 1; i--) {
        const ro = i * ip, ri = (i - 1) * ip;
        if (ro > mp) continue;
        if (i % 2 === 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1, ro), 0, Math.PI * 2);
          ctx.arc(cx, cy, Math.max(0.5, ri), 0, Math.PI * 2, true);
          ctx.fillStyle = clr.fillAlt;
          ctx.fill();
        }
      }
    }
  }

  /**
   * 画圆的描边 + 圆心标记（主 Canvas 用）
   */
  _drawCircleStrokes(ctx, circle) {
    const isSel = circle.id === this.selectedCircleId;
    const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return;

    const maxR = circle.maxRadius;
    const interval = circle.interval;
    const mp = this._metersToPixels(maxR, latLng);
    const ip = this._metersToPixels(interval, latLng);
    const { x: cx, y: cy } = cp;

    if (mp < CONFIG.MIN_DRAW_PX) return;

    const drawInner = ip >= 2;
    const ringCount = drawInner ? Math.max(1, Math.floor(mp / ip)) : 0;
    const clr = this._getColors();

    const strokeInner = isSel ? clr.selDotStroke : clr.strokeInner;
    const strokeOuter = isSel ? clr.selDashStroke : clr.strokeOuter;
    const dotStroke = isSel ? clr.selDotStroke : clr.dotStroke;
    const dotFill   = isSel ? clr.selDotFill   : clr.dotFill;

    // ── 内部圈描边 ──
    if (drawInner) {
      ctx.strokeStyle = strokeInner;
      ctx.lineWidth = 1.2;
      for (let j = 1; j <= ringCount; j++) {
        const r = j * ip;
        if (r > mp) break;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── 最外圈描边（粗线） ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.strokeStyle = strokeOuter;
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // ── 选中态：虚线外框 ──
    if (isSel) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, mp + 5), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 160, 130, 0.5)';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 圆心标记 ──
    const dotR = isSel ? 9 : 6;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.strokeStyle = dotStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, isSel ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = dotFill;
    ctx.fill();

    // ── 相对方距离标注（圆心下方） ──
    if (this._targetPos) {
      const dist = calcDistance(circle.center, this._targetPos);
      const distLabel = '← ' + formatDistance(dist);
      ctx.font = '500 9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const dtw = ctx.measureText(distLabel).width;
      const dly = cy + dotR + 4;
      // 底色
      ctx.fillStyle = 'rgba(255, 140, 0, 0.8)';
      ctx.beginPath();
      ctx.roundRect(cx - dtw / 2 - 3, dly - 1, dtw + 6, 14, 3);
      ctx.fill();
      // 文字
      ctx.fillStyle = '#fff';
      ctx.fillText(distLabel, cx, dly + 1);
    }

    // ── 圆圈距离标注 ──
    if (mp >= 30) {
      const labelR = mp;
      const labelAngle = -Math.PI / 4; // 右上角 45°
      const lx = cx + labelR * Math.cos(labelAngle);
      const ly = cy + labelR * Math.sin(labelAngle);
      const label = formatDistance(maxR);
      ctx.font = '600 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 文字底色
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isSel ? 'rgba(0, 160, 130, 0.85)' : 'rgba(15, 50, 120, 0.75)';
      ctx.beginPath();
      ctx.roundRect(lx - tw / 2 - 3, ly - 7, tw + 6, 14, 3);
      ctx.fill();
      // 文字
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, ly);
    }
  }

  /**
   * 检测容器坐标附近是否有圆心
   */
  _pickCircle(pt) {
    for (const c of this.circles) {
      const center = new qq.maps.LatLng(c.center.lat, c.center.lng);
      const cp = this._latLngToContainerPoint(center);
      if (!cp) continue;
      const dx = pt.x - cp.x;
      const dy = pt.y - cp.y;
      if (Math.sqrt(dx * dx + dy * dy) < this.PICK_THRESHOLD) {
        return c;
      }
    }
    return null;
  }

  /* ================================================================
   *  公开 API
   * ================================================================ */

  /**
   * 设置/移动中心点标记（仅设标记，不创建圆）
   */
  setCenter(center) {
    this.center = center;
    const latLng = new qq.maps.LatLng(center.lat, center.lng);

    if (this.marker) {
      this.marker.setPosition(latLng);
    } else {
      this.marker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: true,
        icon: this._createMarkerIcon()
      });
      // 标记拖拽 → 更新待添加圆的预览位置
      qq.maps.event.addListener(this.marker, 'dragend', (event) => {
        const pos = event.latLng;
        this.center = { lat: pos.lat, lng: pos.lng };
        if (this.onCenterChange) {
          this.onCenterChange(this.center);
        }
      });
    }

    // 同步追踪中心 + 强制重绘（不依赖 getCenter 异步结果）
    this._syncCenter = latLng;
    this.map.setCenter(latLng);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._redraw();

    if (this.onCenterChange) {
      this.onCenterChange(this.center);
    }
  }

  /**
   * 添加一个同心圆到列表
   * @param {{lat:number,lng:number}} center 中心坐标
   * @param {number} maxRadius 最大半径（米）
   * @param {number} [interval] 间距（默认 CONFIG.CONCENTRIC_INTERVAL）
   * @returns {number} 新圆的 id
   */
  addCircle(center, maxRadius, interval) {
    const id = this._idCounter++; // #3 递增计数器，避免 Date.now() 碰撞
    this.circles.push({
      id,
      center: { lat: center.lat, lng: center.lng },
      maxRadius,
      interval: interval || CONFIG.CONCENTRIC_INTERVAL,
      createdAt: Date.now()
    });
    // 不自动选中——创建后保持在"创建"状态，不进入编辑模式
    this._scheduleRedraw();
    this._zoomToRadius(maxRadius);
    return id;
  }

  /**
   * 删除指定 id 的圆
   */
  removeCircle(id) {
    this.circles = this.circles.filter(c => c.id !== id);
    if (this.selectedCircleId === id) this.selectedCircleId = null;
    this._scheduleRedraw();
  }

  /**
   * 删除所有圆
   */
  clearCircles() {
    this.circles = [];
    this.selectedCircleId = null;
    this._scheduleRedraw();
  }

  /**
   * 选中一个圆
   */
  selectCircle(id) {
    this.selectedCircleId = id;
    this._scheduleRedraw();
  }

  /**
   * 获取所有圆
   */
  getCircles() {
    return this.circles;
  }

  /**
   * 获取选中的圆
   */
  getSelectedCircle() {
    if (this.selectedCircleId === null) return null;
    return this.circles.find(c => c.id === this.selectedCircleId) || null;
  }

  /**
   * 更新圆的半径
   */
  updateCircleRadius(id, radius) {
    const c = this.circles.find(c => c.id === id);
    if (c) {
      c.maxRadius = radius;
      this._scheduleRedraw();
    }
  }

  /**
   * 设置交互模式
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * 跳转到位置（不改变标记）
   */
  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.panTo(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  /**
   * WGS84 → GCJ-02 坐标转换（GPS 纠偏）
   * 浏览器 Geolocation 返回的是 WGS84，腾讯地图使用 GCJ-02
   *
   * 优先使用腾讯地图官方 convertor 库（同步回调），
   * 不可用时降级到手写纠偏算法。
   * @param {{lat:number, lng:number}} point
   * @returns {Promise<{lat:number, lng:number}>}
   */
  async wgs84ToGcj02(point) {
    // 尝试官方 convertor 库
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.convertor) {
      try {
        const result = await new Promise((resolve, reject) => {
          // 5秒超时兜底——防止 API 不回调导致 Promise 挂起阻塞串行队列
          const timer = setTimeout(() => {
            reject(new Error('convertor API timeout'));
          }, 5000);
          const latLng = new qq.maps.LatLng(point.lat, point.lng);
          qq.maps.convertor.translate([latLng], 1, (res) => {
            clearTimeout(timer);
            if (res && res[0] && typeof res[0].lat === 'number' && typeof res[0].lng === 'number') {
              resolve({ lat: res[0].lat, lng: res[0].lng });
            } else {
              reject(new Error('unexpected convertor response'));
            }
          });
        });
        return result;
      } catch (e) {
        console.warn('wgs84ToGcj02: convertor API 失败，降级到手写算法', e.message);
      }
    }
    // 降级：手写纠偏算法
    return this._wgs84Gcj02(point);
  }

  /**
   * 手写 WGS84 → GCJ-02 纠偏算法（降级备用）
   * @param {{lat:number, lng:number}} point
   * @returns {{lat:number, lng:number}}
   */
  _wgs84Gcj02(point) {
    const A = 6378245.0;
    const EE = 0.00669342162296594323;

    const outOfChina = (lat, lng) =>
      lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

    const transformLat = (x, y) => {
      let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
      ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
      return ret;
    };

    const transformLng = (x, y) => {
      let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
      ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
      return ret;
    };

    const { lat, lng } = point;
    if (outOfChina(lat, lng)) return point;

    const dlat = transformLat(lng - 105, lat - 35);
    const dlng = transformLng(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dlatFinal = (dlat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    const dlngFinal = (dlng * 180) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);

    return { lat: lat + dlatFinal, lng: lng + dlngFinal };
  }

  /**
   * 自适应缩放
   */
  _zoomToRadius(radius) {
    if (!this.map) return;
    const entry = CONFIG.ZOOM_MAP.find(e => radius <= e.maxRadius);
    if (entry) this.map.setZoom(entry.zoom);
  }

  /**
   * 创建自定义标记图标（渐变色目标圆点）
   */
  _createMarkerIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
      '  <defs>',
      '    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">',
      '      <stop offset="0%" stop-color="#00D4AA"/>',
      '      <stop offset="100%" stop-color="#00A3FF"/>',
      '    </linearGradient>',
      '    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.45"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="16" cy="16" r="14" fill="none" stroke="#00D4AA" stroke-width="1.2" opacity="0.18"/>',
      '  <circle cx="16" cy="16" r="9" fill="url(#g)" stroke="#fff" stroke-width="2.5" filter="url(#s)"/>',
      '  <circle cx="16" cy="16" r="3" fill="#fff" opacity="0.95"/>',
      '</svg>'
    ].join('\n');

    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);

    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(32, 32),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(16, 16),
      new qq.maps.Size(32, 32)
    );
  }

  /**
   * 创建我的位置标记图标（蓝色实心圆点，与圆心标识区分）
   * @param {number} [heading] 可选朝向角度（正北顺时针），传入则叠加方向箭头
   */
  _createLocationIcon(heading) {
    const arrow = (heading != null && !isNaN(heading))
      ? `<polygon points="20,2 23,10 17,10" fill="#00A3FF" transform="rotate(${heading}, 20, 20)"/>`
      : '';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="17" fill="none" stroke="#0088FF" stroke-width="1.5" opacity="0.12"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="#0088FF" stroke-width="2" opacity="0.28"/>',
      '  <circle cx="20" cy="20" r="7" fill="#0088FF" stroke="#fff" stroke-width="2.5" filter="url(#s)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
      arrow,
      '</svg>'
    ].join('\n');

    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);

    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  /**
   * 在地图上显示我的位置标记
   * @param {{lat:number, lng:number}} center
   * @param {number} [accuracy] 定位精度（米），传入则同时绘制精度环 (#17)
   * @param {number} [heading] 朝向角度（正北顺时针），传入则更新方向箭头
   */
  setLocation(center, accuracy, heading) {
    const latLng = new qq.maps.LatLng(center.lat, center.lng);

    if (this.locationMarker) {
      this.locationMarker.setPosition(latLng);
      if (heading != null && !isNaN(heading)) {
        this.locationMarker.setIcon(this._createLocationIcon(heading));
      } else {
        this.locationMarker.setIcon(this._createLocationIcon());
      }
    } else {
      this.locationMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createLocationIcon(heading)
      });
    }

    // #17 更新精度环
    this._updateAccuracyCircle(latLng, accuracy);
  }

  /**
   * 绘制/更新定位精度环
   * #17 — 在地图上用半透明圆表示定位可信范围
   * @param {qq.maps.LatLng} latLng 中心坐标
   * @param {number} [accuracy] 精度（米），不传或 NaN 则清除精度环
   */
  _updateAccuracyCircle(latLng, accuracy) {
    if (!this.map) return;
    if (accuracy == null || isNaN(accuracy) || accuracy <= 0) {
      if (this.accuracyCircle) {
        this.accuracyCircle.setMap(null);
        this.accuracyCircle = null;
      }
      return;
    }

    if (this.accuracyCircle) {
      this.accuracyCircle.setCenter(latLng);
      this.accuracyCircle.setRadius(accuracy);
    } else {
      this.accuracyCircle = new qq.maps.Circle({
        map: this.map,
        center: latLng,
        radius: accuracy,
        fillColor: new qq.maps.Color(0, 136, 255, 0.08),
        strokeColor: new qq.maps.Color(0, 136, 255, 0.15),
        strokeWeight: 1,
        editable: false
      });
    }
  }

  // ----- 速度→色阶映射 (轨迹按速度着色) -----

  /** 速度色阶表 (m/s → 颜色) */
  _speedColorMap = {
    slow:   { r: 80,  g: 160, b: 255, a: 0.55 },  // 0-0.5 m/s  停留/慢走 → 蓝
    walk:   { r: 0,   g: 212, b: 170, a: 0.60 },  // 0.5-1.5    正常走 → 青
    fast:   { r: 180, g: 200, b: 50,  a: 0.60 },  // 1.5-3.0    快走 → 黄绿
    run:    { r: 255, g: 140, b: 40,  a: 0.70 },  // 3.0-5.0    跑 → 橙
    sprint: { r: 255, g: 60,  b: 60,  a: 0.75 },  // >5.0       冲刺/骑车 → 红
  };

  /**
   * 取速度对应的色阶键名
   * @param {number|null|undefined} speed m/s
   * @returns {string} slow|walk|fast|run|sprint
   */
  _speedColorKey(speed) {
    if (speed == null || speed < 0.5) return 'slow';
    if (speed < 1.5) return 'walk';
    if (speed < 3.0) return 'fast';
    if (speed < 5.0) return 'run';
    return 'sprint';
  }

  /**
   * 计算某一段轨迹的参考速度（取终点的 speed，若无则取起点）
   */
  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  }

  /**
   * 更新历史轨迹线（按速度分段着色）
   * @param {Array<{lat:number,lng:number,speed?:number}>} positions GCJ-02 坐标数组
   */
  setTrail(positions) {
    if (!this.map) return;
    if (positions.length < 2) {
      this.clearTrail();
      return;
    }

    this.clearTrail();

    let batchPath = [];       // 当前颜色段的路径
    let batchKey = null;      // 当前颜色段对应的 speed key

    for (let i = 1; i < positions.length; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];
      const key = this._speedColorKey(this._segmentSpeed(p0, p1));

      if (batchPath.length === 0) {
        batchPath.push(new qq.maps.LatLng(p0.lat, p0.lng));
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
      } else {
        this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        batchPath = [
          new qq.maps.LatLng(p0.lat, p0.lng),
          new qq.maps.LatLng(p1.lat, p1.lng)
        ];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) {
      this._flushSegment(batchPath, this._speedColorMap[batchKey]);
    }
  }

  /** 创建一条轨迹 Polyline 并存入数组 */
  _flushSegment(path, clr) {
    const poly = new qq.maps.Polyline({
      path,
      strokeColor: new qq.maps.Color(clr.r, clr.g, clr.b, clr.a),
      strokeWeight: 3.5,
      map: this.map
    });
    this.trailPolylines.push(poly);
  }

  /**
   * 清除历史轨迹线
   */
  clearTrail() {
    for (const poly of this.trailPolylines) {
      poly.setMap(null);
    }
    this.trailPolylines = [];
  }

  // ----- 对方位置标记 -----

  /**
   * 创建对方位置标记图标（橙色实心圆点）
   */
  _createTargetIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="ts" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="17" fill="none" stroke="#FF8C00" stroke-width="1.5" opacity="0.2"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="#FF8C00" stroke-width="2" opacity="0.35"/>',
      '  <circle cx="20" cy="20" r="7" fill="#FF8C00" stroke="#fff" stroke-width="2.5" filter="url(#ts)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
      '</svg>'
    ].join('\n');
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  /**
   * 设置/更新对方位置标记
   * @param {{lat:number, lng:number}|null} center 坐标，null 则清除
   */
  setTarget(center, range) {
    if (!this.map) return;
    if (!center) {
      this._targetPos = null;
      if (this.targetMarker) {
        this.targetMarker.setMap(null);
        this.targetMarker = null;
      }
      this.setTargetRange(0);
      return;
    }
    this._targetPos = center;
    const latLng = new qq.maps.LatLng(center.lat, center.lng);
    if (this.targetMarker) {
      this.targetMarker.setPosition(latLng);
    } else {
      this.targetMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createTargetIcon()
      });
    }
    if (range > 0) this.setTargetRange(range);
  }

  /**
   * 设置/更新对方位置精度范围圈
   */
  setTargetRange(range) {
    if (!this.map) return;
    if (this.targetCircle) {
      this.targetCircle.setMap(null);
      this.targetCircle = null;
    }
    if (!this._targetPos || range <= 0) return;
    const center = new qq.maps.LatLng(this._targetPos.lat, this._targetPos.lng);
    this.targetCircle = new qq.maps.Circle({
      map: this.map,
      center,
      radius: range,
      fillColor: new qq.maps.Color(255, 140, 0, 0.08),
      strokeColor: new qq.maps.Color(255, 140, 0, 0.4),
      strokeWeight: 1.5,
      strokeDashArray: [6, 4],
      clickable: false
    });
  }

  destroy() {
    this.clearTrail();
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this.marker) {
      this.marker.setMap(null);
      this.marker = null;
    }
    if (this.locationMarker) {
      this.locationMarker.setMap(null);
      this.locationMarker = null;
    }
    if (this.targetMarker) {
      this.targetMarker.setMap(null);
      this.targetMarker = null;
    }
    if (this.targetCircle) {
      this.targetCircle.setMap(null);
      this.targetCircle = null;
    }
    this._offCanvas = null;
    this.map = null;
    this.center = null;
  }
}
