// ============================================================
// init.js - 初始化 + 全局事件绑定 + window 导出
// ============================================================

// Polyfill: AbortSignal.timeout for old WebView
if (typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = function(ms) {
    var ctrl = new AbortController();
    setTimeout(function() { ctrl.abort(); }, ms);
    return ctrl.signal;
  };
}

// 错误捕获（改为非阻塞提示，避免弹窗挡住通知授权等浏览器原生对话框）
function showErrToast(t) {
  try {
    var el = document.createElement('div');
    el.textContent = t;
    el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;background:rgba(214,64,64,.94);color:#fff;font-size:12px;padding:8px 12px;border-radius:8px;max-width:82%;box-shadow:0 4px 14px rgba(0,0,0,.25);line-height:1.4';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4500);
  } catch (e) {}
}
window.onerror = function (msg, src, line, col, err) {
  console.error('脚本报错：', msg, '行' + line + ' 列' + col, err);
  showErrToast('脚本报错：' + msg);
  return false;
};
window.addEventListener('error', function (e) {
  if (e.message) { console.error('加载/运行错误：', e.message); showErrToast('运行错误：' + e.message); }
});

// 初始化入口
function init() {
  function setPhoneH() {
    document.documentElement.style.setProperty('--phone-h', window.innerHeight + 'px');
  }
  setPhoneH();
  window.addEventListener('resize', setPhoneH);
  renderEmojiPanel();
  if (!state.checkins.find(function(c) { return c.id === 'ck-water'; })) {
    var today = new Date();
    var weekLater = new Date(today);
    weekLater.setDate(weekLater.getDate() + 7);
    var fmt = function(d) { return d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate(); };
    state.checkins.push({ id: 'ck-water', name: '喝水打卡', start: fmt(today), end: fmt(weekLater), totalDays: 7, doneDays: 0, status: 'doing' });
    saveState();
  }
  var _prof = activeProfile();
  var _mp = state.myProfile || {};
  if (_prof && !_prof.avatar && _mp.avatarImage) {
    _prof.avatar = _mp.avatarImage;
    saveState();
  }
  renderChat();
  initDragDesktop();
  bindHotspots();
  if (typeof loadNcmState === 'function') loadNcmState();
  if (typeof loadQqState === 'function') loadQqState();
  if (typeof maybeProbeNcm === 'function') maybeProbeNcm();
  if (typeof startIdleProactive === 'function') startIdleProactive();
  if (typeof initPush === 'function') initPush();
  setupLaunchFullscreen();
}

// 从桌面图标启动（已安装 PWA）时，第一次用户手势进入真全屏（隐藏状态栏）。
// 浏览器禁止页面自动全屏，所以必须等首次点击/触摸；普通浏览器里不触发。
function setupLaunchFullscreen() {
  var mq = window.matchMedia;
  var launched = (mq && (mq('(display-mode: standalone)').matches || mq('(display-mode: fullscreen)').matches)) || window.navigator.standalone;
  if (!launched) return;
  var el = document.documentElement;
  var reqFs = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!reqFs) return;
  var hint = document.createElement('div');
  hint.id = 'fsHint';
  hint.textContent = '点击任意处进入全屏';
  hint.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;background:rgba(0,0,0,.7);color:#fff;font-size:13px;padding:8px 14px;border-radius:20px;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.3)';
  document.body.appendChild(hint);
  var fired = false;
  function enter() {
    if (fired) return; fired = true;
    try { reqFs.call(el); } catch (e) {}
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    window.removeEventListener('pointerdown', enter);
    window.removeEventListener('touchstart', enter);
    window.removeEventListener('click', enter);
  }
  window.addEventListener('pointerdown', enter);
  window.addEventListener('touchstart', enter);
  window.addEventListener('click', enter);
}

// 桌面热点绑定（兼容触摸 + 鼠标）
function bindHotspots() {
  document.querySelectorAll('.hotspot').forEach(hs => {
    const name = hs.getAttribute('data-name');
    if (!name) return;
    let touched = false;
    hs.addEventListener('touchstart', function(ev) {
      touched = true;
      ev.preventDefault();
      if (name === '许愿柳' || name === '许愿流') { showWillowPortal(); return; }
      openApp(name);
    }, { passive: false });
    hs.addEventListener('click', function(ev) {
      if (touched) { touched = false; return; }
      if (name === '许愿柳' || name === '许愿流') { showWillowPortal(); return; }
      openApp(name);
    });
  });
}

function toggleDebug() { document.getElementById('contentArea').classList.toggle('debug-mode'); }

// 桌面滑动
function initDragDesktop() {
  const slider = $('slider');
  let isDown = false, startX = 0, scrollLeft = 0, startY = 0, moved = false;

  slider.addEventListener('mousedown', e => {
    if ($('appModal').classList.contains('active')) return;
    isDown = true; moved = false;
    startX = e.pageX - slider.offsetLeft;
    startY = e.pageY;
    scrollLeft = slider.scrollLeft;
  });
  slider.addEventListener('mouseup', () => isDown = false);
  slider.addEventListener('mouseleave', () => isDown = false);
  slider.addEventListener('mousemove', e => {
    if (!isDown) return;
    if ($('appModal').classList.contains('active')) { isDown = false; return; }
    const dx = e.pageX - slider.offsetLeft - startX;
    if (Math.abs(dx) > 6 || Math.abs(e.pageY - startY) > 6) moved = true;
    if (moved) { e.preventDefault(); slider.scrollLeft = scrollLeft - dx * 1.5; }
  });

  slider.addEventListener('touchstart', e => {
    if ($('appModal').classList.contains('active')) return;
    isDown = true; moved = false;
    startX = e.touches[0].pageX - slider.offsetLeft;
    startY = e.touches[0].pageY;
    scrollLeft = slider.scrollLeft;
  }, { passive: true });
  slider.addEventListener('touchmove', e => {
    if (!isDown) return;
    if ($('appModal').classList.contains('active')) { isDown = false; return; }
    const dx = e.touches[0].pageX - slider.offsetLeft - startX;
    const dy = e.touches[0].pageY - startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
    if (moved) slider.scrollLeft = scrollLeft - dx * 1.5;
  }, { passive: true });
  slider.addEventListener('touchend', () => { isDown = false; moved = false; }, { passive: true });
}

// ===== 导出到 window（确保内联 onclick 正常工作）=====
var _w = window;
_w.toggleDebug = toggleDebug; _w.openApp = openApp; _w.closeApp = closeApp; _w.quickNotice = quickNotice;
_w.switchTab = switchTab; _w.openChat = openChat; _w.closeChat = closeChat; _w.openSettings = openSettings; _w.closeSettings = closeSettings;
_w.togglePin = togglePin; _w.clearHistory = clearHistory; _w.toggleMore = toggleMore; _w.toggleEmoji = toggleEmoji; _w.toggleAutoMem = toggleAutoMem; _w.setAutoMemLen = setAutoMemLen; _w.setAutoMemEvery = setAutoMemEvery; _w.manualSummarizeMemory = manualSummarizeMemory;
_w.sendChat = sendChat; _w.sendRed = sendRed; _w.selectRpAmount = selectRpAmount; _w.onRpAmountInput = onRpAmountInput; _w.confirmRedPacket = confirmRedPacket; _w.openRedPacket = openRedPacket; _w.toggleVoice = toggleVoice; _w.stopVoice = stopVoice; _w.voiceTouchStart = voiceTouchStart; _w.voiceTouchEnd = voiceTouchEnd; _w.saveApiConfig = saveApiConfig; _w.fetchModels = fetchModels; _w.filterModelSuggestions = filterModelSuggestions; _w.showAllModels = showAllModels;
_w.testConnection = testConnection; _w.exportAllData = exportAllData; _w.importAllData = importAllData; _w.resetAllData = resetAllData;
_w.renderCharacterEditor = renderCharacterEditor; _w.saveCharacter = saveCharacter; _w.deleteCharacter = deleteCharacter; _w.addMemory = addMemory;
_w.deleteMemory = deleteMemory; _w.uploadAvatar = uploadAvatar; _w.postMoment = postMoment; _w.saveMyProfile = saveMyProfile; _w.settingsAddMemory = settingsAddMemory; _w.settingsDeleteMemory = settingsDeleteMemory;
_w.newProfile = newProfile; _w.editProfile = editProfile;
_w.doCheckin = doCheckin; _w.deleteCheckin = deleteCheckin; _w.submitNewCheckin = submitNewCheckin; _w.submitEditCheckin = submitEditCheckin;
_w.addDiary = addDiary; _w.setStudyMinutes = setStudyMinutes; _w.setBreak = setBreak;
_w.toggleStudy = toggleStudy; _w.finishStudy = finishStudy; _w.clearStudyRecords = clearStudyRecords; _w.companionSay = companionSay; _w.refreshCompanion = refreshCompanion; _w.inviteStudy = inviteStudy;
_w.switchStudyCompanion = switchStudyCompanion; _w.toggleStudySound = toggleStudySound; _w.studySoundStop = studySoundStop;
_w.addLedger = addLedger; _w.deleteLedger = deleteLedger; _w.editLedger = editLedger; _w.changeLedgerMonth = changeLedgerMonth;
_w.clearCanvas = clearCanvas; _w.saveDoodle = saveDoodle; _w.undoDoodle = undoDoodle; _w.uploadDoodleBg = uploadDoodleBg;
_w.uploadMusic = uploadMusic; _w.playSong = playSong; _w.playMusic = playSong; _w.renameMusic = renameMusic; _w.deleteMusic = deleteMusic; _w.togglePlay = togglePlay; _w.nextSong = nextSong; _w.prevSong = prevSong; _w.cycleMode = cycleMode; _w.toggleFav = toggleFav; _w.setFavView = setFavView; _w.searchMusic = searchMusic; _w.clearSearch = clearSearch; _w.playSearch = playSearch; _w.openNcmLogin = openNcmLogin; _w.closeNcmLogin = closeNcmLogin; _w.setSearchSrc = setSearchSrc; _w.openQqLogin = openQqLogin; _w.closeQqLogin = closeQqLogin;
_w.renderLive = renderLive; _w.renderLiveHall = renderLiveHall; _w.openLiveRoom = openLiveRoom; _w.filterHall = filterHall; _w.liveBack = liveBack; _w.liveOpenProfile = liveOpenProfile; _w.liveCloseProfile = liveCloseProfile; _w.liveProfileFollow = liveProfileFollow; _w.liveProfileMessage = liveProfileMessage; _w.liveSay = liveSay; _w.liveHeart = liveHeart; _w.liveFollow = liveFollow; _w.liveGift = liveGift; _w.toggleLiveGifts = toggleLiveGifts; _w.toggleLiveSongs = toggleLiveSongs; _w.toggleLiveBoard = toggleLiveBoard; _w.liveSong = liveSong; _w.liveSign = liveSign; _w.liveBar = liveBar; _w.liveMic = liveMic; _w.liveBagGrab = liveBagGrab; _w.startGame = startGame; _w.hitTarget = hitTarget; _w.submitGuess = submitGuess; _w.resetGuess = resetGuess; _w.initSnake = initSnake; _w.saveSpace = saveSpace; _w.spaceKiss = spaceKiss; _w.spaceTask = spaceTask; _w.spaceSwitchRole = spaceSwitchRole; _w.spaceLoveLine = spaceLoveLine; _w.renderOffline = renderOffline; _w.offlinePickScene = offlinePickScene; _w.toggleScenePicker = toggleScenePicker; _w.offlineInvite = offlineInvite; _w.offlineSend = offlineSend; _w.offlineEnd = offlineEnd; _w.offlineSubmitInvite = offlineSubmitInvite;
_w.likeMoment = likeMoment; _w.addComment = addComment; _w.deleteMessage = deleteMessage; _w.openAlbumPicker = openAlbumPicker; _w.startCapture = startCapture;
_w.fertilizePlant = fertilizePlant; _w.plantMood = plantMood;
_w.addLedgerQuick = addLedgerQuick;
_w.renderAlbum = renderAlbum; _w.addPhoto = addPhoto; _w.uploadPhoto = uploadPhoto; _w.deletePhoto = deletePhoto; _w.viewPhoto = viewPhoto; _w.toggleAlbumUpload = toggleAlbumUpload;
_w.openAlbum = openAlbum; _w.newAlbum = newAlbum; _w.renameAlbum = renameAlbum; _w.delAlbum = delAlbum; _w.renderAlbumPhotos = renderAlbumPhotos;
_w.capturePhoto = capturePhoto; _w.renamePhoto = renamePhoto; _w.copyPhoto = copyPhoto; _w.movePhoto = movePhoto;
_w.renderHome = renderHome; _w.switchRoom = switchRoom; _w.openFurniture = openFurniture; _w.closeHomePanel = closeHomePanel; _w.doFurnitureAction = doFurnitureAction; _w.spawnRoomEffect = spawnRoomEffect;
_w.toggleHomeLog = toggleHomeLog; _w.waterPlant = waterPlant; _w.touchPlant = touchPlant;
_w.cakeNewOrder = cakeNewOrder; _w.cakePick = cakePick; _w.cakeNextStep = cakeNextStep; _w.cakeRestart = cakeRestart;
_w.hidePanels = hidePanels; _w.toggleHabit = toggleHabit; _w.addHabit = addHabit; _w.delHabit = delHabit; _w.stopMusic = stopMusic;
_w.renderIGProfile = renderIGProfile; _w.switchProfileTab = switchProfileTab; _w.renderFeed = renderFeed; _w.renderCharLibrary = renderCharLibrary; _w.openCharFromLib = openCharFromLib; _w.bindStoryItems = bindStoryItems; _w.renderIGLiveHall = renderIGLiveHall;
_w.createCharFromLib = createCharFromLib; _w.renderIGCharEditor = renderIGCharEditor; _w.igHandleAvatarUpload = igHandleAvatarUpload; _w.igClearAvatar = igClearAvatar; _w.saveIGCharEditor = saveIGCharEditor; _w.deleteIGChar = deleteIGChar;
_w.igAddMemory = igAddMemory; _w.igDeleteMemory = igDeleteMemory;
_w.renderDmList = renderDmList; _w.renderMyProfileContent = renderMyProfileContent;
_w.openProfileEditor = openProfileEditor; _w.closeProfileEditor = closeProfileEditor;
_w.handleProfileAvatarUpload = handleProfileAvatarUpload; _w.handleProfileCoverUpload = handleProfileCoverUpload;
_w.resetProfileAvatar = resetProfileAvatar; _w.saveProfile = saveProfile;
_w.openPostCreator = openPostCreator; _w.closePostCreator = closePostCreator;
_w.handlePostImageSelect = handlePostImageSelect; _w.setPostFilter = setPostFilter;
_w.postCreatorNext = postCreatorNext; _w.publishPost = publishPost;
_w.viewPost = viewPost; _w.closePostDetail = closePostDetail; _w.deletePost = deletePost;
_w.openIGStory = openIGStory; _w.igLikeAutoPost = igLikeAutoPost; _w.toggleAutoPost = toggleAutoPost; _w.showIGToast = showIGToast;
_w.renderEmojiPanel = renderEmojiPanel; _w.sendSticker = sendSticker; _w.filterStickerPanel = filterStickerPanel; _w.filterStickerByCat = filterStickerByCat; _w.showStickerImportDialog = showStickerImportDialog; _w.doImportStickers = doImportStickers; _w.addStickerFolder = addStickerFolder; _w.toggleStickerManage = toggleStickerManage; _w.exitStickerManage = exitStickerManage; _w.toggleStickerSelect = toggleStickerSelect; _w.deleteSelectedStickers = deleteSelectedStickers; _w.moveSelectedStickers = moveSelectedStickers; _w.showStickerFolderPicker = showStickerFolderPicker; _w.moveSelectedToIdx = moveSelectedToIdx; _w.moveSelectedTo = moveSelectedTo; _w.addStickerFolderThenMove = addStickerFolderThenMove; _w.showStickerFolderDeletePicker = showStickerFolderDeletePicker; _w.deleteStickerFolderIdx = deleteStickerFolderIdx; _w.showFolderActionMenu = showFolderActionMenu; _w.renameStickerFolder = renameStickerFolder; _w.deleteStickerFolder = deleteStickerFolder; _w.refreshAllStickerImages = refreshAllStickerImages;
_w.renderStickerManager = renderStickerManager; _w.openStickerForm = openStickerForm;
_w.closeStickerForm = closeStickerForm; _w.stickerPickImage = stickerPickImage; _w.saveStickerForm = saveStickerForm;
_w.deleteSticker = deleteSticker;
_w.renderWillow = renderWillow; _w.makeWish = makeWish; _w.clearWishToday = clearWishToday;
_w.currentWillowWish = currentWillowWish; _w.currentWillowRule = currentWillowRule; _w.willowContextText = willowContextText; _w.willowBlocksProactive = willowBlocksProactive; _w.willowBlocksReplyFor = willowBlocksReplyFor; _w.willowBreaksRelation = willowBreaksRelation; _w.willowParseRule = willowParseRule;
_w.startIdleProactive = startIdleProactive; _w.setIdleParams = setIdleParams;
_w.showInnerVoice = showInnerVoice; _w.closeInnerVoice = closeInnerVoice;

// ===== APP 检查更新（对比 GitHub Release 版本号）=====
// 版本号统一从根目录 version.json 读取，发新版只改那一个文件即可
var APP_VERSION = '1.0.0';
(function () {
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 5000);
    fetch('version.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.version) APP_VERSION = String(d.version); })
      .catch(function () {});
  } catch (e) {}
})();
var APP_RELEASE_API = 'https://api.github.com/repos/josslynwood136-ux/meledi-apk/releases/latest';
function _cmpVer(a, b) {
  var pa = String(a).split('.'), pb = String(b).split('.');
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function openExternal(url) {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url: url });
      return;
    }
  } catch (e) {}
  var w = window.open(url, '_blank');
  if (!w) { window.location.href = url; }
}
function closeUpdateModal() {
  var m = document.getElementById('updateModal');
  if (m) m.classList.remove('active');
}
function updateGoDownload() {
  var url = window._updateUrl || APP_RELEASE_API;
  var bodyEl = document.getElementById('updateBody');
  var actBtn = document.getElementById('updateActionBtn');
  var installer = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ApkInstaller) || null;
  if (installer && /\.apk(\?|$)/i.test(url)) {
    if (actBtn) actBtn.disabled = true;
    if (bodyEl) bodyEl.textContent = '正在下载更新包，请稍候…';
    installer.downloadAndInstall({ url: url }).then(function () {
      if (actBtn) actBtn.disabled = false;
      closeUpdateModal();
    }).catch(function (err) {
      if (actBtn) actBtn.disabled = false;
      if (bodyEl) bodyEl.textContent = '应用内下载失败（' + ((err && err.message) || err || '未知错误') + '），已改为浏览器下载。';
      openExternal(url);
    });
  } else {
    openExternal(url);
    closeUpdateModal();
  }
}
function showUpdateResult(d) {
  var titleEl = document.getElementById('updateTitle');
  var bodyEl = document.getElementById('updateBody');
  var actBtn = document.getElementById('updateActionBtn');
  if (!titleEl || !bodyEl || !actBtn) return;
  var remote = String(d.tag_name || '').replace(/^v/i, '');
  var apk = null;
  (d.assets || []).forEach(function (a) { if (!apk && /\.apk$/i.test(a.name)) apk = a; });
  window._updateUrl = apk ? apk.browser_download_url : (d.html_url || APP_RELEASE_API);
  var notes = (d.body || '').trim();
  if (remote && _cmpVer(remote, APP_VERSION) > 0) {
    titleEl.textContent = '发现新版本 v' + remote;
    var html = '当前版本 v' + APP_VERSION + '，有新版本可用。';
    if (notes) {
      html += '<div style="margin-top:10px;max-height:180px;overflow:auto;white-space:pre-wrap;font-size:13px;color:#666">' + escapeHTML(notes) + '</div>';
    }
    bodyEl.innerHTML = html;
    actBtn.style.display = '';
    actBtn.textContent = '立即更新';
  } else {
    titleEl.textContent = '已是最新版本';
    bodyEl.textContent = '当前已是最新版本 v' + APP_VERSION + '，无需更新。';
    actBtn.style.display = 'none';
  }
  var m = document.getElementById('updateModal');
  if (m) m.classList.add('active');
}
function checkAppUpdate() {
  var titleEl = document.getElementById('updateTitle');
  var bodyEl = document.getElementById('updateBody');
  var actBtn = document.getElementById('updateActionBtn');
  if (titleEl) titleEl.textContent = '检查更新中…';
  if (bodyEl) bodyEl.textContent = '正在连接 GitHub 获取最新版本信息…';
  if (actBtn) actBtn.style.display = 'none';
  var m = document.getElementById('updateModal');
  if (m) m.classList.add('active');
  fetch(APP_RELEASE_API, { cache: 'no-store', headers: { 'Accept': 'application/vnd.github+json' } })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { showUpdateResult(d); })
    .catch(function () {
      if (titleEl) titleEl.textContent = '检查失败';
      if (bodyEl) bodyEl.textContent = '无法连接 GitHub，请检查网络后重试。';
      if (actBtn) actBtn.style.display = 'none';
    });
}
_w.checkAppUpdate = checkAppUpdate;
_w.closeUpdateModal = closeUpdateModal;
_w.updateGoDownload = updateGoDownload;


// 离开时保存
window.addEventListener('beforeunload', saveState);

// DOM 就绪后启动
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { try { init(); } catch (e) { alert('init 执行失败：' + e.message); } });
} else {
  try { init(); } catch (e) { alert('init 执行失败：' + e.message); }
}
