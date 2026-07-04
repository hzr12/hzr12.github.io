/**
 * MultiplayerClient — 多人联机定位
 * ──────────────────────────────────
 * WebSocket 客户端，负责：
 * 1. 房间创建/加入（6位房间码，最多8人）
 * 2. 本地位置 → 服务端广播
 * 3. 对方位置 → 回调通知
 * 4. 断线自动重连（指数退避）
 */

class MultiplayerClient {
  /**
   * @param {string} serverUrl WebSocket 地址，如 ws://localhost:3000
   */
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.roomId = null;
    this.playerId = null;
    this.slot = null;
    this.connected = false;

    /** 回调 */
    this.onPeerPosition = null;  // (pos) => void
    this.onPeerJoined = null;    // (slot) => void
    this.onPeerLeft = null;      // () => void
    this.onRoomCreated = null;   // (roomCode) => void
    this.onRoomJoined = null;    // (roomCode) => void
    this.onError = null;         // (msg) => void
    this.onStateChange = null;   // (state: 'connecting'|'connected'|'disconnected'|'error') => void
    this.onTargetSet = null;     // (pos) => void

    this._reconnectTimer = null;
    this._reconnectDelay = 1000;  // 初始重连延迟 1s
    this._reconnectMaxDelay = 30000; // 最大 30s
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._pingTimer = null;
    this._pongTimer = null;
    this._pendingOnOpen = null;   // 等待连接建立后执行的回调
    this._hadError = false;       // 标记是否发生过错误
    this._intentionalClose = false; // 标记是否主动断开
  }

  /** 创建房间 */
  createRoom() {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._connect(() => {
      this._send({ type: 'create_room' });
    });
  }

  /** 加入房间 */
  joinRoom(roomCode) {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._connect(() => {
      this._send({ type: 'join_room', roomCode });
    });
  }

  /** 发送位置 */
  sendPosition(pos) {
    if (!this.connected) return;
    this._send({
      type: 'position',
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy,
      altitude: pos.altitude,
      speed: pos.speed,
      heading: pos.heading,
      timestamp: Date.now()
    });
  }

  /** 标记对方位置（游戏辅助） */
  sendTarget(lat, lng, radius) {
    if (!this.connected) return;
    this._send({ type: 'target_set', lat, lng, radius });
  }

  /** 断开连接（不触发自动重连） */
  disconnect() {
    this._intentionalClose = true;
    this._stopPing();
    this._stopPong();
    clearTimeout(this._reconnectTimer);
    this._reconnectAttempts = 0;
    this._pendingOnOpen = null;
    if (this.ws) {
      this.ws.close(1000, '主动断开');
      this.ws = null;
    }
    this.connected = false;
    this.roomId = null;
    this.playerId = null;
    this.slot = null;
  }

  get isConnecting() {
    return this.ws && this.ws.readyState === WebSocket.CONNECTING;
  }

  // ── 内部方法 ──

  _connect(onOpen) {
    // 如果已 OPEN，直接执行回调
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      onOpen();
      return;
    }

    // 如果正在 CONNECTING，不要重复调用 onOpen，只记录待执行回调
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this._pendingOnOpen = onOpen;
      return;
    }

    this._pendingOnOpen = onOpen;
    this._emitState('connecting');
    this._hadError = false;

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (e) {
      this._emitState('error');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._reconnectAttempts = 0;
      this._reconnectDelay = 1000;
      this._emitState('connected');
      this._startPing();

      // 执行等待中的回调
      if (this._pendingOnOpen) {
        const cb = this._pendingOnOpen;
        this._pendingOnOpen = null;
        cb();
      }
    };

    this.ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this._handleMessage(msg);
    };

    this.ws.onclose = (evt) => {
      this.connected = false;
      this._stopPing();
      this._stopPong();
      this.ws = null;

      // 如果不是主动断开，且没报过错，才显示 disconnected
      if (!this._intentionalClose && !this._hadError) {
        this._emitState('disconnected');
      }

      // 自动重连（非主动断开时）
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this._hadError = true;
      this._emitState('error');
      // onclose 会紧随其后触发，不需要在这里重连
    };
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'room_created':
        this.roomId = msg.roomId;
        this.playerId = msg.playerId;
        this.slot = msg.slot;
        if (this.onRoomCreated) this.onRoomCreated(msg.roomId);
        break;

      case 'room_joined':
        this.roomId = msg.roomId;
        this.playerId = msg.playerId;
        this.slot = msg.slot;
        if (this.onRoomJoined) this.onRoomJoined(msg.roomId);
        break;

      case 'peer_joined':
        if (this.onPeerJoined) this.onPeerJoined(msg.slot);
        break;

      case 'peer_left':
        if (this.onPeerLeft) this.onPeerLeft();
        break;

      case 'peer_position':
        if (this.onPeerPosition) {
          this.onPeerPosition({
            lat: msg.lat,
            lng: msg.lng,
            accuracy: msg.accuracy,
            altitude: msg.altitude,
            speed: msg.speed,
            heading: msg.heading,
            timestamp: msg.timestamp,
            playerId: msg.playerId,
            slot: msg.slot
          });
        }
        break;

      case 'target_set':
        if (this.onTargetSet) {
          this.onTargetSet({ lat: msg.lat, lng: msg.lng, radius: msg.radius });
        }
        break;

      case 'error':
        if (this.onError) this.onError(msg.message);
        break;

      case 'pong':
        this._stopPong();
        break;
    }
  }

  _emitState(state) {
    if (this.onStateChange) this.onStateChange(state);
  }

  // ── 心跳 ──

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
      // 启动 pong 超时检测（10秒内没收到 pong → 判定连接已死）
      this._startPong();
    }, 25_000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _startPong() {
    this._stopPong();
    this._pongTimer = setTimeout(() => {
      // 超时没收到 pong → 关闭连接，触发重连
      if (this.ws) {
        this.ws.close(4000, 'Pong 超时');
      }
    }, 10_000);
  }

  _stopPong() {
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  // ── 自动重连（指数退避） ──

  _scheduleReconnect() {
    if (this._intentionalClose) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._emitState('error');
      if (this.onError) this.onError('重连次数超限，请检查服务器地址');
      return;
    }

    const delay = Math.min(
      this._reconnectDelay * Math.pow(2, this._reconnectAttempts),
      this._reconnectMaxDelay
    );
    this._reconnectAttempts++;

    console.log(`[Multiplayer] ${delay / 1000}s 后重连（第 ${this._reconnectAttempts} 次）`);

    this._reconnectTimer = setTimeout(() => {
      if (this._intentionalClose) return;
      this._emitState('connecting');
      this._connect(() => {
        // 重连成功后，如果有房间信息，自动重新加入
        // 注意：房间可能已过期，服务端会返回错误
        // 这里不自动重连房间，只重连 WebSocket
      });
    }, delay);
  }
}
