package com.hqtwitter;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * public/ 의 웹 UI를 앱 안의 WebView로 띄우고, 저장만 네이티브(갤러리)로 처리한다.
 * 에셋은 https://appassets.androidplatform.net/assets/ 로 서빙해야 모듈 워커와 wasm이 정상 동작한다.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String BASE = "https://" + HOST + "/assets/index.html";
    private static final int MAX_SHARED_TEXT = 2000;

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            // 네이티브 브릿지(HqNative)가 앱 내장 페이지에만 노출되도록, 다른 주소로의 페이지 이동은 막는다
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }
        });
        webView.addJavascriptInterface(new NativeBridge(this, webView), "HqNative");
        setContentView(webView);

        load(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent);
    }

    private void load(Intent intent) {
        String shared = null;
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            // 어떤 앱이든 공유로 보낼 수 있으니 길이를 제한한다 (트윗 링크만 쓰고 나머지는 무시)
            shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null && shared.length() > MAX_SHARED_TEXT) shared = shared.substring(0, MAX_SHARED_TEXT);
        }
        String url = shared == null ? BASE : BASE + "?text=" + Uri.encode(shared);
        webView.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
