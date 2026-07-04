/**
 * MultiplayerClient — 双人联机定位
 * ──────────────────────────────────
 * WebSocket 客户端，负责：
 * 1. 房间创建/加入（6位房间码）
 * 2. 本地位置 → 服务端广播
 * 3. 对方位置 → 回调通知
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
    this._pingTimer = null;
  }

  /** 创建房间 */
  createRoom() {
    this._connect(() => {
      this._send({ type: 'create_room' });
    });
  }

  /** 加入房间 */
  joinRoom(roomCode) {
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

  /** 断开连接 */
  disconnect() {
    this._stopPing();
    clearTimeout(this._reconnectTimer);
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
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      onOpen();
      return;
    }

    this._emitState('connecting');
    this.ws = new WebSocket(this.serverUrl);

    this.ws.onopen = () => {
      this.connected = true;
      this._emitState('connected');
      this._startPing();
      onOpen();
    };

    this.ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this._handleMessage(msg);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._stopPing();
      this._emitState('disconnected');
    };

    this.ws.onerror = () => {
      this._emitState('error');
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
        break;
    }
  }

  _emitState(state) {
    if (this.onStateChange) this.onStateChange(state);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, 25_000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}
