package io.github.sunflower9264.inoita;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Display;
import android.view.Surface;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.cefrium.Cefrium;
import com.cefrium.CefriumBrowser;

import java.io.IOException;
import java.util.Locale;

/**
 * 自带 Chromium 156 的 WebView 壳。
 *
 * 页面不再交给系统 WebView，而是由 Cefrium 内置的 Chromium 打开。页面从本地
 * 127.0.0.1 HTTP 服务加载，热更目录、云存档和诊断都走同一个 origin。
 */
public class MainActivity extends Activity implements UpdateManager.Listener {

    private static final String TAG = "InotiaCefrium";
    private static final long DOUBLE_BACK_MS = 2000;
    private static final long BOOT_TIMEOUT_MS = 90000;
    /** 切换显示模式后等待系统生效，再读取实际刷新率。 */
    private static final long DISPLAY_MODE_SETTLE_MS = 800;
    /** Surface 还没建好时，隔一小段时间重试设置目标帧率。 */
    private static final long SURFACE_RATE_RETRY_MS = 250;
    private static final int SURFACE_RATE_MAX_RETRIES = 20;
    /** 给 CEF 释放旧浏览器和渲染进程留出的时间。 */
    private static final long BROWSER_RECREATE_DELAY_MS = 300;
    /** 先让页面跑完 pagehide，再冻结浏览器。 */
    private static final long PAGE_HIDE_SETTLE_MS = 150;
    private static final long BYTES_PER_MEBIBYTE = 1024L * 1024L;
    private static final String ESCAPE_SCRIPT =
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));"
            + "window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));";

    private FrameLayout root;
    private CefriumBrowser browser;
    private LocalAssetServer server;
    private UpdateManager updateManager;
    private long lastBackPressed;
    private boolean pageReady;
    private String migrationJson;
    /** 页面请求的游戏帧率（30/60）；Surface 始终按它向系统投票，不跟随屏幕瞬时低刷新率。 */
    private int requestedFrameRate;
    /** 最近一次读到的屏幕实际刷新率；只用于通知页面换算限帧和日志，不回设 Surface。 */
    private float actualDisplayRate;
    private int surfaceRateRetries;
    private DisplayManager displayManager;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** 刷新率变化时只观察实际值并通知页面；Surface 的帧率请求保持玩家选的 30/60。 */
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int displayId) {}
        @Override public void onDisplayRemoved(int displayId) {}
        @Override public void onDisplayChanged(int displayId) {
            if (displayId == Display.DEFAULT_DISPLAY) observeActualDisplayRate();
        }
    };
    private final Runnable createBrowserTask = this::createBrowser;
    private final Runnable pauseBrowserTask = () -> {
        if (browser != null) browser.onPause();
    };
    private final Runnable bootWatchdog = this::onBootWatchdog;
    private final Runnable applyDisplayRateTask = this::observeActualDisplayRate;

    private AlertDialog updateDialog;
    private AlertDialog checkFailedDialog;
    private ProgressDialog downloadDialog;
    private AlertDialog bootingDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
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
        displayManager = getSystemService(DisplayManager.class);
        if (displayManager != null) {
            displayManager.registerDisplayListener(displayListener, mainHandler);
        }
        CrashLog.deviceInfo(this, "activity-start");

        if (!Cefrium.isInitialized()) {
            // Application 初始化失败时再补一次；Cefrium 只允许初始化一次，失败则直接报错。
            try {
                Cefrium.initialize(this);
            } catch (Throwable error) {
                InotiaApplication.initializeError = Log.getStackTraceString(error);
                CrashLog.append(this, CrashLog.CRASH_LOG_FILE,
                        "cefrium-retry: " + Log.getStackTraceString(error));
            }
        }
        if (!Cefrium.isInitialized()) {
            showFatal(getString(R.string.browser_init_failed_title),
                    getString(R.string.browser_init_failed_message)
                            + (InotiaApplication.initializeError == null ? ""
                            : "\n\n" + InotiaApplication.initializeError));
            return;
        }

        updateManager = UpdateManager.get(getApplicationContext());
        updateManager.setListener(this);
        startWithMigration();
        hideSystemBars();
    }

    private void startWithMigration() {
        final boolean needed = SaveMigration.isNeeded(this);
        final ProgressDialog migrationDialog;
        if (needed) {
            migrationDialog = new ProgressDialog(this);
            migrationDialog.setMessage(getString(R.string.migration_booting));
            migrationDialog.setCancelable(false);
            migrationDialog.show();
        } else {
            migrationDialog = null;
        }

        SaveMigration.migrateIfNeeded(this, json -> {
            if (migrationDialog != null) migrationDialog.dismiss();
            if (isFinishing() || isDestroyed()) return;
            migrationJson = json;
            if (json == null || json.equals("{}")) SaveMigration.markDone(this);
            updateManager.initialize(this::onUpdateManagerReady);
            hideSystemBars();
        });
    }

    private void onUpdateManagerReady() {
        if (isFinishing() || isDestroyed()) return;
        try {
            server = new LocalAssetServer(this, updateManager, migrationJson,
                    this::onMigrationDone, this::onFrameRateRequested);
            server.startServer();
        } catch (IOException error) {
            Log.e(TAG, "本地资源服务启动失败", error);
            showFatal(getString(R.string.local_server_failed_title),
                    getString(R.string.local_server_failed_message, LocalAssetServer.PORT));
            return;
        }
        createBrowser();
        hideSystemBars();
        if (updateManager.isBooting()) {
            showBootingDialog();
            startBootWatchdog();
        }
        if (!updateManager.repostPendingState()) updateManager.checkForUpdate();
    }

    private void onMigrationDone() {
        SaveMigration.markDone(this);
    }

    /**
     * 页面报来 30/60，壳选一个刷新率能整除它的显示模式。
     *
     * 30 选 60/90/120，60 选 60/120。选整数倍是为了让每个游戏帧
     * 占整数个屏幕节拍；60 帧跑在 90Hz 上会反复在 1 个和 2 个节拍之间跳。
     * 没有整数倍模式时退到不低于目标的最低模式，再没有就保持当前模式。
     */
    private void onFrameRateRequested(int rate) {
        if (rate != LocalAssetServer.FRAME_RATE_30
                && rate != LocalAssetServer.FRAME_RATE_60) return;
        requestedFrameRate = rate;
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        Display.Mode best = null;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() != current.getPhysicalWidth()
                    || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            double hz = mode.getRefreshRate();
            if (hz + 0.5 < rate) continue;
            double ratio = hz / rate;
            if (Math.abs(ratio - Math.rint(ratio)) > 0.02) continue;
            if (best == null || hz < best.getRefreshRate()) best = mode;
        }
        if (best == null) {
            for (Display.Mode mode : display.getSupportedModes()) {
                if (mode.getPhysicalWidth() != current.getPhysicalWidth()
                        || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
                if (mode.getRefreshRate() + 0.5 < rate) continue;
                if (best == null || mode.getRefreshRate() < best.getRefreshRate()) best = mode;
            }
        }
        if (best == null) best = current;
        WindowManager.LayoutParams attrs = getWindow().getAttributes();
        if (attrs.preferredDisplayModeId != best.getModeId()) {
            attrs.preferredDisplayModeId = best.getModeId();
            getWindow().setAttributes(attrs);
        }
        // Surface 只按玩家选的帧率向系统投票。实际显示刷新率可能更低（LTPO 会掉到 10Hz），
        // 但那是屏幕的当前状态，不能反过来限制应用；稍后只读出来通知页面。
        surfaceRateRetries = 0;
        applySurfaceFrameRate(rate);
        // 切换是异步的，而且 preferredDisplayModeId 只是建议；稍后读实际生效的值。
        mainHandler.removeCallbacks(applyDisplayRateTask);
        mainHandler.postDelayed(applyDisplayRateTask, DISPLAY_MODE_SETTLE_MS);
        Log.i(TAG, "frame-rate " + rate + " -> request " + best.getRefreshRate()
                + "Hz (mode " + best.getModeId() + "), surface " + rate + "Hz");
    }

    /**
     * 读取系统实际生效的刷新率，只用来通知页面换算限帧和写日志。
     *
     * 不能把这个值回设给 Surface：LTPO 屏空闲时会掉到 10Hz，拿 10Hz 去调用
     * setFrameRate 会让系统把整个应用按 10fps 限死。Surface 的请求保持在
     * {@link #requestedFrameRate}。
     */
    private void observeActualDisplayRate() {
        if (isFinishing() || isDestroyed()) return;
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode mode = display.getMode();
        float hz = mode != null ? mode.getRefreshRate() : display.getRefreshRate();
        if (hz <= 0) hz = display.getRefreshRate();
        actualDisplayRate = hz;
        // 页面用这个值判断 60 档要不要用 90 上限、30 档要不要交给 vsync；低于 20Hz 的瞬时值页面会忽略。
        notifyPageDisplayRate(hz);
        Log.i(TAG, "display-rate actual " + hz + "Hz (requested " + requestedFrameRate + "Hz)");
    }

    /** 把屏幕实际刷新率写进页面；页面据此在「60 档的 90 上限」「30 档跟随 vsync」和「按选项限帧」之间换算。 */
    private void notifyPageDisplayRate(float hz) {
        if (browser == null || hz <= 0) return;
        String script = "window.__inoitaDisplayHz=" + hz
                + ";window.dispatchEvent(new Event('inoita-display-rate'));";
        try {
            browser.evaluateJavaScript(script);
        } catch (RuntimeException error) {
            Log.w(TAG, "通知页面刷新率失败", error);
        }
    }

    /**
     * Android 11+ 把目标帧率告诉 SurfaceFlinger；Surface 还没建好时短暂重试。
     *
     * 传玩家选的 30/60。游戏要的是固定目标帧率，Android 游戏文档用 FIXED_SOURCE；
     * 关键是不能传屏幕瞬时的低刷新率（LTPO 会掉到 10Hz），那会把整个应用按 10fps 限死。
     */
    private void applySurfaceFrameRate(float hz) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || hz <= 0) return;
        if (isFinishing() || isDestroyed()) return;
        SurfaceView surfaceView = findSurfaceView(root);
        if (surfaceView == null) return;
        Surface surface = surfaceView.getHolder().getSurface();
        if (surface == null || !surface.isValid()) {
            if (surfaceRateRetries++ < SURFACE_RATE_MAX_RETRIES) {
                mainHandler.postDelayed(() -> applySurfaceFrameRate(hz), SURFACE_RATE_RETRY_MS);
            }
            return;
        }
        surfaceRateRetries = 0;
        try {
            surface.setFrameRate(hz, Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE);
        } catch (RuntimeException error) {
            Log.w(TAG, "设置 Surface 帧率失败", error);
        }
    }

    private static SurfaceView findSurfaceView(View view) {
        if (view instanceof SurfaceView) return (SurfaceView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                SurfaceView found = findSurfaceView(group.getChildAt(index));
                if (found != null) return found;
            }
        }
        return null;
    }

    private void createBrowser() {
        if (isFinishing() || isDestroyed() || server == null) return;
        pageReady = false;
        try {
            browser = CefriumBrowser.createWithSurface(this);
        } catch (Throwable error) {
            Log.e(TAG, "创建 CefriumBrowser 失败", error);
            CrashLog.append(this, CrashLog.CRASH_LOG_FILE,
                    "create-browser: " + Log.getStackTraceString(error));
            showFatal(getString(R.string.browser_init_failed_title), Log.getStackTraceString(error));
            return;
        }
        browser.getSurfaceContainer().setBackgroundColor(getColor(R.color.background));
        root.addView(browser.getSurfaceContainer(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        browser.setMediaPlaybackRequiresUserGesture(false);
        browser.setPinchToZoomEnabled(false);
        browser.setDarkMode(false);
        browser.setDialogActivity(this);
        browser.setCallback(new CefriumBrowser.Callback() {
            @Override
            public void onFullscreenChanged(boolean fullscreen) {
                hideSystemBars();
            }

            @Override
            public void onLoadingStateChanged(boolean loading, boolean canGoBack, boolean canGoForward) {
                if (!loading) {
                    pageReady = true;
                    if (actualDisplayRate > 0) notifyPageDisplayRate(actualDisplayRate);
                }
            }
        });
        browser.setOnRenderProcessTerminatedListener((code, reason) -> {
            // 等待新版本启动时由 UpdateManager 接管并回退；正常游玩只重建浏览器。
            if (updateManager.onRenderProcessGone()) return;
            root.post(this::recreateBrowser);
        });

        browser.loadUrl(server.baseUrl() + "/index.html?v=" + updateManager.currentBuildId());
    }

    private void recreateBrowser() {
        if (isFinishing() || isDestroyed()) return;
        pageReady = false;
        if (browser != null) {
            try {
                browser.close();
            } catch (RuntimeException ignored) {
                // 渲染进程已经退出时 close 可能失败；继续创建新实例。
            }
            browser = null;
        }
        root.removeAllViews();
        mainHandler.removeCallbacks(createBrowserTask);
        // 给 CEF 一点时间释放旧浏览器和渲染进程，再创建新实例。
        mainHandler.postDelayed(createBrowserTask, BROWSER_RECREATE_DELAY_MS);
    }

    private void showFatal(String title, String message) {
        if (isFinishing() || isDestroyed()) return;
        CrashLog.append(this, CrashLog.CRASH_LOG_FILE, "fatal " + title + ": " + message);
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .show();
    }

    private void reportUpdateEvent(String kind, String... keyValues) {
        Diagnostics.report(kind, keyValues);
    }

    // ---- 更新界面 ----

    @Override
    public void onUpdateAvailable(String buildId, int fileCount, long downloadBytes) {
        if (isFinishing() || isDestroyed()) return;
        reportUpdateEvent("update-available", "buildId", buildId,
                "files", String.valueOf(fileCount), "bytes", String.valueOf(downloadBytes));
        dismissCheckFailedDialog();
        dismissUpdateDialog();

        String megabytes = String.format(Locale.US, "%.1f",
                downloadBytes / (double) BYTES_PER_MEBIBYTE);
        updateDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.update_available_title)
                .setMessage(getString(R.string.update_available_message, megabytes, fileCount))
                .setPositiveButton(R.string.update_now, (dialog, which) -> {
                    updateDialog = null;
                    reportUpdateEvent("download-start", "buildId", buildId,
                            "files", String.valueOf(fileCount));
                    showDownloadDialog(fileCount);
                    updateManager.startDownload();
                })
                .setNegativeButton(R.string.update_later, (dialog, which) -> {
                    updateDialog = null;
                    reportUpdateEvent("update-deferred", "buildId", buildId);
                    updateManager.deferUpdate();
                    dialog.dismiss();
                })
                .create();
        updateDialog.show();
    }

    @Override
    public void onDownloadProgress(int completed, int total) {
        if (isFinishing() || isDestroyed()) return;
        if (downloadDialog == null) showDownloadDialog(Math.max(1, total));
        if (downloadDialog == null) return;
        downloadDialog.setMax(Math.max(1, total));
        downloadDialog.setProgress(Math.min(completed, total));
        downloadDialog.setMessage(getString(
                R.string.update_downloading_message, completed, total));
    }

    @Override
    public void onUpdateReady(String buildId) {
        if (isFinishing() || isDestroyed()) return;
        reportUpdateEvent("update-ready", "buildId", buildId);
        dismissUpdateDialog();
        new AlertDialog.Builder(this)
                .setTitle(R.string.update_ready_title)
                .setMessage(R.string.update_ready_message)
                .setPositiveButton(R.string.update_restart_now,
                        (dialog, which) -> updateManager.applyReadyUpdate())
                .setNegativeButton(R.string.update_later,
                        (dialog, which) -> updateManager.deferUpdate())
                .show();
    }

    @Override
    public void onUpdateApplied(String buildId) {
        reportUpdateEvent("update-applied", "buildId", buildId, "buildInfo", updateManager.buildInfoJson());
        dismissProgressDialog();
        recreateBrowser();
        showBootingDialog();
        startBootWatchdog();
    }

    @Override
    public void onUpdateFailed(String reason, boolean cancelled) {
        dismissProgressDialog();
        Log.w("InotiaUpdate", "更新未完成: " + reason + (cancelled ? "（已取消）" : ""));
        reportUpdateEvent("update-failed", "reason", reason == null ? "" : reason,
                "cancelled", String.valueOf(cancelled), "buildInfo", updateManager.buildInfoJson());
        if (cancelled || isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.update_failed_title)
                .setMessage(getString(R.string.update_failed_message, reason))
                .setPositiveButton(R.string.update_retry, (dialog, which) -> updateManager.retryAfterFailure())
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    @Override
    public void onRollbackComplete(String failedBuildId) {
        reportUpdateEvent("update-rollback", "failedBuildId", failedBuildId,
                "buildInfo", updateManager.buildInfoJson());
        stopBootWatchdog();
        dismissBootingDialog();
        recreateBrowser();
        if (!isFinishing() && !isDestroyed()) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.update_rollback_title)
                    .setMessage(R.string.update_rollback_message)
                    .setPositiveButton(R.string.update_retry, (dialog, which) -> updateManager.retryUpdate())
                    .setNegativeButton(R.string.update_later, null)
                    .show();
        }
    }

    @Override
    public void onBootCommitted() {
        reportUpdateEvent("update-boot-ok", "buildInfo", updateManager.buildInfoJson());
        stopBootWatchdog();
        dismissBootingDialog();
    }

    @Override
    public void onUpdateCheckStart() {
        reportUpdateEvent("update-check-start", "buildInfo", updateManager.buildInfoJson());
    }

    @Override
    public void onUpdateCheckResult(String result, String error) {
        reportUpdateEvent("update-check", "result", result == null ? "" : result,
                "error", error == null ? "" : error, "buildInfo", updateManager.buildInfoJson());
    }

    @Override
    public void onUpdateCheckFailed(String reason) {
        if (isFinishing() || isDestroyed()) return;
        Log.w("InotiaUpdate", "检查更新失败: " + reason);
        if (checkFailedDialog != null && checkFailedDialog.isShowing()) return;
        checkFailedDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.update_check_failed_title)
                .setMessage(R.string.update_check_failed_message)
                .setPositiveButton(R.string.update_retry, (dialog, which) -> {
                    checkFailedDialog = null;
                    updateManager.retryUpdate();
                })
                .setNegativeButton(R.string.update_later,
                        (dialog, which) -> checkFailedDialog = null)
                .create();
        checkFailedDialog.show();
    }

    private void showDownloadDialog(int fileCount) {
        if (isFinishing() || isDestroyed()) return;
        dismissProgressDialog();
        downloadDialog = new ProgressDialog(this);
        downloadDialog.setTitle(R.string.update_downloading_title);
        downloadDialog.setMessage(getString(R.string.update_downloading_message, 0, fileCount));
        downloadDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        downloadDialog.setMax(Math.max(1, fileCount));
        downloadDialog.setProgress(0);
        downloadDialog.setCancelable(true);
        downloadDialog.setCanceledOnTouchOutside(false);
        downloadDialog.setOnCancelListener(dialog -> updateManager.cancelDownload());
        downloadDialog.show();
    }

    private void showBootingDialog() {
        if (isFinishing() || isDestroyed()) return;
        dismissBootingDialog();
        bootingDialog = new AlertDialog.Builder(this)
                .setMessage(R.string.update_booting)
                .setCancelable(false)
                .create();
        bootingDialog.show();
    }

    private void startBootWatchdog() {
        mainHandler.removeCallbacks(bootWatchdog);
        mainHandler.postDelayed(bootWatchdog, BOOT_TIMEOUT_MS);
    }

    private void stopBootWatchdog() {
        mainHandler.removeCallbacks(bootWatchdog);
    }

    private void onBootWatchdog() {
        if (updateManager != null && updateManager.isBooting()) updateManager.onBootTimeout();
    }

    private void dismissUpdateDialog() {
        if (updateDialog != null) {
            updateDialog.dismiss();
            updateDialog = null;
        }
    }

    private void dismissCheckFailedDialog() {
        if (checkFailedDialog != null) {
            checkFailedDialog.dismiss();
            checkFailedDialog = null;
        }
    }

    private void dismissProgressDialog() {
        if (downloadDialog != null) {
            downloadDialog.dismiss();
            downloadDialog = null;
        }
    }

    private void dismissBootingDialog() {
        if (bootingDialog != null) {
            bootingDialog.dismiss();
            bootingDialog = null;
        }
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
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onPause() {
        if (browser != null) {
            // 先让页面跑完 pagehide（暂停场景、音频并落一次自动存档），再冻结浏览器。
            if (pageReady) browser.evaluateJavaScript("window.dispatchEvent(new Event('pagehide'));");
            mainHandler.removeCallbacks(pauseBrowserTask);
            mainHandler.postDelayed(pauseBrowserTask, PAGE_HIDE_SETTLE_MS);
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        mainHandler.removeCallbacks(pauseBrowserTask);
        if (browser != null) {
            browser.onResume();
            if (pageReady) browser.evaluateJavaScript("window.dispatchEvent(new Event('pageshow'));");
        }
        if (requestedFrameRate > 0) {
            surfaceRateRetries = 0;
            applySurfaceFrameRate(requestedFrameRate);
        }
        hideSystemBars();
        if (updateManager != null) updateManager.checkForUpdateOnForeground();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (browser != null && pageReady) browser.evaluateJavaScript(ESCAPE_SCRIPT);

        long now = SystemClock.uptimeMillis();
        if (now - lastBackPressed <= DOUBLE_BACK_MS) {
            lastBackPressed = 0;
            confirmExit();
        } else {
            lastBackPressed = now;
        }
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .setNegativeButton(R.string.exit_cancel, null)
                .show();
    }

    @Override
    protected void onDestroy() {
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        mainHandler.removeCallbacks(bootWatchdog);
        mainHandler.removeCallbacks(createBrowserTask);
        mainHandler.removeCallbacks(pauseBrowserTask);
        mainHandler.removeCallbacks(applyDisplayRateTask);
        dismissUpdateDialog();
        dismissCheckFailedDialog();
        dismissProgressDialog();
        dismissBootingDialog();
        if (browser != null) {
            try {
                browser.close();
            } catch (RuntimeException ignored) {
                // 进程退出阶段关闭失败不需要影响清理。
            }
            browser = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
        if (updateManager != null) {
            updateManager.clearListener(this);
            updateManager.cancelDownload();
        }
        super.onDestroy();
    }
}
