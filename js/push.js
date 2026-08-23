// ============================================================
// push.js - 后台消息通知（本地 Service Worker 通知，墙内也可用）
// 说明：标准 Web Push 必须走 Google FCM，在大陆常被墙，subscribe 会报
// "push service error"。本实现改用 SW 本地通知：只要 App 在后台（未关闭），
// 角色来消息时直接弹系统通知，不依赖 FCM / VAPID / 订阅。
// ============================================================

// 原生 App（安卓 / iOS）通过 Capacitor 注入 window.Capacitor，用系统本地通知替代 Web Push
var isNative = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications);
var pushSupported = isNative || (('serviceWorker' in navigator) && ('Notification' in window));
var _pushReady = false;
var appInForeground = true; // 原生 App 的前后台状态（由 App 插件监听）

// 推送请求基址：原生 App 读部署地址，浏览器读同源 origin
function getPushBase() {
  return (typeof window.__SERVER_BASE__ !== 'undefined' && window.__SERVER_BASE__) ? window.__SERVER_BASE__ : location.origin;
}

// localStorage 记录用户是否开启通知
function pushEnabled() { try { return localStorage.getItem('pushEnabled') === '1'; } catch (e) { return false; } }
function setPushEnabled(v) { try { localStorage.setItem('pushEnabled', v ? '1' : '0'); } catch (e) {} }

// 开启：只请求通知权限（不需要 FCM 订阅 / VAPID），墙内也能用
async function subscribePush() {
  if (!pushSupported) { quickNotice('当前环境不支持通知'); return false; }
  if (isNative) return nativeSubscribe();
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    quickNotice('通知权限已被本站点拒绝，请点地址栏左侧图标 → 站点设置 → 把通知改为「允许」后再试');
    return false;
  }
  try {
    optimisticEnable();
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setPushEnabled(false); refreshPushUI();
      quickNotice('未授予通知权限，无法开启');
      return false;
    }
    setPushEnabled(true);
    _pushReady = true;
    refreshPushUI();
    subscribeToServer(); // 后台订阅服务端 Web Push（失败不影响本地通知）
    quickNotice('已开启后台通知 ✓');
    return true;
  } catch (e) {
    console.error(e);
    setPushEnabled(false); refreshPushUI();
    quickNotice('开启失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

// 立即反馈：点开关后马上翻状态 + 提示，避免等权限弹窗时像“卡住”
function optimisticEnable() {
  setPushEnabled(true);
  refreshPushUI();
  quickNotice('正在开启通知…');
}

// 关闭：取消服务端订阅 + 本地标记
async function unsubscribePush() {
  setPushEnabled(false);
  _pushReady = false;
  stopNativePoll();
  await unsubscribeFromServer();
  refreshPushUI();
  quickNotice('已关闭后台通知');
}

// ---------- 原生 App（安卓）专属：本地通知 + 轮询 ----------
async function nativeSubscribe() {
  try {
    optimisticEnable();
    var perm = await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
    // perm.receive: 'granted' | 'denied' | 'limited'
    if (!perm || perm.receive !== 'granted') {
      setPushEnabled(false); refreshPushUI();
      quickNotice('未授予通知权限，无法开启');
      return false;
    }
    setPushEnabled(true);
    _pushReady = true;
    refreshPushUI();
    subscribeToServer();
    startNativePoll();
    quickNotice('已开启后台通知 ✓');
    return true;
  } catch (e) {
    console.error(e);
    setPushEnabled(false); refreshPushUI();
    quickNotice('开启失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

async function nativeTestPush() {
  if (!pushEnabled()) { quickNotice('请先开启通知'); return; }
  quickNotice('正在生成并推送…');
  try {
    var r = await fetch(getPushBase() + '/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: pushClientId() })
    });
    var d = await r.json().catch(function () { return {}; });
    if (d && d.text) {
      showLocalNotification('美乐地 · 测试', d.text.slice(0, 200), '');
      quickNotice('已生成并推送：「' + d.text.slice(0, 40) + (d.text.length > 40 ? '…' : '') + '」——切到别的 App 时会看到系统通知');
    } else {
      quickNotice('测试失败：' + (d && d.error ? d.error : '未知错误'));
    }
  } catch (e) {
    quickNotice('测试失败：' + (e && e.message ? e.message : e));
  }
}

// 主动消息轮询：App 在后台（未彻底杀进程）时仍定时拉取服务器待发消息
var _nativePollTimer = null;
function startNativePoll() {
  if (_nativePollTimer) return;
  pollNativePending();
  _nativePollTimer = setInterval(pollNativePending, 60000);
}
function stopNativePoll() {
  if (_nativePollTimer) { clearInterval(_nativePollTimer); _nativePollTimer = null; }
}
async function pollNativePending() {
  if (!pushEnabled() || !_pushReady) return;
  try {
    var r = await fetch(getPushBase() + '/push/poll?clientId=' + encodeURIComponent(pushClientId()));
    var d = await r.json().catch(function () { return {}; });
    if (!d || !d.messages || !d.messages.length) return;
    d.messages.forEach(function (m) {
      applyPushMessage(m.charId, m.body);
      if (!appInForeground) {
        showLocalNotification(m.title || '美乐地', (m.body || '').slice(0, 200), m.charId);
      }
    });
  } catch (e) {}
}

// 切换
async function togglePush() {
  if (pushEnabled()) await unsubscribePush();
  else await subscribePush();
}

// 弹一条本地通知（原生 App 走系统通知，浏览器走 Service Worker）
async function showLocalNotification(title, body, charId) {
  if (isNative) {
    try {
      await window.Capacitor.Plugins.LocalNotifications.schedule({
        notifications: [{
          title: title,
          body: (body || '').slice(0, 200),
          id: Math.floor(Math.random() * 1e9),
          extra: { charId: charId || '', url: '/' }
        }]
      });
    } catch (e) {}
    return;
  }
  var data = { url: '/', charId: charId || '' };
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      var reg = await navigator.serviceWorker.ready;
      return reg.showNotification(title, {
        body: body,
        tag: 'msg-' + (charId || 'all'),
        renotify: false,
        data: data
      });
    }
  } catch (e) {}
  // 兜底：直接 new Notification（部分环境 SW 未就绪时）
  try { new Notification(title, { body: body }); } catch (e) {}
}

// 角色发来消息时调用：仅当 App 在后台才弹系统通知
async function notifyCharacterMessage(name, avatar, text, charId) {
  if (!pushEnabled()) return;
  if (isNative) {
    if (!_pushReady) return;
    if (appInForeground) return; // 前台应用内已有提示，不重复弹
    showLocalNotification(name || '美乐地', (text || '发来一条消息').slice(0, 200), charId);
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return; // 前台时应用内已有提示，不重复弹
  showLocalNotification(name || '美乐地', (text || '发来一条消息').slice(0, 200), charId);
}

// 手动测试：直接弹本地通知（不依赖 FCM，墙内可验证）
async function testPush() {
  if (isNative) return nativeTestPush();
  if (!pushEnabled()) { quickNotice('请先开启通知'); return; }
  showLocalNotification('美乐地 · 测试', '这是一条测试通知 🔔', '');
  quickNotice('已弹出测试通知（切到别的 App 时也能看到）');
}

// 立刻让服务器用当前角色生成一条消息并真正经 Web Push 推给自己（用于即时验证）
async function testServerPush() {
  if (!pushEnabled()) { quickNotice('请先开启通知'); return; }
  if (location.protocol !== 'https:') { quickNotice('需在部署后的 HTTPS 站点测试'); return; }
  quickNotice('正在生成并推送…');
  try {
    var r = await fetch(location.origin + '/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: pushClientId() })
    });
    var d = await r.json().catch(function () { return {}; });
    if (d && d.text) {
      quickNotice('已生成并推送：「' + d.text.slice(0, 40) + (d.text.length > 40 ? '…' : '') + '」——关掉网页后会收到系统通知');
    } else {
      quickNotice('测试失败：' + (d && d.error ? d.error : '未知错误'));
    }
  } catch (e) {
    quickNotice('测试失败：' + (e && e.message ? e.message : e));
  }
}

// 刷新设置页里的推送开关（全局设置与聊天设置两处都同步）
function refreshPushUI() {
  var on = pushEnabled();
  document.querySelectorAll('.push-switch').forEach(function (sw) {
    sw.classList.toggle('on', on);
    sw.onclick = togglePush;
  });
  document.querySelectorAll('.push-test-btn').forEach(function (b) {
    b.style.display = on ? '' : 'none';
  });
  document.querySelectorAll('.push-test-server-btn').forEach(function (b) {
    b.style.display = on ? '' : 'none';
  });
  document.querySelectorAll('.push-hint').forEach(function (hint) {
    if (!pushSupported) hint.textContent = '当前浏览器不支持通知（iOS 需把本页添加到主屏幕且系统 16.4+）';
    else if (on) hint.textContent = '已开启，App 在后台时角色来消息会弹系统通知';
    else hint.textContent = '开启后，App 切到后台时角色来消息会弹系统通知';
  });
}

// 初始化：监听通知点击，并把开关状态同步到界面
async function initPush() {
  if (isNative) {
    // 前后台状态监听（用于决定是否弹系统通知）
    if (window.Capacitor.Plugins.App && window.Capacitor.Plugins.App.addListener) {
      window.Capacitor.Plugins.App.addListener('appStateChange', function (st) {
        appInForeground = !!(st && st.isActive);
      });
    }
    // 点击本地通知 → 打开对应聊天
    if (window.Capacitor.Plugins.LocalNotifications && window.Capacitor.Plugins.LocalNotifications.addListener) {
      window.Capacitor.Plugins.LocalNotifications.addListener('localNotificationActionPerformed', function (n) {
        try {
          var extra = (n && n.notification && n.notification.extra) || {};
          if (extra.charId && typeof getCharacter === 'function' && getCharacter(extra.charId)) openChat(extra.charId);
          else if (typeof openApp === 'function') openApp('消息');
        } catch (e) {}
      });
    }
    refreshPushUI();
    if (pushEnabled()) { subscribeToServer(); startNativePoll(); }
    if (!window._pushProfileTimer) window._pushProfileTimer = setInterval(refreshPushProfile, 3 * 60 * 1000);
    return;
  }
  if (!pushSupported) { refreshPushUI(); return; }
  // 点击通知后 SW 让页面打开对应聊天；若带 body（主动推送）则存进该角色聊天
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'push-click') {
        try {
          if (e.data.body && e.data.charId) applyPushMessage(e.data.charId, e.data.body);
          if (e.data.charId && typeof getCharacter === 'function' && getCharacter(e.data.charId)) {
            openChat(e.data.charId);
          } else if (typeof openApp === 'function') {
            openApp('消息');
          }
        } catch (err) {}
      }
    });
  }
  refreshPushUI();
  // 若已开启但没有有效订阅（首次/服务端重启/重装），重新向服务端订阅
  if (pushEnabled() && location.protocol === 'https:' && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) subscribeToServer();
    }).catch(function () {});
  }
  refreshPushProfile();
  // 定期把最新角色 / 记忆 / API 配置同步给服务器，保证主动推送内容不过时
  if (!window._pushProfileTimer) window._pushProfileTimer = setInterval(refreshPushProfile, 3 * 60 * 1000);
}

// ---------- 真正的 Web Push（VAPID，关掉浏览器也能收） ----------
function pushClientId() {
  var id = '';
  try { id = localStorage.getItem('pushClientId'); } catch (e) {}
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('pushClientId', id); } catch (e) {}
  }
  return id;
}

function urlB64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// 组装「推送画像」：当前角色人设 + 近期记忆 + API 配置（含 key，仅供本人服务器使用）
function buildPushProfile() {
  try {
    var char = (typeof activeCharacter === 'function') ? activeCharacter() : null;
    if (!char) return null;
    var profs = (typeof state !== 'undefined' && state.apiProfiles) || [];
    var activeId = (typeof state !== 'undefined' && state.activeApiProfile) || '';
    var ap = profs.find(function (p) { return p.id === activeId; });
    var api = ap || (typeof state !== 'undefined' && state.api) || {};
    var mems = (char.memories || []).slice(-12).map(function (m) { return { title: m.title, text: m.text }; });
    return {
      char: {
        id: char.id, name: char.name,
        avatar: char.avatarImage || char.avatar,
        personality: char.personality, style: char.style, relation: char.relation,
        background: char.background, prompt: char.prompt, examples: char.examples, greeting: char.greeting
      },
      memories: mems,
      api: { url: api.url, model: api.model, key: api.key },
      tzOffset: new Date().getTimezoneOffset() // 分钟；服务器据此判断用户本地时区的安静时段
    };
  } catch (e) { return null; }
}

async function subscribeToServer() {
  if (isNative) {
    try {
      var profile = buildPushProfile();
      await fetch(getPushBase() + '/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ native: true, clientId: pushClientId(), profile: profile })
      });
    } catch (e) { console.warn('服务端订阅失败（关掉浏览器的主动推送可能不可用）：', e); }
    return;
  }
  if (location.protocol !== 'https:') return; // Web Push 需安全上下文
  try {
    var keyRes = await fetch(location.origin + '/push/vapid-public-key');
    if (!keyRes.ok) return;
    var pub = (await keyRes.json()).publicKey;
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(pub)
    });
    var profile = buildPushProfile();
    await fetch(location.origin + '/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub, clientId: pushClientId(), profile: profile })
    });
  } catch (e) {
    console.warn('服务端推送订阅失败（不影响本地通知）：', e);
    try {
      if (typeof quickNotice === 'function') quickNotice('⚠️ 服务端推送订阅失败，关掉浏览器的主动推送可能不可用（墙内 Chrome 常被墙，建议改用 Safari）');
    } catch (_) {}
  }
}

async function unsubscribeFromServer() {
  if (isNative) {
    try {
      await fetch(getPushBase() + '/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: pushClientId() })
      }).catch(function () {});
    } catch (e) {}
    return;
  }
  if (location.protocol !== 'https:') return;
  try {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(location.origin + '/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub })
      }).catch(function () {});
      await sub.unsubscribe().catch(function () {});
    }
  } catch (e) {}
}

// 切换角色 / 产生新记忆后，把最新画像推给服务器
async function refreshPushProfile() {
  if (!pushEnabled()) return;
  if (isNative) {
    try {
      var profile = buildPushProfile();
      if (!profile) return;
      await fetch(getPushBase() + '/push/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: pushClientId(), profile: profile })
      });
    } catch (e) {}
    return;
  }
  if (location.protocol !== 'https:') return;
  try {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    var profile2 = buildPushProfile();
    if (!profile2) return;
    await fetch(location.origin + '/push/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: pushClientId(), profile: profile2 })
    });
  } catch (e) {}
}

// 主动推送到达且 App 在后台时，把消息写进该角色聊天记录
function applyPushMessage(charId, body) {
  try {
    if (typeof getCharacter !== 'function' || !charId || !body) return;
    var char = getCharacter(charId);
    if (!char) return;
    if (!char.chat) char.chat = [];
    char.chat.push({ role: 'assistant', text: body, time: Date.now() });
    if (char.chat.length > 400) char.chat = char.chat.slice(-400);
    if (typeof saveState === 'function') saveState();
    if (typeof renderChat === 'function') renderChat();
  } catch (e) {}
}

window.subscribePush = subscribePush;
window.unsubscribePush = unsubscribePush;
window.togglePush = togglePush;
window.notifyCharacterMessage = notifyCharacterMessage;
window.testPush = testPush;
window.testServerPush = testServerPush;
window.initPush = initPush;
window.refreshPushUI = refreshPushUI;
window.refreshPushProfile = refreshPushProfile;
window.pushSupported = pushSupported;
