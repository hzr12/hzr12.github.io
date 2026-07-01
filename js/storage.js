/**
 * 数据持久化 — 从 app.js 拆出的独立模块 (#18)
 * =============================================
 * localStorage 读写，仅处理纯数据
 */

class Storage {
  /**
   * 保存圆圈状态
   * @param {object} mapManager - 用于读取 circles/selectedCircleId
   * @param {number} circleRadius
   * @param {{lat:number,lng:number}|null} center
   */
  static saveCircles(mapManager, circleRadius, center) {
    try {
      const data = {
        circles: mapManager.getCircles().map(c => ({
          id: c.id,
          center: c.center,
          maxRadius: c.maxRadius,
          interval: c.interval,
          createdAt: c.createdAt
        })),
        selectedCircleId: mapManager.selectedCircleId,
        circleRadius: circleRadius,
        center: center
      };
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[Storage] 保存失败:', e.message);
    }
  }

  /**
   * 恢复圆圈状态
   * @returns {object|null} { circles, selectedCircleId, circleRadius, center }
   */
  static loadCircles() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[Storage] 恢复失败:', e.message);
      return null;
    }
  }

  // ----- 轨迹持久化 -----

  static TRAIL_KEY = 'circlemap_trail';

  /**
   * 保存轨迹数据
   * @param {Trail} trail
   */
  static saveTrail(trail) {
    try {
      const data = {
        positions: trail.positions
      };
      localStorage.setItem(this.TRAIL_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[Storage] 轨迹保存失败:', e.message);
    }
  }

  /**
   * 恢复轨迹数据
   * @returns {{positions:Array}|null}
   */
  static loadTrail() {
    try {
      const raw = localStorage.getItem(this.TRAIL_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[Storage] 轨迹恢复失败:', e.message);
      return null;
    }
  }
}
