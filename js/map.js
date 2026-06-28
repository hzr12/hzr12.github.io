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
    this._idCounter = 1;
    this.PICK_THRESHOLD = 22;   // 像素距离阈值

    this._rafId = null;
    this._syncCenter = null;    // 地图实际显示中心（我们追踪，不依赖 getCenter）

    this.locationMarker = null; // 我的位置标记（区别于圆心标识）
    this.trailPolyline = null;  // 历史轨迹线

    // 回调钩子
    this.onCenterChange = null;
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

    // 地图变化 → 重绘 Circle Canvas
    qq.maps.event.addListener(this.map, 'zoom_changed', () => {
      this._syncCenter = this.map.getCenter() || this._syncCenter;
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'drag', () => {
      this._syncCenter = this.map.getCenter() || this._syncCenter;
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'dragend', () => {
      this._syncCenter = this.map.getCenter() || this._syncCenter;
      this._scheduleRedraw();
    });

    // 窗口大小变化
    window.addEventListener('resize', () => {
      this._resizeCanvas();
      this._scheduleRedraw();
    });

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

    const now = performance.now();
    if (now - (this._lastRedrawTime || 0) < minInterval) {
      return; // 距离上次绘制不足 33ms，跳过（下一个事件触发时会继续判断）
    }

    this._rafId = requestAnimationFrame(() => {
      this._redraw();
      this._lastRedrawTime = performance.now();
      this._rafId = null;
    });
  }

  /* ================================================================
   *  同心圆渲染（多圆支持）
   * ================================================================ */

  _redraw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const parent = this.canvas.parentElement;

    this._resizeCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, parent.offsetWidth, parent.offsetHeight);

    for (const c of this.circles) {
      this._drawOneCircle(ctx, c);
    }
  }

  /**
   * 绘制单个同心圆组
   */
  _drawOneCircle(ctx, circle) {
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

    // 选中态：选中色 vs 默认色
    const fillBase = 'rgba(70, 140, 220, 0.08)';
    const fillAlt  = 'rgba(70, 140, 220, 0.05)';
    const strokeInner = 'rgba(15, 50, 120, 0.32)';
    const strokeOuter = 'rgba(10, 35, 90, 0.55)';
    const dotStroke = isSel ? 'rgba(0, 160, 130, 0.4)'  : 'rgba(15, 50, 120, 0.25)';
    const dotFill   = isSel ? '#00a082'                  : 'rgba(15, 50, 120, 0.8)';

    // ── 1. 整体半透明底色 ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.fillStyle = fillBase;
    ctx.fill();

    // ── 2. 间隔填充（偶数圈加深） ──
    if (drawInner) {
      for (let i = ringCount; i >= 1; i--) {
        const ro = i * ip, ri = (i - 1) * ip;
        if (ro > mp) continue;
        if (i % 2 === 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1, ro), 0, Math.PI * 2);
          ctx.arc(cx, cy, Math.max(0.5, ri), 0, Math.PI * 2, true);
          ctx.fillStyle = fillAlt;
          ctx.fill();
        }
      }
    }

    // ── 3. 内部圈描边（细线） ──
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

    // ── 4. 最外圈描边（粗线） ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.strokeStyle = strokeOuter;
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // ── 4.5 选中态：虚线外框 ──
    if (isSel) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, mp + 5), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 160, 130, 0.5)';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 5. 圆心标记 ──
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
    const id = Date.now();
    this.circles.push({
      id,
      center: { lat: center.lat, lng: center.lng },
      maxRadius,
      interval: interval || CONFIG.CONCENTRIC_INTERVAL
    });
    this.selectedCircleId = id;
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
   * 使用纯 JS 算法（已被大量中国地图项目验证通过），
   * 不依赖腾讯地图 convertor API（API 回调格式不一致且不可靠）。
   * @param {{lat:number, lng:number}} point
   * @returns {{lat:number, lng:number}}
   */
  wgs84ToGcj02(point) {
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
   */
  _createLocationIcon() {
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
   */
  setLocation(center) {
    const latLng = new qq.maps.LatLng(center.lat, center.lng);

    if (this.locationMarker) {
      this.locationMarker.setPosition(latLng);
    } else {
      this.locationMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createLocationIcon()
      });
    }
  }

  /**
   * 更新历史轨迹线
   * @param {Array<{lat:number,lng:number}>} positions GCJ-02 坐标数组
   */
  setTrail(positions) {
    if (!this.map) return;
    if (positions.length < 2) {
      this.clearTrail();
      return;
    }

    // 重建 Polyline（每次全量更新）
    if (this.trailPolyline) {
      this.trailPolyline.setMap(null);
    }

    const path = positions.map(p => new qq.maps.LatLng(p.lat, p.lng));
    this.trailPolyline = new qq.maps.Polyline({
      path,
      strokeColor: new qq.maps.Color(0, 212, 170, 0.45),
      strokeWeight: 3.5,
      strokeStyle: qq.maps.PolylineStrokeStyle.SOLID,
      map: this.map
    });
  }

  /**
   * 清除历史轨迹线
   */
  clearTrail() {
    if (this.trailPolyline) {
      this.trailPolyline.setMap(null);
      this.trailPolyline = null;
    }
  }

  destroy() {
    this.clearTrail();
    if (this.marker) {
      this.marker.setMap(null);
      this.marker = null;
    }
    if (this.locationMarker) {
      this.locationMarker.setMap(null);
      this.locationMarker = null;
    }
    this.map = null;
    this.center = null;
  }
}
