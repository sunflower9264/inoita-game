package io.github.sunflower9264.inoita;

import android.os.StatFs;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 把服务端清单落成一份完整版本目录。
 *
 * 差量规则：文件指纹等于 APK 基线就用 APK 里的；等于当前 active 就用硬链接；
 * 剩下的才下载。所有文件先写 .part，校验指纹后再改名，最后整个 staging 目录
 * 原子改名为 builds/<buildId>，避免半个版本被当成可用版本加载。
 */
final class UpdateInstaller {

    private static final String TAG = "InotiaUpdate";
    private static final long RESERVE_BYTES = 16L * 1024 * 1024;
    /** 下载字节之外再按 1.25 倍估算空间，给临时文件和目录元数据留余量。 */
    private static final double SPACE_OVERHEAD_RATIO = 1.25d;

    /** 一次安装计划：要下载的文件列表和字节数。 */
    static final class Plan {
        final String buildId;
        final UpdateManifest.Manifest target;
        final List<UpdateManifest.FileEntry> downloads;
        final long downloadBytes;
        final File staging;

        Plan(String buildId, UpdateManifest.Manifest target,
             List<UpdateManifest.FileEntry> downloads, long downloadBytes, File staging) {
            this.buildId = buildId;
            this.target = target;
            this.downloads = downloads;
            this.downloadBytes = downloadBytes;
            this.staging = staging;
        }

        int downloadCount() {
            return downloads.size();
        }
    }

    private final UpdateState state;

    UpdateInstaller(UpdateState state) {
        this.state = state;
    }

    /**
     * 生成 staging 目录和差量计划。某个文件硬链接失败时只为该文件改为下载，
     * 不让整次更新中止；这样文件系统不支持硬链接的设备也能继续更新。
     */
    Plan prepare(UpdateManifest.Manifest target, UpdateManifest.Manifest baseline,
                 UpdateManifest.Manifest active, byte[] manifestBytes, String builtAt)
            throws IOException {
        File staging = state.stagingDir(target.buildId);
        if (!staging.isDirectory() && !staging.mkdirs() && !staging.isDirectory()) {
            throw new IOException("无法创建暂存目录: " + staging);
        }

        state.deleteRecursively(state.completeMarker(staging));
        writeBytes(new File(staging, ".manifest.json"), manifestBytes);
        writeBytes(new File(staging, ".built-at"),
                (builtAt == null ? "" : builtAt).getBytes(StandardCharsets.UTF_8));

        File activeRoot = active == null ? null : state.buildDir(active.buildId);
        List<UpdateManifest.FileEntry> downloads = new ArrayList<>();
        long downloadBytes = 0;

        for (UpdateManifest.FileEntry entry : target.files) {
            File finalFile = new File(staging, entry.path);
            File part = partFile(staging, entry.path);

            // 上次可能已经解压/改名完毕但还没切换版本，指纹一致就继续用。
            if (finalFile.isFile() && finalFile.length() == entry.size
                    && entry.hash.equals(UpdateManifest.fingerprint(finalFile, entry.path))) {
                state.deleteRecursively(part);
                continue;
            }
            // 指纹不符的旧文件不能留到最终版本里。
            if (finalFile.exists()) state.deleteRecursively(finalFile);

            UpdateManifest.FileEntry baselineEntry = baseline == null
                    ? null : baseline.find(entry.path);
            if (matches(baselineEntry, entry)) {
                // APK 里已经有同样的字节，运行时直接由 AssetsPathHandler 提供。
                state.deleteRecursively(part);
                continue;
            }

            UpdateManifest.FileEntry activeEntry = active == null
                    ? null : active.find(entry.path);
            if (matches(activeEntry, entry) && activeRoot != null) {
                File source = new File(activeRoot, entry.path);
                if (source.isFile()) {
                    try {
                        link(source, finalFile);
                        state.deleteRecursively(part);
                        continue;
                    } catch (IOException error) {
                        // 硬链接只是省下载和空间的手段；失败时退回下载，不阻断更新。
                        Log.w(TAG, "硬链接失败，改为下载: " + entry.path, error);
                    }
                }
            }

            long present = part.isFile() ? part.length() : 0;
            if (present > entry.size) present = 0;
            downloadBytes += Math.max(0, entry.size - present);
            downloads.add(entry);
        }

        return new Plan(target.buildId, target, downloads, downloadBytes, staging);
    }

    /** 空间按「缺失总量 × 1.25 + 16MB」预留，宁可提前拒绝也别装到一半失败。 */
    void requireSpace(Plan plan) throws IOException {
        long needed = (long) Math.ceil(plan.downloadBytes * SPACE_OVERHEAD_RATIO) + RESERVE_BYTES;
        StatFs stat = new StatFs(state.updateRoot().getAbsolutePath());
        long available = stat.getAvailableBytes();
        if (available < needed) {
            throw new IOException("剩余空间不足：需要 " + needed + "，可用 " + available);
        }
    }

    /**
     * 下载并校验单个文件。已有 .part 时用 Range 续传；续传失败或指纹不符时从头
     * 再试一次，避免服务端文件已变导致 .part 永远对不上。
     */
    void downloadEntry(Plan plan, UpdateManifest.FileEntry entry,
                       UpdateHttp http, UpdateHttp.Cancellation cancellation)
            throws IOException {
        File finalFile = new File(plan.staging, entry.path);
        File part = partFile(plan.staging, entry.path);
        ensureParent(finalFile);

        long offset = part.isFile() ? part.length() : 0;
        if (offset > entry.size) {
            state.deleteRecursively(part);
            offset = 0;
        }

        try {
            http.download("/" + entry.path, part, offset, entry.size, cancellation);
        } catch (IOException error) {
            if (cancellation.isCancelled()) throw error;
            if (offset == 0) throw error;
            // 416、连接中断或服务端换了文件，都从零重下一次。
            state.deleteRecursively(part);
            http.download("/" + entry.path, part, 0, entry.size, cancellation);
        }

        if (!verified(part, entry)) {
            state.deleteRecursively(part);
            http.download("/" + entry.path, part, 0, entry.size, cancellation);
            if (!verified(part, entry)) {
                state.deleteRecursively(part);
                throw new IOException("文件校验失败: " + entry.path);
            }
        }

        if (finalFile.exists()) state.deleteRecursively(finalFile);
        try {
            Os.rename(part.getAbsolutePath(), finalFile.getAbsolutePath());
        } catch (ErrnoException error) {
            throw new IOException("无法落盘: " + entry.path, error);
        }
    }

    /**
     * 写完成标记，把 staging 原子改名为 builds/<buildId>，再切换 active/previous。
     * 切换完成后只保留新 active 和旧 active 两个版本目录。
     */
    void complete(Plan plan, String builtAt, String channel) throws IOException {
        // 完成标记最后写，确保它只出现在所有文件都已落盘之后。
        writeBytes(state.completeMarker(plan.staging),
                plan.buildId.getBytes(StandardCharsets.UTF_8));

        File target = state.buildDir(plan.buildId);
        if (target.exists()) state.deleteRecursively(target);
        try {
            Os.rename(plan.staging.getAbsolutePath(), target.getAbsolutePath());
        } catch (ErrnoException error) {
            throw new IOException("无法切换版本目录", error);
        }

        String oldActive = state.active();
        state.commitActive(plan.buildId, oldActive, builtAt, channel);
        state.cleanupBuilds(plan.buildId, oldActive);
        Log.i(TAG, "安装完成 buildId=" + plan.buildId + "，上一版=" + oldActive);
    }

    private static boolean matches(UpdateManifest.FileEntry candidate,
                                   UpdateManifest.FileEntry target) {
        return candidate != null
                && candidate.hash.equals(target.hash)
                && candidate.size == target.size;
    }

    private static boolean verified(File part, UpdateManifest.FileEntry entry) throws IOException {
        if (!part.isFile() || part.length() != entry.size) return false;
        return entry.hash.equals(UpdateManifest.fingerprint(part, entry.path));
    }

    private static void link(File source, File target) throws IOException {
        ensureParent(target);
        if (target.exists() && !target.delete()) {
            throw new IOException("无法替换旧硬链接: " + target);
        }
        try {
            Os.link(source.getAbsolutePath(), target.getAbsolutePath());
        } catch (ErrnoException error) {
            throw new IOException("无法硬链接（errno=" + error.errno + "）: " + source, error);
        }
    }

    private static File partFile(File staging, String path) {
        return new File(staging, path + ".part");
    }

    private static void ensureParent(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("无法创建目录: " + parent);
        }
    }

    private static void writeBytes(File file, byte[] bytes) throws IOException {
        ensureParent(file);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(bytes);
        }
    }
}
