/**
 * 圆圈地图 - GPS 定位管理器
 * ============================================
 * 使用浏览器原生 Geolocation API 获取设备位置
 * 支持单次定位 + 持续追踪
 */

class GPSManager {
  constructor() {
    this.watchId = null;
    this.currentPosition = null;
    this.isWatching = false;

    // 回调钩子
    this.onPositionChange = null;
    this.onError = null;
    this.onWatchStart = null;
    this.onWatchStop = null;
    this.onDowngrade = null;   // 降级回调 (timeout) => void
    this.onRecovery = null;    // 恢复回调 (success: boolean) => void

    // GPS 超时降级状态
    this._consecutiveTimeouts = 0;  // 连续超时次数
    this._downgraded = false;       // 是否已降级到低精度
    this._lastPositionTime = 0;     // 上次收到位置的时间戳
    this._timeoutCheckId = null;    // 超时检测定时器
    this._recoveryTimerId = null;   // 恢复尝试定时器

    // 电量监控
    this._lowBattery = false;
    this._initBatteryMonitor();
  }

  /**
   * 初始化电池监控 — 低电量时降低 GPS 频率
   */
  _initBatteryMonitor() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      const check = () => {
        const wasLow = this._lowBattery;
        this._lowBattery = battery.level < 0.2;
        if (this._lowBattery && !wasLow) {
          console.warn('[GPS] 电量低于 20%，已降低 GPS 频率');
        }
        // 低电量时重启 watchPosition 用新参数
        if (this.isWatching) {
          this.stopWatching();
          this.isWatching = false;
          this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 15000 });
        }
      };
      battery.addEventListener('levelchange', check);
      check();
    }).catch(() => {});
  }

  /**
   * 获取当前生效的 GPS 超时时间
   */
  _getCurrentTimeout() {
    return this._downgraded ? CONFIG.GPS_LOW_ACCURACY_TIMEOUT : CONFIG.GPS_WATCH_TIMEOUT;
  }

  /**
   * 启动超时检测定时器 — 每秒检查是否超时
   */
  _startTimeoutWatch() {
    this._stopTimeoutWatch();
    this._lastPositionTime = Date.now();
    this._timeoutCheckId = setInterval(() => {
      if (!this.isWatching) return;
      const elapsed = Date.now() - this._lastPositionTime;
      if (elapsed > this._getCurrentTimeout()) {
        this._consecutiveTimeouts++;
        console.warn(`[GPS] 超时 #${this._consecutiveTimeouts}（${(elapsed / 1000).toFixed(0)}s 无新位置）`);
        if (!this._downgraded && this._consecutiveTimeouts >= CONFIG.GPS_TIMEOUT_MAX_FAILURES) {
          this._downgrade();
        }
        // 重置计时起点，避免下次立即又判定超时
        this._lastPositionTime = Date.now();
      }
    }, 1000);
  }

  /**
   * 停止超时检测定时器
   */
  _stopTimeoutWatch() {
    if (this._timeoutCheckId !== null) {
      clearInterval(this._timeoutCheckId);
      this._timeoutCheckId = null;
    }
  }

  /**
   * 降级到低精度定位
   */
  _downgrade() {
    if (this._downgraded) return;
    this._downgraded = true;
    console.warn('[GPS] 连续超时达阈值，降级到低精度定位');
    if (this.onDowngrade) this.onDowngrade(this._consecutiveTimeouts);

    // 用新参数重启 watchPosition
    if (this.isWatching) {
      this.stopWatching();
      this.isWatching = false;
      this.startWatching({
        enableHighAccuracy: false,
        timeout: CONFIG.GPS_LOW_ACCURACY_TIMEOUT,
        maximumAge: 5000
      });
    }

    // 启动恢复尝试定时器
    this._startRecoveryTimer();
  }

  /**
   * 启动恢复尝试定时器 — 每 2 分钟尝试恢复高精度
   */
  _startRecoveryTimer() {
    this._stopRecoveryTimer();
    this._recoveryTimerId = setInterval(() => {
      this._tryRecovery();
    }, CONFIG.GPS_RECOVERY_INTERVAL_MS);
  }

  /**
   * 停止恢复尝试定时器
   */
  _stopRecoveryTimer() {
    if (this._recoveryTimerId !== null) {
      clearInterval(this._recoveryTimerId);
      this._recoveryTimerId = null;
    }
  }

  /**
   * 尝试恢复高精度定位 — 用单次 getCurrentPosition 测试
   */
  async _tryRecovery() {
    if (!this._downgraded || !this.isWatching) return;
    console.log('[GPS] 尝试恢复高精度定位...');
    try {
      await this.getCurrentPosition(CONFIG.GPS_WATCH_TIMEOUT);
      // 成功 → 恢复高精度
      this._downgraded = false;
      this._consecutiveTimeouts = 0;
      this._stopRecoveryTimer();
      console.log('[GPS] 高精度定位恢复成功');
      if (this.onRecovery) this.onRecovery(true);

      // 用高精度参数重启 watchPosition
      if (this.isWatching) {
        this.stopWatching();
        this.isWatching = false;
        this.startWatching({
          enableHighAccuracy: true,
          timeout: CONFIG.GPS_WATCH_TIMEOUT,
          maximumAge: 5000
        });
      }
    } catch (err) {
      // 失败 → 继续低精度
      console.warn('[GPS] 恢复高精度失败:', err.message);
      if (this.onRecovery) this.onRecovery(false);
    }
  }

  /**
   * 重置超时计数（位置成功时调用）
   */
  _resetTimeouts() {
    if (this._consecutiveTimeouts > 0) {
      console.log(`[GPS] 位置更新，重置连续超时计数（was ${this._consecutiveTimeouts}）`);
    }
    this._consecutiveTimeouts = 0;
    this._lastPositionTime = Date.now();
  }

  /**
   * 单次获取当前位置（高精度 GPS）
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<{lat: number, lng: number, accuracy: number}>}
   */
  getCurrentPosition(timeout) {
    const t = timeout || CONFIG.GPS_TIMEOUT;

    // 总超时兜底（比 geolocation timeout 多 5s，防止 GPS 信号弱卡死）
    const fallbackMs = Math.max(t + 5000, 15000);

    return new Promise((resolve, reject) => {
      // 检查浏览器支持
      if (!navigator.geolocation) {
        reject(new Error('您的设备不支持地理定位功能'));
        return;
      }

      // 总超时兜底
      const fallbackTimer = setTimeout(() => {
        reject(new Error('定位请求无响应（' + (fallbackMs / 1000).toFixed(0) + ' 秒超时）'));
      }, fallbackMs);

      navigator.geolocation.getCurrentPosition(
        // 成功回调
        (position) => {
          clearTimeout(fallbackTimer);
          const pos = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude,
            speed: position.coords.speed,
            heading: position.coords.heading,
            timestamp: position.timestamp
          };
          this.currentPosition = pos;
          resolve(pos);
        },
        // 失败回调
        (error) => {
          clearTimeout(fallbackTimer);
          let message;
          switch (error.code) {
            case error.PERMISSION_DENIED:
              message = '定位权限被拒绝，请在浏览器设置中允许访问位置信息';
              break;
            case error.POSITION_UNAVAILABLE:
              message = '无法获取位置信息（GPS 信号弱或不可用）';
              break;
            case error.TIMEOUT:
              message = '定位请求超时，请确保 GPS 已开启并在室外';
              break;
            default:
              message = '定位失败（未知错误）';
          }
          reject(new Error(message));
        },
        {
          enableHighAccuracy: true,
          timeout: t,
          maximumAge: 0 // 每次获取最新位置
        }
      );
    });
  }

  /**
   * 持续监听位置变化
   * @param {object} [options] - 可选，覆盖默认 watchPosition 选项
   */
  startWatching(options) {
    // 已在监听中，且传了新选项 → 重启用新参数
    if (this.isWatching) {
      if (options) {
        this.stopWatching();
      } else {
        console.warn('GPS 已在监听中');
        return;
      }
    }

    if (!navigator.geolocation) {
      if (this.onError) this.onError(new Error('设备不支持地理定位'));
      return;
    }

    const opts = Object.assign({
      enableHighAccuracy: true,
      timeout: CONFIG.GPS_WATCH_TIMEOUT,
      maximumAge: 5000
    }, options || {});

    this.isWatching = true;

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const pos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          speed: position.coords.speed,
          heading: position.coords.heading,
          timestamp: position.timestamp
        };
        this.currentPosition = pos;
        this._resetTimeouts(); // 收到位置 → 重置超时计数
        if (this.onPositionChange) this.onPositionChange(pos);
      },
      (error) => {
        let message;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            message = '定位权限被拒绝';
            break;
          case error.POSITION_UNAVAILABLE:
            message = '无法获取位置信息（GPS 信号弱或不可用）';
            break;
          case error.TIMEOUT:
            message = '定位请求超时，请确保 GPS 已开启并在室外';
            break;
          default:
            message = '定位失败（未知错误）';
        }
        if (this.onError) this.onError(new Error(message));
      },
      opts
    );

    this._startTimeoutWatch(); // 启动超时检测
    if (this.onWatchStart) this.onWatchStart();
  }

  /**
   * 停止监听位置
   */
  stopWatching() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isWatching = false;
    this._stopTimeoutWatch();
    this._stopRecoveryTimer();
    if (this.onWatchStop) this.onWatchStop();
  }

  /**
   * 获取缓存的最近位置
   * @returns {{lat: number, lng: number, accuracy: number}|null}
   */
  getLastPosition() {
    return this.currentPosition;
  }

  /**
   * 是否处于降级（低精度）模式
   */
  get isDowngraded() {
    return this._downgraded;
  }

  /**
   * 连续超时次数
   */
  get consecutiveTimeouts() {
    return this._consecutiveTimeouts;
  }
}
