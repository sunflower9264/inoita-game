package io.github.sunflower9264.inoita;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/** 启动与崩溃日志：写到应用外部文件目录，真机排查时可以直接拷出来。 */
final class CrashLog {

    private static final String TAG = "InotiaCrash";
    static final String CRASH_LOG_FILE = "crash.log";
    private static final String STARTUP_LOG_FILE = "startup.log";
    private static final long MAX_LOG_BYTES = 256 * 1024;

    private CrashLog() {}

    static void deviceInfo(Context context, String phase) {
        append(context, STARTUP_LOG_FILE, phase
                + " model=" + Build.MANUFACTURER + " " + Build.MODEL
                + " android=" + Build.VERSION.RELEASE + " sdk=" + Build.VERSION.SDK_INT
                + " abis=" + Arrays.toString(Build.SUPPORTED_ABIS));
    }

    static void install(final Context context, final Thread.UncaughtExceptionHandler previous) {
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            append(context, CRASH_LOG_FILE, "uncaught " + thread.getName() + ": " + Log.getStackTraceString(error));
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    static void append(Context context, String name, String message) {
        try {
            File directory = context.getExternalFilesDir(null);
            if (directory == null) directory = context.getFilesDir();
            if (directory == null) return;
            File file = new File(directory, name);
            if (file.length() > MAX_LOG_BYTES) {
                File rotated = new File(directory, name + ".1");
                if (rotated.exists()) rotated.delete();
                file.renameTo(rotated);
            }
            String time = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
            try (FileOutputStream output = new FileOutputStream(file, true)) {
                output.write((time + " " + message + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable error) {
            Log.w(TAG, "写日志失败", error);
        }
    }
}
