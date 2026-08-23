package com.mele.app;

import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    registerPlugin(ApkInstallerPlugin.class);
    // 远程加载模式下，每次启动清空 WebView 缓存并禁用缓存，
    // 保证从 GitHub Pages 拉到最新前端（实现热更新，不被旧缓存卡白屏）
    try {
      WebView wv = getBridge().getWebView();
      wv.clearCache(true);
      wv.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
    } catch (Exception e) {}
  }
}
