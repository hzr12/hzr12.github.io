/**
 * 圆圈地图 - 配置
 * ============================================
 * 所有可调参数集中管理
 */

const CONFIG = {
  // 腾讯地图 API 密钥
  MAP_KEY: 'OB4BZ-D4W3U-B7VVO-4PJWW-6TKDJ-WPB77',

  // 默认地图中心（广州塔）
  DEFAULT_CENTER: { lat: 23.1291, lng: 113.2644 },

  // 默认缩放级别
  DEFAULT_ZOOM: 12,

  // 定位后缩放级别
  LOCATION_ZOOM: 15,

  // 半径范围（米）
  MIN_RADIUS: 1,
  MAX_RADIUS: 50000,
  DEFAULT_RADIUS: 5000,

  // 同心圆间隔（米）— 每 2.5 公里一圈
  CONCENTRIC_INTERVAL: 2500,

  // 画布最小绘制像素阈值
  MIN_DRAW_PX: 4,

  // GPS 超时时间（毫秒）
  GPS_TIMEOUT: 10000,

  // 地图缩放级别与半径适配映射
  ZOOM_MAP: [
    { maxRadius: 50, zoom: 17 },
    { maxRadius: 100, zoom: 16 },
    { maxRadius: 200, zoom: 15 },
    { maxRadius: 500, zoom: 14 },
    { maxRadius: 1000, zoom: 13 },
    { maxRadius: 2000, zoom: 12 },
    { maxRadius: 5000, zoom: 11 },
    { maxRadius: 10000, zoom: 10 },
    { maxRadius: 20000, zoom: 9 },
    { maxRadius: Infinity, zoom: 8 }
  ],

  // 地球半径（米）
  EARTH_RADIUS: 6371000,

  // localStorage 存储键名
  STORAGE_KEY: 'circlemap_data',

  // ----- 交互参数 -----
  INPUT_DEBOUNCE_MS: 400,           // 坐标输入防抖（毫秒）
  PARSE_DELAY_MS: 300,              // 智能解析防抖（毫秒）
  LONGPRESS_THRESHOLD_MS: 600,      // GPS 按钮长按判定（毫秒）
  LOCATED_ANIM_MS: 3000,            // 定位成功按钮高亮（毫秒）
  EDIT_HIGHLIGHT_MS: 2000,          // 编辑滑块高亮（毫秒）

  // ----- GPS 相关 -----
  POSITION_STALE_MS: 10 * 60 * 1000,    // 位置过期阈值（10 分钟）
  RELOCATE_INTERVAL_MS: 5 * 60 * 1000,  // 自动重定位最小间隔（5 分钟）

  // ----- 显示参数 -----
  STATUS_THROTTLE_MS: 2000,             // 状态条更新节流（毫秒）
  LIST_THROTTLE_MS: 2000,               // 圆列表更新节流（毫秒）
  MAX_RECENT_FIXES: 10,                 // 最近定位最大条数
  MIN_DISPLACEMENT_M: 5,                // 位移重建阈值（米）

  // ----- 轨迹 -----
  TRAIL_SAMPLE_MIN_DIST: 10,            // 轨迹采样最小间隔（米）
  TRAIL_MAX_POINTS: 500,                // 轨迹最大点数

  // ----- UI -----
  MOBILE_BREAKPOINT: 480,               // 移动端断点（像素）
  DEFAULT_TOAST_DURATION: 3000,         // Toast 默认显示时长（毫秒）
  TOAST_FADE_MS: 300,                   // Toast 消失动画（毫秒）
  GPX_URL_REVOKE_DELAY: 5000            // GPX 导出 URL 释放延迟（毫秒）
};

/**
 * 计算两点之间的球面距离（Haversine 公式）
 * @param {{lat:number,lng:number}} p1
 * @param {{lat:number,lng:number}} p2
 * @returns {number} 距离（米）
 */
function calcDistance(p1, p2) {
  try {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.spherical) {
      return qq.maps.spherical.computeDistanceBetween(
        new qq.maps.LatLng(p1.lat, p1.lng),
        new qq.maps.LatLng(p2.lat, p2.lng)
      );
    }
  } catch (_) {}
  // Fallback: 手写 Haversine 公式
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return CONFIG.EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 计算从 p1 到 p2 的方位角（正北顺时针）
 * @param {{lat:number,lng:number}} p1
 * @param {{lat:number,lng:number}} p2
 * @returns {number} 角度 0-360（0=正北）
 */
function calcBearing(p1, p2) {
  try {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.spherical) {
      return qq.maps.spherical.computeHeading(
        new qq.maps.LatLng(p1.lat, p1.lng),
        new qq.maps.LatLng(p2.lat, p2.lng)
      );
    }
  } catch (_) {}
  // Fallback: 手写方位角公式
  const φ1 = p1.lat * Math.PI / 180;
  const φ2 = p2.lat * Math.PI / 180;
  const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * 方位角转文字方向
 * @param {number} deg 角度 0-360
 * @returns {string} 如 "N" / "NE" / "SW"
 */
function bearingToDir(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/**
 * 对数半径映射 — 滑块值 → 实际半径（#11）
 * 让常用小半径区间占据更多滑块行程
 * @param {number} sliderVal 0-1 归一化滑块位置
 * @returns {number} 半径（米）
 */
function sliderToRadius(sliderVal) {
  const minR = CONFIG.MIN_RADIUS;
  const maxR = CONFIG.MAX_RADIUS;
  return Math.round(minR + (maxR - minR) * Math.log(1 + 9 * sliderVal) / Math.log(10));
}

/**
 * 对数半径映射 — 实际半径 → 滑块归一化值（#11）
 * @param {number} radius 半径（米）
 * @returns {number} 0-1 归一化值
 */
function radiusToSlider(radius) {
  const minR = CONFIG.MIN_RADIUS;
  const maxR = CONFIG.MAX_RADIUS;
  const t = (Math.max(radius, minR) - minR) / (maxR - minR);
  return Math.min(1, Math.max(0, (Math.exp(t * Math.log(10)) - 1) / 9));
}

/**
 * 格式化距离文字
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
  const val = Math.round(meters);
  if (val < 10) return `${val}m`;
  if (val < 1000) return `${val}m`;
  if (val < 10000) return `${(val / 1000).toFixed(2)}km`;
  return `${(val / 1000).toFixed(1)}km`;
}
