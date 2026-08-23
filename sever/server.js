// 网易云 + QQ 音乐助手（云端版）
// 网易云 API 跑在内部端口，主服务提供 /qq 路由，其余请求代理给网易云
// 部署到免费云服务器后，手机上的仿真小手机就能扫码登录你的网易云 / QQ 音乐账号
const express = require('express')
const http = require('http')
const https = require('https')
const path = require('path')
const fs = require('fs')
const webpush = require('web-push')

const PORT = Number(process.env.PORT || 3000)

const NCM_PORT = Number(process.env.NCM_PORT || 3100)

// 网易云 API 单独包一层 try/catch：它启动失败绝不能拖垮整个服务（否则网页和 /relay 都挂）
let serveNcmApi = null
try {
  serveNcmApi = require('NeteaseCloudMusicApi').serveNcmApi
} catch (e) {
  console.error('网易云依赖未安装或加载失败（不影响网页与翻译代理）：' + (e && e.message))
}

if (serveNcmApi) {
  serveNcmApi({ port: NCM_PORT, host: '127.0.0.1', checkVersion: false })
    .then(function () {
      console.log('网易云 API 已在 127.0.0.1:' + NCM_PORT + ' 启动')
    })
    .catch(function (e) {
      console.error('网易云 API 启动失败（不影响网页与翻译代理）：' + (e && e.message))
    })
}

const app = express()

// 全局 CORS
app.use(function (req, res, next) {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type,Origin,Cookie')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

// QQ 音乐路由
app.use('/qq', express.json())
app.use('/qq', require('./qq'))

// 探测标记：浏览器用它判断「本站是否带 AI 转发」——有就走 /relay，没有就直连
app.all('/relay-probe', function (req, res) { res.status(204).end() })

// ============================================================
// Web Push（网页后台 / 关闭时也能把消息推到手机）
// ============================================================
// VAPID 密钥：优先用环境变量，否则用项目里的 vapid-keys.json（已生成）
const VAPID_KEYS = (function () {
  const pub = process.env.VAPID_PUBLIC_KEY
  const pri = process.env.VAPID_PRIVATE_KEY
  if (pub && pri) return { publicKey: pub, privateKey: pri }
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'vapid-keys.json'), 'utf8'))
  } catch (e) {
    console.error('未找到 VAPID 密钥：请设置 VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY 或生成 vapid-keys.json')
    return null
  }
})()
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:push@mele.me'
if (VAPID_KEYS) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey)
}

// 订阅存储（文件持久化，重启不丢）
const SUB_FILE = path.join(__dirname, 'push-subscriptions.json')
let pushSubs = []
try { pushSubs = JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')) } catch (e) { pushSubs = [] }
function saveSubs() {
  try { fs.writeFileSync(SUB_FILE, JSON.stringify(pushSubs)) } catch (e) {}
}
function upsertSub(record) {
  if (!record) return
  // 浏览器订阅：以 endpoint 为键
  if (record.subscription && record.subscription.endpoint) {
    const ep = record.subscription.endpoint
    const i = pushSubs.findIndex(function (s) { return s.subscription && s.subscription.endpoint === ep })
    if (i >= 0) pushSubs[i] = Object.assign(pushSubs[i], record); else pushSubs.push(record)
    saveSubs(); return
  }
  // 原生 App（安卓）：无 subscription，以 clientId 为键
  if (record.clientId) {
    const i = pushSubs.findIndex(function (s) { return s.clientId === record.clientId })
    if (i >= 0) pushSubs[i] = Object.assign(pushSubs[i], record)
    else { record.pending = record.pending || []; pushSubs.push(record) }
    saveSubs(); return
  }
}
function removeSubByEndpoint(ep) {
  if (!ep) return
  pushSubs = pushSubs.filter(function (s) { return !(s.subscription && s.subscription.endpoint === ep) })
  saveSubs()
}
function removeSub(record) {
  if (record && record.subscription) removeSubByEndpoint(record.subscription.endpoint)
}

app.use('/push', express.json())
// 前端拿公钥用于订阅
app.get('/push/vapid-public-key', function (req, res) {
  if (!VAPID_KEYS) return res.status(500).json({ error: 'VAPID 未配置' })
  res.json({ publicKey: VAPID_KEYS.publicKey })
})
// 保存订阅（同时带上 clientId 与「推送画像」：角色人设 + 近期记忆 + API 配置）
app.post('/push/subscribe', function (req, res) {
  const sub = req.body && req.body.subscription
  const native = !!(req.body && req.body.native)
  if (!sub && !native) return res.status(400).json({ error: '缺少 subscription 或 native 标记' })
  const record = {
    subscription: sub || null,
    native: native,
    clientId: (req.body && req.body.clientId) || '',
    profile: (req.body && req.body.profile) || null,
    nextPushAt: Date.now() + (2 + Math.floor(Math.random() * 8)) * 60000
  }
  upsertSub(record)
  res.json({ ok: true, count: pushSubs.length })
})
// 取消订阅（支持 endpoint 或 clientId 两种方式）
app.post('/push/unsubscribe', function (req, res) {
  const sub = req.body && req.body.subscription
  const clientId = req.body && req.body.clientId
  if (sub && sub.endpoint) removeSubByEndpoint(sub.endpoint)
  if (clientId) {
    pushSubs = pushSubs.filter(function (s) { return s.clientId !== clientId })
    saveSubs()
  }
  res.json({ ok: true, count: pushSubs.length })
})
// 原生 App 轮询：取回该设备待发的主动消息并清空
app.all('/push/poll', function (req, res) {
  const clientId = (req.query && req.query.clientId) || (req.body && req.body.clientId)
  if (!clientId) return res.status(400).json({ error: '缺少 clientId' })
  const s = pushSubs.find(function (x) { return x.clientId === clientId })
  const msgs = (s && s.pending) ? s.pending : []
  if (s) { s.pending = []; saveSubs() }
  res.json({ ok: true, messages: msgs })
})
// 更新某设备的「推送画像」（切换角色 / 新记忆时由前端调用）
app.post('/push/profile', function (req, res) {
  const clientId = req.body && req.body.clientId
  const profile = req.body && req.body.profile
  if (!clientId) return res.status(400).json({ error: '缺少 clientId' })
  let updated = false
  pushSubs.forEach(function (s) { if (s.clientId === clientId) { s.profile = profile; updated = true } })
  if (updated) saveSubs()
  res.json({ ok: true, updated: updated })
})
// 立刻测试：用该设备的画像生成一条角色消息并立即推送（前端「立刻测试」按钮用）
app.post('/push/test', function (req, res) {
  const clientId = req.body && req.body.clientId
  if (!clientId) return res.status(400).json({ error: '缺少 clientId' })
  const sub = pushSubs.find(function (s) { return s.clientId === clientId })
  if (!sub || !sub.profile) return res.status(404).json({ error: '未找到该设备的订阅 / 画像，请先开启通知并允许订阅' })
  genProactiveMessage(sub.profile).then(function (text) {
    if (!text) return res.json({ ok: false, error: '生成失败' })
    const c = sub.profile.char || {}
    const payload = {
      title: c.name || '美乐地',
      body: text,
      url: '/',
      tag: 'test-' + (c.id || 'all'),
      avatar: (c.avatar && String(c.avatar).indexOf('http') === 0) ? c.avatar : '',
      charId: c.id || ''
    }
    // 原生 App：存入待发队列（由 App 轮询拉取并弹本地通知）
    if (sub.native) {
      if (!sub.pending) sub.pending = []
      sub.pending.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2), title: payload.title, body: payload.body, charId: payload.charId, avatar: payload.avatar, time: Date.now() })
      saveSubs()
      return res.json({ ok: true, text: text, native: true })
    }
    return webpush.sendNotification(sub.subscription, JSON.stringify(payload)).then(function () {
      res.json({ ok: true, text: text })
    }).catch(function (err) {
      res.json({ ok: false, error: '推送失败：' + (err && err.message ? err.message : err), text: text })
    })
  }).catch(function (e) {
    res.json({ ok: false, error: '生成失败：' + (e && e.message ? e.message : e) })
  })
})
// 发送推送（characterId 可选，用于对某角色的单设备定向；这里简单推送给全部订阅）
app.post('/push/send', function (req, res) {
  const payload = {
    title: (req.body && req.body.title) || '美乐地',
    body: (req.body && req.body.body) || '你有一条新消息',
    url: (req.body && req.body.url) || '/',
    tag: (req.body && req.body.tag) || 'msg',
    avatar: (req.body && req.body.avatar) || '',
    charId: (req.body && req.body.charId) || ''
  }
  if (!pushSubs.length) return res.json({ ok: true, sent: 0, skipped: true })
  const data = JSON.stringify(payload)
  let sent = 0, failed = 0
  const tasks = pushSubs.map(function (sub) {
    return webpush.sendNotification(sub.subscription, data).then(function () { sent++ }).catch(function (err) {
      failed++
      if (err.statusCode === 404 || err.statusCode === 410) removeSub(sub) // 订阅失效，清理
    })
  })
  Promise.all(tasks).then(function () {
    res.json({ ok: true, sent: sent, failed: failed, total: pushSubs.length })
  }).catch(function () { res.json({ ok: true, sent: sent, failed: failed }) })
})

// ============================================================
// 主动推送调度：浏览器关闭 / 后台时，由服务器按节奏生成角色消息并推送
// ============================================================
function joinUrl(base, p) {
  base = String(base || '').replace(/\/+$/, '')
  p = String(p || '').replace(/^\/+/, '')
  return base + '/' + p
}
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)) }

// 用角色「推送画像」调 AI 生成一条主动发来的短消息
async function genProactiveMessage(p) {
  const c = p.char || {}
  const mems = (p.memories || []).slice(0, 10)
    .map(function (m) { return '- ' + (m.title ? m.title + '：' : '') + (m.text || '') }).join('\n')
  let prompt = '你是' + (c.name || '角色') + '，是用户的' + (c.relation || '朋友') + '。\n'
  prompt += '性格：' + (c.personality || '普通') + '\n'
  prompt += '说话风格：' + (c.style || '普通') + '\n'
  if (c.background) prompt += '背景：' + c.background + '\n'
  if (mems) prompt += '你们之间的记忆：\n' + mems + '\n'
  prompt += '\n现在你主动给TA发一条微信消息：像真人发微信，口语、短、1~2 句，可以撒娇 / 关心 / 分享日常 / 抛个小话题。不要长篇大论，不要解释自己为什么发，不要加角色名前缀。只输出消息内容本身。'
  const api = p.api || {}
  if (!api.url || !api.key || !api.model) throw new Error('api 未配置')
  const ctrl = new AbortController()
  const timer = setTimeout(function () { ctrl.abort() }, 20000)
  try {
    const r = await fetch(joinUrl(api.url, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api.key },
      body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], max_tokens: 120, temperature: 0.9 }),
      signal: ctrl.signal
    })
    const d = await r.json().catch(function () { return {} })
    const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''
    return text.trim()
  } finally { clearTimeout(timer) }
}

// 每 5 分钟检查一次：到点的订阅就生成并推送一条，再随机排到下一次（2~6 小时后）
async function pushTick() {
  if (!VAPID_KEYS) return
  const now = Date.now()
  const hourUTC = new Date().getUTCHours()
  for (const s of pushSubs) {
    if (!s.profile || !s.profile.api || !s.profile.api.key) continue
    // 按用户本地时区算「安静时段」（默认本地 23:00~08:00 不推送）
    const tzOff = (s.profile && typeof s.profile.tzOffset === 'number') ? s.profile.tzOffset : 0
    const localHour = (((hourUTC - tzOff / 60) % 24) + 24) % 24
    const quiet = (localHour >= 23 || localHour < 8)
    if (quiet) {
      if (!s.nextPushAt || s.nextPushAt < now) { s.nextPushAt = now + 30 * 60000; saveSubs() }
      continue
    }
    if (s.nextPushAt && s.nextPushAt > now) continue
    s.nextPushAt = now + randInt(120, 360) * 60000
    saveSubs()
    try {
      const text = await genProactiveMessage(s.profile)
      if (!text) continue
      const c = s.profile.char || {}
      const msg = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2),
        title: c.name || '美乐地',
        body: text,
        url: '/',
        tag: 'proactive-' + (c.id || 'all'),
        avatar: (c.avatar && String(c.avatar).indexOf('http') === 0) ? c.avatar : '',
        charId: c.id || ''
      }
      // 原生 App：存进待发队列，由 App 后台轮询拉取并弹本地通知（无需 FCM）
      if (s.native) {
        if (!s.pending) s.pending = []
        s.pending.push(msg)
        saveSubs()
      } else {
        await webpush.sendNotification(s.subscription, JSON.stringify(msg)).catch(function (err) {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) removeSubByEndpoint(s.subscription.endpoint)
        })
      }
    } catch (e) { /* 生成失败，下次再试 */ }
  }
}
setInterval(pushTick, 5 * 60 * 1000)
pushTick()

// AI 对话通用转发：访客填哪个网址就转发到哪，密钥留在访客浏览器里
// 浏览器发送 x-relay-target（完整目标 URL）+ x-relay-method，服务端原样转发
app.use('/relay', function (req, res) {
  const target = req.headers['x-relay-target']
  if (!target) return res.status(400).json({ code: 400, msg: '缺少 x-relay-target' })
  let u
  try { u = new URL(target) } catch (e) { return res.status(400).json({ code: 400, msg: '目标网址不合法' }) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).json({ code: 400, msg: '仅支持 http/https' })
  const method = String(req.headers['x-relay-method'] || req.method).toUpperCase()
  const headers = Object.assign({}, req.headers)
  delete headers['x-relay-target']
  delete headers['x-relay-method']
  delete headers.origin
  delete headers.referer
  delete headers.host
  headers.host = u.host
  const client = u.protocol === 'https:' ? https : http
  const proxy = client.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: method,
    headers: headers
  }, function (pr) {
    const outHeaders = Object.assign({}, pr.headers)
    outHeaders['cache-control'] = 'no-store'
    delete outHeaders['etag']
    res.writeHead(pr.statusCode, outHeaders)
    pr.pipe(res)
  })
  proxy.on('error', function () {
    if (!res.headersSent) res.status(502).json({ code: 502, msg: '目标服务暂时不可用' })
    else res.end()
  })
  req.pipe(proxy)
})

// 静态托管整个项目（应用网页在本文件上一级目录）
const APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..')
app.use(function (req, res, next) {
  const p = (req.path || '').split('?')[0]
  if (p === '/sever' || p.startsWith('/sever/') ||
      p === '/node_modules' || p.startsWith('/node_modules/') ||
      p === '/.git' || p.startsWith('/.git/')) {
    return res.status(403).send('Forbidden')
  }
  next()
})
app.use(express.static(APP_ROOT, { index: 'index.html', dotfiles: 'ignore' }))

// 其余请求代理给网易云 API
app.use(function (req, res) {
  const target = {
    hostname: '127.0.0.1',
    port: NCM_PORT,
    path: req.originalUrl,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + NCM_PORT }),
  }
  const proxy = http.request(target, function (pr) {
    res.writeHead(pr.statusCode, pr.headers)
    pr.pipe(res)
  })
  proxy.on('error', function () {
    if (!res.headersSent) res.status(502).json({ code: 502, msg: '服务暂时不可用' })
    else res.end()
  })
  req.pipe(proxy)
})

app.listen(PORT, '0.0.0.0', function () {
  console.log('服务器已启动，监听端口：' + PORT)
})
