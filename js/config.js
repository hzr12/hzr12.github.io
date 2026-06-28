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
  STORAGE_KEY: 'circlemap_data'
};

/**
 * 计算两点之间的球面距离（Haversine 公式）
 * @param {{lat:number,lng:number}} p1
 * @param {{lat:number,lng:number}} p2
 * @returns {number} 距离（米）
 */
function calcDistance(p1, p2) {
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return CONFIG.EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 格式化距离文字
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
  if (meters < 10) return `${Math.round(meters)}m`;
  if (meters < 1000) return `${Math.round(meters)}m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(2)}km`;
  return `${(meters / 1000).toFixed(1)}km`;
}
