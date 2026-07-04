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

    // GNSS 插件（Capacitor 原生端卫星数据）
    this._gnssPlugin = null;       // Capacitor.Plugins.GnssData 引用
    this._gnssSatellites = [];     // GnssSatelliteInfo[]
    this._gnssInitError = null;    // 初始化失败原因
    this._gnssListeningStarted = false; // startGnss() 是否已调用
    this._gnssStarting = null;     // startGnss() 的 Promise，防止并发
    this._gnssStatusHandle = null; // gnssStatus 事件监听器句柄
    this._gnssNmeaHandle = null;   // nmeaSentence 事件监听器句柄
    this._gnssPollId = null;       // GNSS 轮询兜底定时器

    // 电量监控
    this._lowBattery = false;
    this._powerSaving = false;  // 省电模式开关
    this._powerSavingLocked = false;  // 省电模式锁定（低电量时锁定开启）
    this._battery = null;       // BatteryManager 引用（用于清理）
    this._batteryCheck = null;  // 电池检查函数引用（用于清理）
    this._initBatteryMonitor();
    this._tryInitGnssPlugin();

    // GPS 节流：最多每 5 秒处理一次位置更新
    this._lastProcessedTime = 0;
    this._gpsMinInterval = 5000; // 毫秒
  }

  /**
   * 初始化电池监控 — 低电量时降低 GPS 频率
   */
  _initBatteryMonitor() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      this._battery = battery;
      this._batteryCheck = () => {
        const wasLow = this._lowBattery;
        this._lowBattery = battery.level < 0.2;
        if (this._lowBattery && !wasLow) {
          console.warn('[GPS] 电量低于 20%，已降低 GPS 频率');
          // 低电量时锁定省电模式
          this._powerSavingLocked = true;
          if (!this._powerSaving) {
            this.togglePowerSaving(true);
          }
          // 仅在刚进入低电量时重启 watchPosition
          if (this.isWatching) {
            this.stopWatching();
            this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 15000 });
          }
        }
        // 充电时解锁省电模式
        if (!this._lowBattery && this._powerSavingLocked && battery.charging) {
          this._powerSavingLocked = false;
          console.log('[GPS] 电量恢复，省电模式已解锁');
        }
      };
      battery.addEventListener('levelchange', this._batteryCheck);
      battery.addEventListener('chargingchange', this._batteryCheck);
      this._batteryCheck();
    }).catch(() => {});
  }

  /**
   * 清理电池监控监听器
   */
  _cleanupBatteryMonitor() {
    if (this._battery && this._batteryCheck) {
      this._battery.removeEventListener('levelchange', this._batteryCheck);
      this._battery.removeEventListener('chargingchange', this._batteryCheck);
      this._battery = null;
      this._batteryCheck = null;
    }
  }

  /**
   * 切换省电模式
   * @param {boolean} [force] - 强制设置，不传则切换
   * @returns {boolean} 当前省电模式状态
   */
  togglePowerSaving(force) {
    // 锁定时不允许关闭
    if (this._powerSavingLocked && force === false) {
      console.warn('[GPS] 电量不足，省电模式已锁定');
      return true;
    }
    const next = force !== undefined ? force : !this._powerSaving;
    if (next === this._powerSaving) return this._powerSaving;
    this._powerSaving = next;
    console.log(`[GPS] 省电模式: ${next ? '开启' : '关闭'}`);
    if (this.isWatching) {
      this.stopWatching();
      if (next) {
        // 省电模式：低精度 + 长超时 + 允许缓存
        this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 15000 });
      } else {
        // 标准模式：高精度 + 短超时
        this.startWatching({ enableHighAccuracy: true, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 5000 });
      }
    }
    return this._powerSaving;
  }

  /**
   * 获取省电模式状态
   */
  get isPowerSaving() {
    return this._powerSaving;
  }

  /**
   * 获取省电模式是否锁定
   */
  get isPowerSavingLocked() {
    return this._powerSavingLocked;
  }

  /**
   * 探测 Capacitor GNSS 原生插件是否存在。
   * 仅存储插件引用，不启动监听——监听需要定位权限，延迟到 startGnss() 调用。
   */
  _tryInitGnssPlugin() {
    if (typeof Capacitor === 'undefined' || !Capacitor.Plugins) {
      this._gnssInitError = 'not_capacitor';
      return;
    }
    const plugin = Capacitor.Plugins.GnssData;
    if (!plugin) {
      this._gnssInitError = 'plugin_not_registered';
      return;
    }
    this._gnssPlugin = plugin;
    console.log('[GPS] GNSS 插件已探测到，等待 startGnss() 激活');
  }

  /**
   * 激活 GNSS 监听（注册卫星状态 + NMEA 回调）。
   * 需确认定位权限已授予后调用，由 app.js 在首次定位成功后触发。
   */
  async startGnss() {
    if (!this._gnssPlugin) {
      // 尝试重新探测（Capacitor 可能延迟加载）
      this._tryInitGnssPlugin();
      if (!this._gnssPlugin) {
        console.warn('[GPS] startGnss 跳过：无 GNSS 插件引用');
        return;
      }
    }
    if (this._gnssListeningStarted) {
      return; // 已启动
    }
    // 防止并发调用（用 Promise 作为 mutex）
    if (this._gnssStarting) {
      return this._gnssStarting;
    }
    this._gnssStarting = this._startGnssImpl();
    try {
      await this._gnssStarting;
    } finally {
      this._gnssStarting = null;
    }
  }

  /**
   * startGnss() 的实际实现
   */
  async _startGnssImpl() {
    try {
      // 先请求 Capacitor 权限（与浏览器 GPS 权限是独立的）
      if (typeof Capacitor !== 'undefined' && Capacitor.requestPermissions) {
        const result = await Capacitor.requestPermissions({ permissions: ['location'] });
        if (result.location !== 'granted') {
          console.warn('[GPS] GNSS 权限未授予:', result.location);
          this._gnssInitError = 'permission_denied';
          return;
        }
      }

      // ⚠️ 先注册监听器，再调用 startGnssListening()
      // 原因：Java 端 registerGnssCallback() 会立即开始回调，
      // 如果先 start 后 addListener，第一批卫星事件会被丢弃（竞态条件）
      const gnssHandler = (event) => {
        if (event && event.satellites) {
          this._gnssSatellites = event.satellites;
          console.log('[GPS] GNSS 事件收到，卫星数:', event.satellites.length);
        }
      };
      const nmeaHandler = (nmea) => {
        if (nmea) {
          console.log('[GPS] NMEA:', nmea.sentence?.substring(0, 20) + '...');
        }
      };

      // 先注册（Capacitor 允许在 native 方法调用前注册 listener）
      this._gnssStatusHandle = this._gnssPlugin.addListener('gnssStatus', gnssHandler);
      this._gnssNmeaHandle = this._gnssPlugin.addListener('nmeaSentence', nmeaHandler);

      // 再启动原生监听
      try {
        await this._gnssPlugin.startGnssListening();
      } catch (startErr) {
        // 把 PermissionDenied 直接显式说清楚，方便排查
        const code = startErr && startErr.code ? String(startErr.code) : 'NO_CODE';
        const msg = `[${code}] ${startErr?.message || '未知'}`;
        console.warn('[GPS] startGnssListening 拒绝:', msg);
        if (code === 'PERMISSION_DENIED') {
          Toast.show(`❌ ACCESS_FINE_LOCATION 权限被拒 — 请到系统设置→应用→CircleMap→位置，开启"始终允许"`, 6000);
        } else {
          Toast.show(`❌ startGnssListening: ${msg}`, 5000);
        }
        throw startErr;
      }
      this._gnssListeningStarted = true;
      this._gnssInitError = null;
      console.log('[GPS] GNSS 插件已激活，卫星数据可用');
      Toast.show('🛰️ GNSS 启动，等待卫星...');

      // 兜底轮询：前 15 秒每 2 秒主动拉取一次，防止事件丢失
      this._startGnssPollFallback();
    } catch (err) {
      this._gnssInitError = err.message || 'start_failed';
      console.warn('[GPS] GNSS 插件激活失败:', err.message);
      Toast.show(`❌ GNSS 启动失败: ${err.message || '未知错误'}`, 4000);
      // 清理可能已注册的监听器
      this._removeGnssListeners();
    }
  }

  /**
   * GNSS 轮询兜底：启动后前 15 秒每 2 秒拉取一次 getLastGnssData()
   * 如果事件监听正常工作，轮询结果只是冗余覆盖（无副作用）
   */
  _startGnssPollFallback() {
    this._stopGnssPollFallback();
    let elapsed = 0;
    const interval = 2000;
    const maxDuration = 15000;
    let toastedNoData = false; // 避免 2s 轮询重复弹 toast

    this._gnssPollId = setInterval(async () => {
      elapsed += interval;
      if (!this._gnssListeningStarted || !this._gnssPlugin) {
        this._stopGnssPollFallback();
        return;
      }
      // 如果事件已收到卫星数据，提前停止轮询
      if (this._gnssSatellites.length > 0) {
        console.log('[GPS] GNSS 轮询兜底：已收到卫星数据，停止轮询');
        Toast.show(`🛰️ 已检测到 ${this._gnssSatellites.length} 颗卫星`);
        this._stopGnssPollFallback();
        return;
      }
      try {
        const data = await this._gnssPlugin.getLastGnssData();
        // 关键：await 之后再 re-check，stopGnss() 可能在我们 yield 期间清空了状态，
        // 此时任何回写都会让 _gnssSatellites 显示陈旧数据
        if (!this._gnssListeningStarted || !this._gnssPlugin) {
          this._stopGnssPollFallback();
          return;
        }
        if (data && data.satellites && data.satellites.length > 0) {
          this._gnssSatellites = data.satellites;
          console.log('[GPS] GNSS 轮询兜底：收到卫星数:', data.satellites.length);
          Toast.show(`🛰️ 兜底轮询：${data.satellites.length} 颗卫星`);
          this._stopGnssPollFallback();
        }
      } catch (e) {
        console.warn('[GPS] GNSS 轮询兜底失败:', e.message);
      }
      if (elapsed >= maxDuration) {
        this._stopGnssPollFallback();
        if (this._gnssSatellites.length === 0 && !toastedNoData) {
          toastedNoData = true;
          console.warn('[GPS] GNSS 轮询兜底：15s 内未收到卫星数据');
          Toast.show('[GPS] GNSS 轮询兜底：15s 内未收到卫星数据', 5000);
        }
      }
    }, interval);
  }

  _stopGnssPollFallback() {
    if (this._gnssPollId) {
      clearInterval(this._gnssPollId);
      this._gnssPollId = null;
    }
  }

  /**
   * 移除所有 GNSS 事件监听器
   */
  _removeGnssListeners() {
    try {
      if (this._gnssStatusHandle) { this._gnssStatusHandle.remove(); this._gnssStatusHandle = null; }
      if (this._gnssNmeaHandle) { this._gnssNmeaHandle.remove(); this._gnssNmeaHandle = null; }
    } catch (e) {
      // Capacitor v6 用 remove()，旧版可能没有
      try { this._gnssPlugin?.removeAllListeners?.(); } catch (_) {}
    }
  }

  /**
   * 停止 GNSS 监听，移除事件监听器。
   */
  stopGnss() {
    if (!this._gnssPlugin || !this._gnssListeningStarted) return;
    this._removeGnssListeners();
    this._stopGnssPollFallback();
    try {
      this._gnssPlugin.stopGnssListening?.();
    } catch (e) {
      // 插件可能没有这些方法
    }
    this._gnssListeningStarted = false;
    this._gnssSatellites = [];
    this._gnssInitError = null;
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
        // 节流：最多每 _gpsMinInterval 毫秒处理一次
        const now = Date.now();
        if (now - this._lastProcessedTime < this._gpsMinInterval) {
          // 即使节流，也要更新超时检测时间，避免误判超时
          this._lastPositionTime = now;
          return;
        }
        this._lastProcessedTime = now;

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
   * 释放所有资源（GPS + GNSS + 电池监控）
   */
  destroy() {
    this.stopWatching();
    this.stopGnss();
    this._cleanupBatteryMonitor();
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

  /**
   * 是否已连接 Capacitor GNSS 插件（原生端）
   */
  get hasGnssPlugin() {
    return this._gnssPlugin !== null;
  }

  /**
   * GNSS 是否已激活（正在监听卫星数据）
   */
  get isGnssActive() {
    return this._gnssListeningStarted && this._gnssPlugin !== null;
  }

  /**
   * GNSS 初始化错误
   */
  get gnssError() {
    return this._gnssInitError;
  }

  /**
   * 可见卫星列表（来自原生 GNSS 插件）
   * @returns {Array<{svid:number, constellation:string, cn0DbHz:number, usedInFix:boolean}>}
   */
  get gnssSatellites() {
    return this._gnssSatellites.slice(); // 返回防御性副本
  }

  /**
   * 参与定位的卫星数
   */
  get gnssUsedCount() {
    return this._gnssSatellites.filter(s => s.usedInFix).length;
  }

  /**
   * 可见卫星总数
   */
  get gnssVisibleCount() {
    return this._gnssSatellites.length;
  }

  /**
   * 参与定位卫星的平均信噪比 (dB-Hz)
   */
  get gnssAvgSnr() {
    const used = this._gnssSatellites.filter(s => s.usedInFix);
    if (used.length === 0) return 0;
    return used.reduce((sum, s) => sum + s.cn0DbHz, 0) / used.length;
  }

  /**
   * 按星座分组的卫星数量
   * @returns {{gps:number, beidou:number, glonass:number, galileo:number, other:number}}
   */
  get gnssConstellationStats() {
    const stats = { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 };
    for (const s of this._gnssSatellites) {
      switch (s.constellation) {
        case 'GPS':     stats.gps++; break;
        case 'BEIDOU':  stats.beidou++; break;
        case 'GLONASS': stats.glonass++; break;
        case 'GALILEO': stats.galileo++; break;
        default:        stats.other++; break;
      }
    }
    return stats;
  }
}
