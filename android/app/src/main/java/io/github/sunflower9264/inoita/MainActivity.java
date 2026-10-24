package io.github.sunflower9264.inoita;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 离线 WebView 壳。
 *
 * 游戏构建产物（story-game/dist）作为 Android assets 打进 APK，
 * 再由 WebViewAssetLoader 映射到 https://appassets.androidplatform.net/。
 * 之所以不用 file://：模块脚本、fetch 和 localStorage 都需要一个稳定的 HTTPS 源。
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String GAME_URL = "https://" + ASSET_HOST + "/index.html";
    private static final long DOUBLE_BACK_MS = 2000;

    private FrameLayout root;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private long lastBackPressed;
    /** 诊断上报走单线程后台队列，避免占用 WebView 的 JS 线程。 */
    private final ExecutorService diagnosticsExecutor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = getWindow().getAttributes();
            attrs.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attrs);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        setContentView(root);

        assetLoader = new WebViewAssetLoader.Builder()
                // 离线包里没有接收端；相对路径的诊断请求直接吞掉。APK 的上报地址由
                // document-start 脚本写入全局变量，指向项目服务器。
                .addPathHandler("/__diagnostics/", path -> new WebResourceResponse(
                        "application/json", "utf-8", 204, "No Content",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0])))
                // 根路径必须和入口 /index.html 配对；源码里还有 /assets/... 的硬编码路径。
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(getApplicationContext()))
                .build();

        createWebView();
        hideSystemBars();
    }

    private void createWebView() {
        webView = new WebView(this);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setBackgroundColor(getColor(R.color.background));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setFocusable(true);

        // 原生桥优先于 document-start 注入：旧 WebView 也能上报，且不受页面跨域限制。
        webView.addJavascriptInterface(new DiagnosticsBridge(), "InotiaNative");

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 页面是 HTTPS 源，诊断服务器是项目内的 HTTP 地址；只允许这条上报通道使用明文。
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);

        // 在 diagnostics.js 之前把上报地址交给页面；网页版没有这个全局变量，仍用相对路径。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView,
                    "globalThis.__inoitaDiagnosticsEndpoint=" + JSONObject.quote(BuildConfig.DIAGNOSTICS_URL) + ";",
                    Collections.singleton("*"));
        }

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    @NonNull WebView view, @NonNull WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    @NonNull WebView view, @NonNull WebResourceRequest request) {
                String host = request.getUrl().getHost();
                return host == null || !ASSET_HOST.equals(host);
            }

            @Override
            public boolean onRenderProcessGone(
                    @NonNull WebView view, @NonNull RenderProcessGoneDetail detail) {
                // 渲染进程被系统回收后 WebView 实例不可再用，换一个新的，避免整个应用闪退。
                root.post(MainActivity.this::recreateWebView);
                return true;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(GAME_URL + "?v=" + BuildConfig.VERSION_CODE);
    }

    /** 页面只提交已经组装好的诊断 JSON；地址和发送方式都由原生层固定。 */
    private final class DiagnosticsBridge {
        @JavascriptInterface
        public void report(String body, String requestId) {
            if (body == null || requestId == null || body.isEmpty() || body.length() > 65536) return;
            try {
                diagnosticsExecutor.execute(() -> {
                    boolean acknowledged = postDiagnostics(body);
                    WebView view = webView;
                    if (view == null) return;
                    view.post(() -> {
                        if (webView != view) return;
                        try {
                            view.evaluateJavascript("window.__inoitaNativeReportResult&&window.__inoitaNativeReportResult("
                                    + JSONObject.quote(requestId) + "," + acknowledged + ");", null);
                        } catch (RuntimeException ignored) {
                            // WebView 正在销毁时回调已经没有必要。
                        }
                    });
                });
            } catch (RuntimeException ignored) {
                // Activity 已销毁，新的页面会重新建立上报通道。
            }
        }
    }

    private boolean postDiagnostics(String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BuildConfig.DIAGNOSTICS_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w("InotiaDiagnostics", "diagnostics report returned HTTP " + code);
                return false;
            }
            return true;
        } catch (Exception error) {
            Log.w("InotiaDiagnostics", "diagnostics report failed: " + error.getClass().getSimpleName());
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void destroyWebView() {
        if (webView == null) return;
        root.removeView(webView);
        webView.destroy();
        webView = null;
    }

    private void recreateWebView() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        destroyWebView();
        createWebView();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        }
    }

    @Override
    protected void onPause() {
        WebView view = webView;
        if (view != null) {
            // 先让页面跑完 pagehide（暂停场景、音频并落一次自动存档），再冻结 WebView。
            view.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", ignored -> {
                view.onPause();
                view.pauseTimers();
            });
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        WebView view = webView;
        if (view != null) {
            view.resumeTimers();
            view.onResume();
            view.postDelayed(() -> view.evaluateJavascript(
                    "window.dispatchEvent(new Event('pageshow'));", null), 50);
        }
        hideSystemBars();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        WebView view = webView;
        if (view != null) {
            view.requestFocus();
            long now = SystemClock.uptimeMillis();
            dispatchEscape(view, now);
        }

        long now = SystemClock.uptimeMillis();
        if (now - lastBackPressed <= DOUBLE_BACK_MS) {
            lastBackPressed = 0;
            confirmExit();
        } else {
            lastBackPressed = now;
        }
    }

    private void dispatchEscape(WebView view, long now) {
        KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0,
                KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD);
        KeyEvent up = new KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0,
                KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD);
        view.dispatchKeyEvent(down);
        view.dispatchKeyEvent(up);
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        new AlertDialog.Builder(this)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .setNegativeButton(R.string.exit_cancel, null)
                .show();
    }

    @Override
    protected void onDestroy() {
        diagnosticsExecutor.shutdownNow();
        destroyWebView();
        super.onDestroy();
    }
}
