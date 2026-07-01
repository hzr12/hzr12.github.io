/**
 * 轨迹管理 — 从 app.js 拆出的独立模块 (#18)
 * =============================================
 * 轨迹点存储、采样、距离计算
 */

class Trail {
  constructor() {
    this.positions = [];      // 轨迹点数组
    this.lastPos = null;      // 上次记录的位置（用于采样）
    this.isRecording = false; // 是否正在记录
  }

  /**
   * 开始新记录（清空旧轨迹）
   */
  start() {
    this.positions = [];
    this.lastPos = null;
    this.isRecording = true;
  }

  /**
   * 停止记录
   */
  stop() {
    this.isRecording = false;
  }

  /**
   * 清除所有轨迹点
   */
  clear() {
    this.positions = [];
    this.lastPos = null;
  }

  /**
   * 采样记录一个轨迹点（每 >10m 采一个点，最多 500 个）
   * @param {{lat:number,lng:number,wgsLat?:number,wgsLng?:number,time?:number,accuracy?:number,speed?:number,heading?:number}} pt
   * @returns {boolean} 是否实际添加了点
   */
  addPoint(pt) {
    if (!pt) return false;
    // 防御：拒绝无效坐标
    if (typeof pt.lat !== 'number' || !isFinite(pt.lat) ||
        typeof pt.lng !== 'number' || !isFinite(pt.lng)) {
      console.warn('[Trail] 丢弃无效点:', pt.lat, pt.lng);
      return false;
    }
    if (this.lastPos && calcDistance(
      { lat: pt.lat, lng: pt.lng },
      { lat: this.lastPos.lat, lng: this.lastPos.lng }
    ) <= CONFIG.TRAIL_SAMPLE_MIN_DIST) {
      return false;
    }
    this.positions.push(pt);
    this.lastPos = pt;
    if (this.positions.length > CONFIG.TRAIL_MAX_POINTS) {
      this.positions = this.positions.slice(-CONFIG.TRAIL_MAX_POINTS);
    }
    return true;
  }

  /**
   * 计算轨迹总距离
   * @returns {number} 米
   */
  getDistance() {
    if (this.positions.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < this.positions.length; i++) {
      total += calcDistance(
        { lat: this.positions[i-1].lat, lng: this.positions[i-1].lng },
        { lat: this.positions[i].lat, lng: this.positions[i].lng }
      );
    }
    return total;
  }

  /**
   * @returns {number} 轨迹点数量
   */
  getPointCount() {
    return this.positions.length;
  }

  /**
   * 滑动窗口平均平滑，返回新的坐标数组（不修改原始数据）
   * @param {number} [windowSize=5] 窗口大小（奇数效果最佳）
   * @returns {Array<{lat:number,lng:number,speed?:number,time?:number,…>}
   */
  getSmoothedPositions(windowSize = 5) {
    const n = this.positions.length;
    if (n < 4) return this.positions.slice();
    const half = Math.floor(windowSize / 2);
    const result = [];
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - half);
      const end = Math.min(n - 1, i + half);
      let sumLat = 0, sumLng = 0;
      for (let j = start; j <= end; j++) {
        sumLat += this.positions[j].lat;
        sumLng += this.positions[j].lng;
      }
      const count = end - start + 1;
      // 保留原始所有字段，只覆盖 lat/lng
      result.push(Object.assign({}, this.positions[i], {
        lat: sumLat / count,
        lng: sumLng / count,
        _smoothed: true
      }));
    }
    return result;
  }
}
