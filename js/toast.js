/**
 * Toast 提示 — 从 app.js 拆出的独立模块 (#18)
 * =============================================
 * 短暂的顶部居中消息提示
 */

class Toast {
  /**
   * 显示短暂提示
   * @param {string} message
   * @param {number} [duration=3000] 显示时长（毫秒）
   */
  static show(message, duration) {
    const existing = document.querySelector('.toast-msg');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    const ms = duration || CONFIG.DEFAULT_TOAST_DURATION;
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
    }, ms);
  }
}
