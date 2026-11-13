package io.github.sunflower9264.inoita;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;

/**
 * 热更新的本地状态：SharedPreferences 里的 active/previous 和 filesDir/update 下的版本目录。
 *
 * 目录布局固定，PathHandler 和安装器都从这里取路径，避免各自拼字符串：
 *
 *   filesDir/update/builds/<buildId>/...               完整版本
 *   filesDir/update/builds/<buildId>/.manifest.json    该版本清单副本
 *   filesDir/update/staging/<buildId>/...              下载中的版本（.part 续传）
 */
final class UpdateState {

    private static final String TAG = "InotiaUpdate";
    private static final String PREFS = "inoita-update";
    private static final String KEY_ACTIVE = "active";
    private static final String KEY_PREVIOUS = "previous";
    private static final String KEY_FAILED_BUILD_ID = "failedBuildId";
    private static final String KEY_ACTIVE_BUILT_AT = "activeBuiltAt";
    private static final String KEY_ACTIVE_CHANNEL = "activeChannel";
    private static final String KEY_LAST_CHECK_AT = "lastCheckAt";
    private static final String KEY_LAST_CHECK_RESULT = "lastCheckResult";
    private static final String KEY_LAST_CHECK_ERROR = "lastCheckError";
    private static final String KEY_AVAILABLE_BUILD_ID = "availableBuildId";
    private static final String KEY_AVAILABLE_FILES = "availableFiles";
    private static final String KEY_AVAILABLE_BYTES = "availableBytes";
    private static final String KEY_DOWNLOAD_ERROR = "downloadError";
    private static final String KEY_FAILED_AT = "failedAt";
    private static final String KEY_PENDING_BOOT = "pendingBootBuildId";
    private static final String KEY_BOOT_STARTED_AT = "bootStartedAt";
    private static final String KEY_LAST_BOOT_MS = "lastBootMs";
    private static final String KEY_READY_BUILD_ID = "readyBuildId";
    private static final String MANIFEST_COPY = ".manifest.json";
    private static final String BUILT_AT_COPY = ".built-at";
    private static final String COMPLETE_MARKER = ".complete";
    private static final int READ_BUFFER_BYTES = 4096;

    /** setLastCheck 的持久化结果；更新器和页面靠这些值判断检查状态。 */
    static final String CHECK_RESULT_ERROR = "error";
    static final String CHECK_RESULT_NONE = "none";
    static final String CHECK_RESULT_AVAILABLE = "available";
    static final String CHECK_RESULT_BLOCKED = "blocked";

    private final SharedPreferences preferences;
    private final File updateRoot;
    private final File buildsDir;
    private final File stagingDir;

    UpdateState(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        updateRoot = new File(context.getFilesDir(), "update");
        buildsDir = new File(updateRoot, "builds");
        stagingDir = new File(updateRoot, "staging");
    }

    File updateRoot() {
        return updateRoot;
    }

    File buildsDir() {
        return buildsDir;
    }

    File stagingDir() {
        return stagingDir;
    }

    File buildDir(String buildId) {
        return new File(buildsDir, buildId);
    }

    File stagingDir(String buildId) {
        return new File(stagingDir, buildId);
    }

    File manifestCopy(String buildId) {
        return new File(buildDir(buildId), MANIFEST_COPY);
    }

    File manifestCopy(File buildRoot) {
        return new File(buildRoot, MANIFEST_COPY);
    }

    File builtAtCopy(String buildId) {
        return new File(buildDir(buildId), BUILT_AT_COPY);
    }

    File builtAtCopy(File buildRoot) {
        return new File(buildRoot, BUILT_AT_COPY);
    }

    File completeMarker(File buildRoot) {
        return new File(buildRoot, COMPLETE_MARKER);
    }

    void ensureDirs() throws IOException {
        if (!updateRoot.isDirectory() && !updateRoot.mkdirs() && !updateRoot.isDirectory()) {
            throw new IOException("无法创建更新目录: " + updateRoot);
        }
        if (!buildsDir.isDirectory() && !buildsDir.mkdirs() && !buildsDir.isDirectory()) {
            throw new IOException("无法创建版本目录: " + buildsDir);
        }
        if (!stagingDir.isDirectory() && !stagingDir.mkdirs() && !stagingDir.isDirectory()) {
            throw new IOException("无法创建暂存目录: " + stagingDir);
        }
    }

    String active() {
        return value(KEY_ACTIVE);
    }

    String previous() {
        return value(KEY_PREVIOUS);
    }

    String failedBuildId() {
        return value(KEY_FAILED_BUILD_ID);
    }

    String activeBuiltAt() {
        return value(KEY_ACTIVE_BUILT_AT);
    }

    String activeChannel() {
        return value(KEY_ACTIVE_CHANNEL);
    }

    void setFailedBuildId(String buildId) {
        preferences.edit()
                .putString(KEY_FAILED_BUILD_ID, buildId == null ? "" : buildId)
                .putLong(KEY_FAILED_AT, System.currentTimeMillis())
                .commit();
    }

    long failedAt() {
        return preferences.getLong(KEY_FAILED_AT, 0L);
    }

    void clearFailedBuildId() {
        preferences.edit().remove(KEY_FAILED_BUILD_ID).remove(KEY_FAILED_AT).commit();
    }

    long lastCheckAt() {
        return preferences.getLong(KEY_LAST_CHECK_AT, 0L);
    }

    String lastCheckResult() {
        return value(KEY_LAST_CHECK_RESULT);
    }

    String lastCheckError() {
        return value(KEY_LAST_CHECK_ERROR);
    }

    void setLastCheck(String result, String error) {
        preferences.edit()
                .putLong(KEY_LAST_CHECK_AT, System.currentTimeMillis())
                .putString(KEY_LAST_CHECK_RESULT, result == null ? "" : result)
                .putString(KEY_LAST_CHECK_ERROR, error == null ? "" : error)
                .commit();
    }

    void setAvailable(String buildId, int files, long bytes) {
        preferences.edit()
                .putString(KEY_AVAILABLE_BUILD_ID, buildId == null ? "" : buildId)
                .putInt(KEY_AVAILABLE_FILES, files)
                .putLong(KEY_AVAILABLE_BYTES, bytes)
                .commit();
    }

    void clearAvailable() {
        preferences.edit()
                .remove(KEY_AVAILABLE_BUILD_ID)
                .remove(KEY_AVAILABLE_FILES)
                .remove(KEY_AVAILABLE_BYTES)
                .commit();
    }

    String availableBuildId() {
        return value(KEY_AVAILABLE_BUILD_ID);
    }

    int availableFileCount() {
        return preferences.getInt(KEY_AVAILABLE_FILES, 0);
    }

    long availableBytes() {
        return preferences.getLong(KEY_AVAILABLE_BYTES, 0L);
    }

    void setDownloadError(String error) {
        preferences.edit().putString(KEY_DOWNLOAD_ERROR, error == null ? "" : error).commit();
    }

    void clearDownloadError() {
        preferences.edit().remove(KEY_DOWNLOAD_ERROR).commit();
    }

    String downloadError() {
        return value(KEY_DOWNLOAD_ERROR);
    }

    void setReady(String buildId) {
        preferences.edit().putString(KEY_READY_BUILD_ID, buildId == null ? "" : buildId).commit();
    }

    void clearReady() {
        preferences.edit().remove(KEY_READY_BUILD_ID).commit();
    }

    String readyBuildId() {
        return value(KEY_READY_BUILD_ID);
    }

    void setPendingBoot(String buildId, long startedAt) {
        preferences.edit()
                .putString(KEY_PENDING_BOOT, buildId == null ? "" : buildId)
                .putLong(KEY_BOOT_STARTED_AT, startedAt)
                .commit();
    }

    void clearPendingBoot() {
        preferences.edit().remove(KEY_PENDING_BOOT).remove(KEY_BOOT_STARTED_AT).commit();
    }

    String pendingBootBuildId() {
        return value(KEY_PENDING_BOOT);
    }

    long pendingBootStartedAt() {
        return preferences.getLong(KEY_BOOT_STARTED_AT, 0L);
    }

    void setLastBootDuration(long durationMs) {
        preferences.edit().putLong(KEY_LAST_BOOT_MS, durationMs).commit();
    }

    long lastBootDuration() {
        return preferences.getLong(KEY_LAST_BOOT_MS, 0L);
    }

    /** 安装完成后的原子切换：新版本 active，旧 active 降为 previous。 */
    void commitActive(String active, String previous, String builtAt, String channel) {
        preferences.edit()
                .putString(KEY_ACTIVE, active)
                .putString(KEY_PREVIOUS, previous)
                .putString(KEY_ACTIVE_BUILT_AT, builtAt == null ? "" : builtAt)
                .putString(KEY_ACTIVE_CHANNEL, channel == null ? "" : channel)
                .commit();
    }

    /** 回退到 previous，previous 清空；保留 activeBuiltAt 为失败版本的构建时间，避免往回安装更旧的版本。 */
    void rollbackTo(String previous) {
        preferences.edit()
                .putString(KEY_ACTIVE, previous)
                .putString(KEY_PREVIOUS, "")
                .commit();
    }

    /** 回到 APK 自带资源。 */
    void clearActive() {
        preferences.edit()
                .remove(KEY_ACTIVE)
                .remove(KEY_PREVIOUS)
                .remove(KEY_ACTIVE_BUILT_AT)
                .remove(KEY_ACTIVE_CHANNEL)
                .commit();
    }

    void clearPrevious() {
        preferences.edit().remove(KEY_PREVIOUS).commit();
    }

    boolean isUsable(String buildId) {
        if (buildId == null || buildId.isEmpty()) return false;
        File build = buildDir(buildId);
        // .complete 在整目录改名之前写入；缺它就说明没有完整落盘，不能拿来加载。
        return build.isDirectory() && manifestCopy(buildId).isFile()
                && completeMarker(build).isFile();
    }

    /**
     * APK 重装后对账：APK 自带基线比本地 active 新时，本地版本可能比 APK 旧，
     * 丢弃 active 和 previous，改为使用 APK 资源。
     */
    void discardActiveIfBaselineNewer(long baselineBuiltAtMillis) {
        String active = active();
        if (active.isEmpty()) return;
        long activeMillis = parseMillis(activeBuiltAt());
        if (activeMillis < baselineBuiltAtMillis) {
            Log.i(TAG, "APK 基线比本地版本新，丢弃本地 active=" + active);
            discardActiveAndPrevious();
        }
    }

    void discardActiveAndPrevious() {
        String active = active();
        String previous = previous();
        // 空 buildId 不能传给 File(parent, child)，否则会指向 builds/ 本身。
        if (!active.isEmpty()) deleteRecursively(buildDir(active));
        if (!previous.isEmpty()) deleteRecursively(buildDir(previous));
        clearActive();
    }

    /** 只保留 keepA、keepB 两个版本目录；其余启动时清掉，避免版本目录无限增长。 */
    void cleanupBuilds(String keepA, String keepB) {
        File[] children = buildsDir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (!child.isDirectory()) continue;
            String name = child.getName();
            if (name.equals(keepA) || name.equals(keepB)) continue;
            deleteRecursively(child);
        }
    }

    String readBuiltAt(String buildId) {
        File file = builtAtCopy(buildId);
        if (!file.isFile()) return "";
        try {
            return readText(file).trim();
        } catch (IOException error) {
            return "";
        }
    }

    private String value(String key) {
        String value = preferences.getString(key, "");
        return value == null ? "" : value.trim();
    }

    private static String readText(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[READ_BUFFER_BYTES];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static long parseMillis(String builtAt) {
        if (builtAt == null || builtAt.isEmpty()) return Long.MIN_VALUE;
        try {
            return Instant.parse(builtAt).toEpochMilli();
        } catch (DateTimeParseException error) {
            return Long.MIN_VALUE;
        }
    }

    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        if (!file.delete() && file.exists()) {
            Log.w(TAG, "删除失败: " + file);
        }
    }
}
