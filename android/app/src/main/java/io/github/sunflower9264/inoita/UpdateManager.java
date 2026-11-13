package io.github.sunflower9264.inoita;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 进程级更新管理器：启动时解析当前版本清单，后台检查更新，必要时下载并切换版本。
 *
 * 线程约定：
 * - initialize/检查/下载/落盘都在后台线程，UI 回调统一切回主线程；
 * - 路径快照只在初始化或切换版本后整体替换，PathHandler 读到的永远是同一份不可变对象；
 * - pendingBoot 只在「刚切换到新版本、还没收到 markBootOk」时为真，回退只在这个窗口发生。
 */
final class UpdateManager {

    interface Listener {
        void onUpdateAvailable(String buildId, int fileCount, long downloadBytes);

        void onUpdateCheckStart();

        void onUpdateCheckResult(String result, String error);

        /** 自动重试已经用尽，玩家需要看到失败并有机会手动重试。 */
        void onUpdateCheckFailed(String reason);

        void onDownloadProgress(int completed, int total);

        void onUpdateApplied(String buildId);

        void onUpdateFailed(String reason, boolean cancelled);

        void onUpdateReady(String buildId);

        void onRollbackComplete(String failedBuildId);

        void onBootCommitted();
    }

    /** WebView 的 IO 线程只读这份不可变快照，不碰任何可变状态。 */
    static final class Snapshot {
        private final String buildId;
        private final boolean authoritative;
        private final Set<String> paths;
        private final Map<String, File> files;
        private final File buildRoot;

        private Snapshot(String buildId, boolean authoritative, Set<String> paths,
                         Map<String, File> files, File buildRoot) {
            this.buildId = buildId;
            this.authoritative = authoritative;
            this.paths = paths;
            this.files = files;
            this.buildRoot = buildRoot;
        }

        static Snapshot apkOnly(String buildId) {
            return new Snapshot(buildId, false,
                    Collections.emptySet(), Collections.emptyMap(), null);
        }

        static Snapshot build(String buildId, UpdateManifest.Manifest manifest, File root) {
            if (manifest == null) return apkOnly(buildId);

            Set<String> paths = new HashSet<>(manifest.files.size() * 2);
            Map<String, File> files = new HashMap<>();
            String rootCanonical = null;
            if (root != null) {
                try {
                    rootCanonical = root.getCanonicalPath();
                } catch (IOException error) {
                    rootCanonical = null;
                }
            }

            for (UpdateManifest.FileEntry entry : manifest.files) {
                paths.add(entry.path);
                if (root == null || rootCanonical == null) continue;
                File file = new File(root, entry.path);
                if (!file.isFile()) continue;
                try {
                    String canonical = file.getCanonicalPath();
                    if (canonical.startsWith(rootCanonical + File.separator)) {
                        files.put(entry.path, file);
                    }
                } catch (IOException ignored) {
                    // 读不到路径就当作没有本地文件，由 AssetsPathHandler 兜底。
                }
            }

            return new Snapshot(buildId, true,
                    Collections.unmodifiableSet(paths),
                    Collections.unmodifiableMap(files), root);
        }

        String buildId() {
            return buildId;
        }

        boolean isAuthoritative() {
            return authoritative;
        }

        Set<String> paths() {
            return paths;
        }

        Map<String, File> files() {
            return files;
        }

        File buildRoot() {
            return buildRoot;
        }
    }

    private static final class Candidate {
        final UpdateManifest.Pointer pointer;
        final UpdateManifest.Manifest manifest;
        final UpdateInstaller.Plan plan;

        Candidate(UpdateManifest.Pointer pointer, UpdateManifest.Manifest manifest,
                  UpdateInstaller.Plan plan) {
            this.pointer = pointer;
            this.manifest = manifest;
            this.plan = plan;
        }
    }

    private static final String TAG = "InotiaUpdate";
    /** 没有可用热更版本时的内建版本标识；更新检查和诊断都按它识别 APK 资源。 */
    private static final String APK_BUILD_ID = "apk";
    private static final String POINTER_PATH = "update/latest.json";
    private static final String STAGING_POINTER_PATH = "update/latest-staging.json";
    private static final String SIGNATURE_SUFFIX = ".sig";
    private static final int DOWNLOAD_THREADS = 3;
    private static final long CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long CHECK_RETRY_MS = 30L * 1000L;
    private static final int CHECK_MAX_RETRIES = 3;
    private static final long FAILED_BUILD_COOLDOWN_MS = 24L * 60L * 60L * 1000L;
    private static volatile UpdateManager instance;

    static UpdateManager get(Context context) {
        UpdateManager current = instance;
        if (current == null) {
            synchronized (UpdateManager.class) {
                current = instance;
                if (current == null) {
                    current = new UpdateManager(context.getApplicationContext());
                    instance = current;
                }
            }
        }
        return current;
    }

    private final Context context;
    private final UpdateState state;
    private final UpdateInstaller installer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean checking = new AtomicBoolean(false);
    private final AtomicBoolean retryScheduled = new AtomicBoolean(false);
    private final AtomicInteger checkFailures = new AtomicInteger(0);
    private final AtomicBoolean checkFailureNotified = new AtomicBoolean(false);
    private final AtomicBoolean applying = new AtomicBoolean(false);

    private volatile Snapshot snapshot = Snapshot.apkOnly(APK_BUILD_ID);
    private volatile UpdateManifest.Pointer baselinePointer;
    private volatile UpdateManifest.Manifest baselineManifest;
    private volatile UpdateManifest.Manifest activeManifest;
    private volatile String installedBuiltAt = "";
    private volatile Listener listener;
    private volatile Candidate candidate;
    private volatile String deferredBuildId = "";

    private final Object initLock = new Object();
    private boolean initialized;
    private boolean initializing;
    private final List<Runnable> initCallbacks = new ArrayList<>();

    private final Object downloadLock = new Object();
    private boolean downloading;
    private volatile boolean downloadCancelled;
    private volatile int downloadCompleted;
    private volatile int downloadTotal;

    private final Object bootLock = new Object();
    private boolean pendingBoot;
    private boolean bootOk;
    private boolean bootFailureHandled;
    private String pendingBuildId = "";

    private UpdateManager(Context context) {
        this.context = context;
        this.state = new UpdateState(context);
        this.installer = new UpdateInstaller(state);
    }

    /** 读完当前版本清单、发布不可变快照后才回调，回调在主线程。 */
    void initialize(Runnable onReady) {
        synchronized (initLock) {
            if (initialized) {
                mainHandler.post(onReady);
                return;
            }
            initCallbacks.add(onReady);
            if (initializing) return;
            initializing = true;
        }

        worker.execute(() -> {
            // 先读当前版本，拿到已安装版本的 builtAt；再决定要不要应用上次下载好的版本。
            try {
                loadSnapshot();
            } catch (Exception error) {
                Log.w(TAG, "初始化版本快照失败，降级为 APK 资源", error);
                // 构建期写入的版本号同样可信；不能用 "apk" 覆盖，否则更新检查
                // 会把自带完整网页的安装包当成未知版本，反复提示全量下载。
                snapshot = Snapshot.apkOnly(fallbackBuildId());
                installedBuiltAt = BuildConfig.BASELINE_BUILT_AT;
                Diagnostics.report("update-init-error", "message", describeError(error));
            }
            try {
                if (applyReadyBlocking()) loadSnapshot();
            } catch (Exception error) {
                Log.w(TAG, "应用已就绪更新失败，继续使用当前版本", error);
                state.clearReady();
            }

            List<Runnable> callbacks;
            synchronized (initLock) {
                initialized = true;
                initializing = false;
                callbacks = new ArrayList<>(initCallbacks);
                initCallbacks.clear();
            }
            mainHandler.post(() -> {
                for (Runnable callback : callbacks) callback.run();
            });
        });
    }

    Snapshot snapshot() {
        return snapshot;
    }

    String currentBuildId() {
        return snapshot.buildId();
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    void clearListener(Listener listener) {
        if (this.listener == listener) this.listener = null;
    }

    /** 冷启动检查：不受上次检查间隔限制，但同一时间只允许一个检查。 */
    void checkForUpdate() {
        requestCheck(true);
    }

    /** 回到前台时检查：距离上次检查超过 6 小时才发起，避免频繁请求。 */
    void checkForUpdateOnForeground() {
        if (BuildConfig.DEBUG || BuildConfig.UPDATE_PUBLIC_KEY.isEmpty()) return;
        if (candidate != null || !state.readyBuildId().isEmpty()) return;
        if (System.currentTimeMillis() - state.lastCheckAt() < CHECK_INTERVAL_MS) return;
        requestCheck(false);
    }

    private void requestCheck(boolean force) {
        if (BuildConfig.DEBUG) {
            Log.i(TAG, "debug 包跳过热更检查");
            return;
        }
        if (BuildConfig.UPDATE_PUBLIC_KEY.isEmpty()) {
            Log.w(TAG, "缺少更新公钥，跳过热更检查");
            return;
        }
        synchronized (initLock) {
            // 初始化还没读完当前版本时不能检查：快照仍是默认的 "apk"，
            // 会把自带完整网页的安装包误判成需要全量更新。
            if (!initialized) return;
        }
        if (!force && System.currentTimeMillis() - state.lastCheckAt() < CHECK_INTERVAL_MS) return;
        if (!checking.compareAndSet(false, true)) return;
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onUpdateCheckStart();
        });
        worker.execute(this::runUpdateCheck);
    }

    private void scheduleCheckRetry() {
        if (!retryScheduled.compareAndSet(false, true)) return;
        mainHandler.postDelayed(() -> {
            retryScheduled.set(false);
            requestCheck(true);
        }, CHECK_RETRY_MS);
    }

    private void runUpdateCheck() {
        try {
            String pointerPath = "staging".equals(BuildConfig.UPDATE_CHANNEL)
                    ? "/" + STAGING_POINTER_PATH
                    : "/" + POINTER_PATH;
            UpdateHttp http = new UpdateHttp(BuildConfig.UPDATE_BASE_URL);

            // 指针本身也要验签：否则旧指针可以被重放。
            byte[] pointerBytes = http.fetchPointer(pointerPath);
            byte[] pointerSignature = http.fetchSignature(pointerPath + SIGNATURE_SUFFIX);
            if (!UpdateManifest.verifySignature(
                    pointerBytes, pointerSignature, BuildConfig.UPDATE_PUBLIC_KEY)) {
                state.setLastCheck(UpdateState.CHECK_RESULT_ERROR, "指针签名校验失败");
                Log.w(TAG, "指针签名校验失败");
                scheduleCheckRetry();
                return;
            }
            UpdateManifest.Pointer pointer = UpdateManifest.parsePointer(pointerBytes);

            if (pointer.buildId.equals(snapshot.buildId())) {
                state.setLastCheck(UpdateState.CHECK_RESULT_NONE, "already-current");
                state.clearAvailable();
                state.clearDownloadError();
                checkFailures.set(0);
                return;
            }
            String failed = state.failedBuildId();
            if (pointer.buildId.equals(failed)) {
                long failedAt = state.failedAt();
                if (failedAt <= 0L || System.currentTimeMillis() - failedAt < FAILED_BUILD_COOLDOWN_MS) {
                    Log.i(TAG, "该版本启动失败冷却中: " + pointer.buildId);
                    state.setLastCheck(UpdateState.CHECK_RESULT_BLOCKED, "failed-build");
                    checkFailures.set(0);
                    return;
                }
                state.clearFailedBuildId();
            }
            if (pointer.minShell > BuildConfig.SHELL_VERSION) {
                Log.i(TAG, "新版本需要更高的壳版本: minShell=" + pointer.minShell);
                state.setLastCheck(UpdateState.CHECK_RESULT_NONE, "min-shell");
                state.clearAvailable();
                state.clearDownloadError();
                checkFailures.set(0);
                return;
            }
            long installed = UpdateState.parseMillis(installedBuiltAt);
            if (installed != Long.MIN_VALUE && pointer.builtAtMillis <= installed) {
                Log.i(TAG, "更新指针不比已安装版本新");
                state.setLastCheck(UpdateState.CHECK_RESULT_NONE, "not-newer");
                state.clearAvailable();
                state.clearDownloadError();
                checkFailures.set(0);
                return;
            }

            // 清单先验原始字节的 SHA-256，再验签名和 buildId。
            byte[] manifestBytes = http.fetchManifest("/" + pointer.manifest);
            if (!pointer.manifestSha256.equals(UpdateManifest.sha256Hex(manifestBytes))) {
                state.setLastCheck(UpdateState.CHECK_RESULT_ERROR, "清单哈希与指针不一致");
                Log.w(TAG, "清单哈希与指针不一致");
                scheduleCheckRetry();
                return;
            }
            UpdateManifest.Manifest manifest = UpdateManifest.parseManifest(manifestBytes);
            if (!manifest.buildId.equals(pointer.buildId)) {
                state.setLastCheck(UpdateState.CHECK_RESULT_ERROR, "清单 buildId 与指针不一致");
                Log.w(TAG, "清单 buildId 与指针不一致");
                scheduleCheckRetry();
                return;
            }
            byte[] manifestSignature =
                    http.fetchSignature("/" + pointer.manifest + SIGNATURE_SUFFIX);
            if (!UpdateManifest.verifySignature(
                    manifestBytes, manifestSignature, BuildConfig.UPDATE_PUBLIC_KEY)) {
                state.setLastCheck(UpdateState.CHECK_RESULT_ERROR, "清单签名校验失败");
                Log.w(TAG, "清单签名校验失败");
                scheduleCheckRetry();
                return;
            }

            UpdateInstaller.Plan plan = installer.prepare(
                    manifest, baselineManifest, activeManifest,
                    manifestBytes, pointer.builtAt);

            candidate = new Candidate(pointer, manifest, plan);
            retryScheduled.set(false);
            checkFailures.set(0);
            deferredBuildId = "";
            int fileCount = plan.downloadCount();
            long bytes = plan.downloadBytes;
            state.setLastCheck(UpdateState.CHECK_RESULT_AVAILABLE, "");
            state.setAvailable(pointer.buildId, fileCount, bytes);
            state.clearDownloadError();
            String buildId = pointer.buildId;
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateAvailable(buildId, fileCount, bytes);
            });
        } catch (Exception error) {
            String message = describe(error);
            Log.w(TAG, "检查更新失败: " + message);
            state.setLastCheck(UpdateState.CHECK_RESULT_ERROR, message);
            int failures = checkFailures.incrementAndGet();
            if (failures <= CHECK_MAX_RETRIES) {
                scheduleCheckRetry();
            } else if (checkFailureNotified.compareAndSet(false, true)) {
                // 自动重试已经用尽，不再沉默：让玩家看到失败并可以手动重试。
                postToMain(() -> {
                    Listener current = listener;
                    if (current != null) current.onUpdateCheckFailed(message);
                });
            }
        } finally {
            checking.set(false);
            String result = state.lastCheckResult();
            if (!UpdateState.CHECK_RESULT_ERROR.equals(result)) checkFailureNotified.set(false);
            String error = state.lastCheckError();
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateCheckResult(result, error);
            });
        }
    }

    /** 把异常链里最有用的几层拼成一行，诊断能看到外层描述和系统错误号。 */
    private static String describe(Throwable error) {
        StringBuilder text = new StringBuilder();
        Throwable current = error;
        for (int depth = 0; current != null && depth < 3; depth += 1) {
            if (text.length() > 0) text.append(" <- ");
            text.append(current.getClass().getSimpleName());
            String detail = current.getMessage();
            if (detail != null && !detail.isEmpty()) text.append(' ').append(detail);
            current = current.getCause();
        }
        return text.toString();
    }

    /** 玩家点了「立即更新」：后台开 3 个线程下载，全部成功后切换版本。 */
    void startDownload() {
        Candidate ready = candidate;
        if (ready == null) return;
        synchronized (downloadLock) {
            if (downloading) return;
            downloading = true;
            downloadCancelled = false;
            downloadCompleted = 0;
            downloadTotal = ready.plan.downloadCount();
        }
        state.clearDownloadError();
        worker.execute(() -> runDownload(ready));
    }

    boolean isDownloading() {
        synchronized (downloadLock) {
            return downloading;
        }
    }

    int downloadCompleted() {
        return downloadCompleted;
    }

    int downloadTotal() {
        return downloadTotal;
    }

    /**
     * Activity 重建或回到前台后，按持久状态把还没处理的更新重新呈现给玩家。
     * 返回 true 表示当前确实有一个待处理的更新（即使玩家之前点了「稍后」）。
     */
    boolean repostPendingState() {
        String readyBuildId = state.readyBuildId();
        if (!readyBuildId.isEmpty()) {
            if (readyBuildId.equals(deferredBuildId)) return true;
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateReady(readyBuildId);
            });
            return true;
        }
        Candidate ready = candidate;
        if (ready == null) return false;
        if (isBooting()) return true;
        if (isDownloading()) {
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onDownloadProgress(downloadCompleted, downloadTotal);
            });
            return true;
        }
        String error = state.downloadError();
        if (!error.isEmpty()) {
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateFailed(error, false);
            });
            return true;
        }
        if (ready.manifest.buildId.equals(deferredBuildId)) return true;
        int fileCount = ready.plan.downloadCount();
        long bytes = ready.plan.downloadBytes;
        String buildId = ready.manifest.buildId;
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onUpdateAvailable(buildId, fileCount, bytes);
        });
        return true;
    }

    /** 玩家点了「稍后」：本进程内不再重复弹，下次冷启动会重新检查。 */
    void deferUpdate() {
        Candidate ready = candidate;
        deferredBuildId = ready == null ? state.readyBuildId() : ready.manifest.buildId;
    }

    /** 失败提示里的「重试」：下载失败就续传，检查失败就重新检查。 */
    void retryAfterFailure() {
        if (candidate != null) {
            startDownload();
            return;
        }
        retryUpdate();
    }

    /** 玩家在失败提示里点「重试」：清掉失败黑名单并立刻重新检查。 */
    void retryUpdate() {
        state.clearFailedBuildId();
        state.clearDownloadError();
        candidate = null;
        deferredBuildId = "";
        checkFailures.set(0);
        checkFailureNotified.set(false);
        requestCheck(true);
    }

    void cancelDownload() {
        synchronized (downloadLock) {
            if (!downloading) return;
            downloadCancelled = true;
        }
    }

    private void runDownload(Candidate ready) {
        try {
            installer.requireSpace(ready.plan);
        } catch (Exception error) {
            finishDownload();
            notifyFailed(error.getMessage(), false);
            return;
        }

        List<UpdateManifest.FileEntry> downloads = ready.plan.downloads;
        int total = downloads.size();
        if (total == 0) {
            markReady(ready);
            return;
        }

        UpdateHttp http;
        try {
            http = new UpdateHttp(BuildConfig.UPDATE_BASE_URL);
        } catch (Exception error) {
            finishDownload();
            notifyFailed(error.getMessage(), false);
            return;
        }

        ExecutorService pool = Executors.newFixedThreadPool(DOWNLOAD_THREADS);
        CountDownLatch latch = new CountDownLatch(DOWNLOAD_THREADS);
        AtomicInteger next = new AtomicInteger(0);
        AtomicInteger completed = new AtomicInteger(0);
        AtomicBoolean failed = new AtomicBoolean(false);
        AtomicReference<String> failure = new AtomicReference<>("下载失败");

        Runnable task = () -> {
            try {
                while (!downloadCancelled && !failed.get()) {
                    int index = next.getAndIncrement();
                    if (index >= downloads.size()) return;
                    UpdateManifest.FileEntry entry = downloads.get(index);
                    try {
                        installer.downloadEntry(ready.plan, entry, http,
                                () -> downloadCancelled);
                        int done = completed.incrementAndGet();
                        downloadCompleted = done;
                        postToMain(() -> {
                            Listener current = listener;
                            if (current != null) current.onDownloadProgress(done, total);
                        });
                    } catch (Exception error) {
                        if (!downloadCancelled) {
                            failure.compareAndSet("下载失败", error.getMessage());
                            failed.set(true);
                        }
                        return;
                    }
                }
            } finally {
                latch.countDown();
            }
        };
        for (int index = 0; index < DOWNLOAD_THREADS; index++) pool.execute(task);

        try {
            latch.await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            failed.set(true);
        } finally {
            pool.shutdownNow();
        }

        if (downloadCancelled) {
            finishDownload();
            Log.i(TAG, "下载已取消，保留 staging 供下次续传");
            notifyFailed("cancelled", true);
            return;
        }
        if (failed.get()) {
            finishDownload();
            state.setDownloadError(failure.get());
            notifyFailed(failure.get(), false);
            return;
        }
        markReady(ready);
    }

    /** 下载完成：保留 staging，等玩家确认重启或下次冷启动再切换 active。 */
    private void markReady(Candidate ready) {
        candidate = null;
        state.clearAvailable();
        state.clearDownloadError();
        state.setReady(ready.manifest.buildId);
        finishDownload();
        String buildId = ready.manifest.buildId;
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onUpdateReady(buildId);
        });
    }

    /**
     * 把已就绪的 staging 目录切换成 active。必须在 worker 线程调用。
     * 返回 false 表示当前没有待应用的版本。
     */
    private boolean applyReadyBlocking() throws IOException {
        String buildId = state.readyBuildId();
        if (buildId.isEmpty()) return false;
        File staging = state.stagingDir(buildId);
        File manifestFile = state.manifestCopy(staging);
        File builtAtFile = state.builtAtCopy(staging);
        if (!manifestFile.isFile() || !builtAtFile.isFile()) {
            throw new IOException("已就绪版本缺少清单或构建时间");
        }
        UpdateManifest.Manifest manifest = UpdateManifest.parseManifest(readFile(manifestFile));
        if (!manifest.buildId.equals(buildId)) throw new IOException("已就绪版本 buildId 不一致");
        String builtAt = new String(readFile(builtAtFile), java.nio.charset.StandardCharsets.UTF_8).trim();
        long readyAt = UpdateState.parseMillis(builtAt);
        long installed = UpdateState.parseMillis(installedBuiltAt);
        // 安装新 APK 后，旧的 ready 可能比 APK 基线还旧；不能把网页降级回去。
        if (buildId.equals(snapshot.buildId()) || (installed != Long.MIN_VALUE && readyAt <= installed)) {
            state.clearReady();
            Log.i(TAG, "已就绪版本不比当前版本新，丢弃: " + buildId);
            return false;
        }
        UpdateInstaller.Plan plan = new UpdateInstaller.Plan(
                buildId, manifest, java.util.Collections.emptyList(), 0L, staging);
        state.setPendingBoot(buildId, System.currentTimeMillis());
        installer.complete(plan, builtAt, BuildConfig.UPDATE_CHANNEL);
        state.clearReady();
        synchronized (bootLock) {
            pendingBoot = true;
            bootOk = false;
            bootFailureHandled = false;
            pendingBuildId = buildId;
        }
        return true;
    }

    /** 玩家点了「立即重启」：把已下载版本切换过去并重建 WebView。 */
    void applyReadyUpdate() {
        if (!applying.compareAndSet(false, true)) return;
        worker.execute(() -> {
            try {
                if (!applyReadyBlocking()) return;
                loadSnapshot();
                String buildId = snapshot.buildId();
                postToMain(() -> {
                    Listener current = listener;
                    if (current != null) current.onUpdateApplied(buildId);
                });
            } catch (Exception error) {
                Log.w(TAG, "应用已就绪更新失败", error);
                state.clearReady();
                notifyFailed("切换版本失败：" + error.getMessage(), false);
            } finally {
                applying.set(false);
            }
        });
    }

    boolean hasReadyUpdate() {
        return !state.readyBuildId().isEmpty();
    }

    private void finishDownload() {
        synchronized (downloadLock) {
            downloading = false;
            downloadCancelled = false;
        }
    }

    private void notifyFailed(String reason, boolean cancelled) {
        Log.w(TAG, "更新未完成: " + reason);
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onUpdateFailed(reason, cancelled);
        });
    }

    /** 网页标题页加载完成后调用；收到后本次启动就算提交，不再回退。 */
    void markBootOk() {
        final String buildId;
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return;
            bootOk = true;
            pendingBoot = false;
            buildId = pendingBuildId;
        }
        long started = state.pendingBootStartedAt();
        if (started > 0L) state.setLastBootDuration(System.currentTimeMillis() - started);
        state.clearPendingBoot();
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onBootCommitted();
        });

        // 清理旧版本目录是磁盘操作，不能占用调用 markBootOk 的 JS 线程。
        worker.execute(() -> {
            String previous = state.previous();
            state.clearPrevious();
            if (!previous.isEmpty() && !previous.equals(buildId)) {
                UpdateState.deleteRecursively(state.buildDir(previous));
                UpdateState.deleteRecursively(state.stagingDir(previous));
            }
        });
    }

    boolean isBooting() {
        synchronized (bootLock) {
            return pendingBoot && !bootOk && !bootFailureHandled;
        }
    }

    /**
     * 渲染进程崩溃时的边界：只有「等待新版本启动完成」期间才回退；正常游玩时
     * 返回 false，由 Activity 只重建 WebView。
     */
    boolean onRenderProcessGone() {
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return false;
            bootFailureHandled = true;
            pendingBoot = false;
        }
        worker.execute(() -> rollback("render-process"));
        return true;
    }

    void onBootTimeout() {
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return;
            bootFailureHandled = true;
            pendingBoot = false;
        }
        worker.execute(() -> rollback("timeout"));
    }

    private void rollback(String reason) {
        final String failed;
        synchronized (bootLock) {
            failed = pendingBuildId;
        }
        Log.w(TAG, "新版本启动失败(" + reason + ")，回退: " + failed);

        state.clearPendingBoot();
        try {
            String previous = state.previous();
            boolean usable = state.isUsable(previous);
            if (usable) {
                String previousBuiltAt = state.readBuiltAt(previous);
                state.rollbackTo(previous);
                if (!previousBuiltAt.isEmpty()) {
                    state.commitActive(previous, "", previousBuiltAt, state.activeChannel());
                }
            } else {
                state.clearActive();
            }

            if (!failed.isEmpty() && !failed.equals(previous)) {
                state.setFailedBuildId(failed);
                UpdateState.deleteRecursively(state.buildDir(failed));
                UpdateState.deleteRecursively(state.stagingDir(failed));
            } else if (!failed.isEmpty()) {
                state.setFailedBuildId(failed);
            }

            loadSnapshot();
            state.cleanupBuilds(state.active(), state.previous());
        } catch (Exception error) {
            Log.e(TAG, "回退时磁盘操作失败", error);
        }

        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onRollbackComplete(failed);
        });
    }

    /** 不碰磁盘，只读内存状态；给 InotiaNative.buildInfo() 用。 */
    String buildInfoJson() {
        try {
            JSONObject json = new JSONObject();
            json.put("version", 1);
            json.put("shellVersion", BuildConfig.SHELL_VERSION);
            json.put("versionCode", BuildConfig.VERSION_CODE);
            json.put("channel", BuildConfig.UPDATE_CHANNEL);
            json.put("buildId", snapshot.buildId());
            json.put("active", state.active());
            json.put("previous", state.previous());
            json.put("failedBuildId", state.failedBuildId());
            json.put("builtAt", installedBuiltAt);
            json.put("pendingBoot", isBooting());
            json.put("lastBootMs", state.lastBootDuration());
            json.put("lastCheckAt", state.lastCheckAt());
            json.put("lastCheckResult", state.lastCheckResult());
            json.put("lastCheckError", state.lastCheckError());
            json.put("availableBuildId", state.availableBuildId());
            json.put("readyBuildId", state.readyBuildId());
            json.put("availableFiles", state.availableFileCount());
            json.put("availableBytes", state.availableBytes());
            json.put("failedAt", state.failedAt());
            json.put("downloadError", state.downloadError());
            return json.toString();
        } catch (JSONException error) {
            return "{}";
        }
    }

    /**
     * 读当前版本清单并发布快照。active 不完整时回 APK 基线；基线也读不出来时
     * 标记为不可信快照，PathHandler 会全部交给 AssetsPathHandler。
     */
    private void loadSnapshot() {
        // 先给出构建期身份：后面读状态、读清单任何一步失败，也不会退回 "apk"。
        if (!BuildConfig.BASELINE_BUILD_ID.isEmpty()) {
            snapshot = Snapshot.apkOnly(BuildConfig.BASELINE_BUILD_ID);
            installedBuiltAt = BuildConfig.BASELINE_BUILT_AT;
        }
        try {
            state.ensureDirs();
        } catch (IOException error) {
            Log.w(TAG, "更新目录初始化失败", error);
        }

        UpdateManifest.Pointer basePointer = null;
        UpdateManifest.Manifest baseManifest = null;
        String baselineError = "";
        try {
            byte[] latest = readAsset(POINTER_PATH);
            if (latest == null) {
                baselineError = POINTER_PATH + " 不存在";
            } else {
                UpdateManifest.Pointer pointer = UpdateManifest.parsePointer(latest);
                byte[] manifestBytes = readAsset(pointer.manifest);
                if (manifestBytes == null) {
                    baselineError = "基线清单不存在: " + pointer.manifest;
                } else {
                    UpdateManifest.Manifest manifest =
                            UpdateManifest.parseManifest(manifestBytes);
                    if (manifest.buildId.equals(pointer.buildId)) {
                        basePointer = pointer;
                        baseManifest = manifest;
                    } else {
                        baselineError = "基线清单 buildId 与指针不一致";
                        Log.w(TAG, "APK 基线清单 buildId 与指针不一致");
                    }
                }
            }
        } catch (Exception error) {
            baselineError = error.getClass().getSimpleName()
                    + (error.getMessage() == null ? "" : ": " + error.getMessage());
            Log.w(TAG, "读取 APK 基线失败", error);
        }
        baselinePointer = basePointer;
        baselineManifest = baseManifest;
        if (baseManifest == null && !BuildConfig.BASELINE_BUILD_ID.isEmpty()) {
            // 构建期已经把基线版本写进 BuildConfig；清单读不出来时仍要认得出自己，
            // 否则更新检查会把自带完整网页的安装包当成未知版本，反复提示全量下载。
            Diagnostics.report("baseline-error", "message",
                    baselineError.isEmpty() ? "APK 基线清单不可读" : baselineError);
        }

        String activeId = state.active();
        if (!activeId.isEmpty() && !state.isUsable(activeId)) {
            Log.w(TAG, "本地 active 不完整，回到 APK 资源: " + activeId);
            state.clearActive();
            activeId = "";
        }
        if (!activeId.isEmpty() && basePointer != null) {
            state.discardActiveIfBaselineNewer(basePointer.builtAtMillis);
            activeId = state.active();
        }

        UpdateManifest.Manifest chosen = null;
        UpdateManifest.Manifest chosenActive = null;
        File root = null;
        String buildId = APK_BUILD_ID;
        String builtAt = "";

        if (!activeId.isEmpty()) {
            try {
                byte[] manifestBytes = readFile(state.manifestCopy(activeId));
                UpdateManifest.Manifest manifest =
                        UpdateManifest.parseManifest(manifestBytes);
                if (!manifest.buildId.equals(activeId)) {
                    throw new IOException("active 清单 buildId 不一致");
                }
                chosen = manifest;
                chosenActive = manifest;
                root = state.buildDir(activeId);
                buildId = activeId;
                builtAt = state.activeBuiltAt();
            } catch (Exception error) {
                Log.w(TAG, "active 清单损坏，回到 APK 资源: " + activeId, error);
                UpdateState.deleteRecursively(state.buildDir(activeId));
                state.clearActive();
            }
        }

        if (chosen == null && baseManifest != null) {
            chosen = baseManifest;
            buildId = basePointer.buildId;
            builtAt = basePointer.builtAt;
        } else if (chosen == null && !BuildConfig.BASELINE_BUILD_ID.isEmpty()) {
            buildId = BuildConfig.BASELINE_BUILD_ID;
            builtAt = BuildConfig.BASELINE_BUILT_AT;
        }

        activeManifest = chosenActive;
        installedBuiltAt = builtAt;
        snapshot = Snapshot.build(buildId, chosen, root);
        // 进程在「切换版本后、markBootOk 前」被杀掉时，下次启动继续处于 boot 窗口：
        // 给新版本一次重新加载的机会，失败仍然回退。
        String pending = state.pendingBootBuildId();
        if (!pending.isEmpty() && pending.equals(buildId)) {
            pendingBoot = true;
            bootOk = false;
            bootFailureHandled = false;
            pendingBuildId = pending;
        } else {
            if (!pending.isEmpty()) state.clearPendingBoot();
            pendingBoot = false;
            bootOk = false;
            bootFailureHandled = false;
            pendingBuildId = "";
        }
        state.cleanupBuilds(state.active(), state.previous());
        Log.i(TAG, "当前版本 buildId=" + buildId
                + "，来源=" + (root == null ? "APK 资源" : root.getName()));
        Diagnostics.report("update-snapshot", "buildId", buildId,
                "source", root == null ? "apk" : "update",
                "baseline", baseManifest == null ? "missing" : "read");
    }

    private static String fallbackBuildId() {
        return BuildConfig.BASELINE_BUILD_ID.isEmpty() ? APK_BUILD_ID : BuildConfig.BASELINE_BUILD_ID;
    }

    private static String describeError(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }

    private byte[] readAsset(String path) throws IOException {
        try (InputStream input = context.getAssets().open(path)) {
            return readAll(input);
        }
    }

    private static byte[] readFile(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return readAll(input);
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output.toByteArray();
    }

    private void postToMain(Runnable action) {
        mainHandler.post(action);
    }
}
