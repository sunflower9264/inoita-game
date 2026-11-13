package io.github.sunflower9264.inoita;

import android.app.Application;
import android.content.Context;
import android.util.Log;

import com.cefrium.Cefrium;

import org.chromium.base.ApplicationStatus;
import org.chromium.base.ContextUtils;
import org.chromium.base.PathUtils;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.ui.base.ResourceBundle;

/**
 * Cefrium 需要在自己的 Application 启动阶段初始化 Chromium。
 * 初始化必须早于任何 CefriumBrowser，否则渲染进程起不来。
 */
public class InotiaApplication extends Application {

    private static final String TAG = "InotiaCefrium";
    /** Android 子进程名形如「包名:进程名」，冒号是系统约定的分隔符。 */
    private static final String PRIVATE_PROCESS_SEPARATOR = ":";
    /** MainActivity 初始化失败时显示的原因；成功时为 null。 */
    static volatile String initializeError;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        boolean browserProcess = !isChildProcess();
        ContextUtils.initApplicationContext(this);
        ResourceBundle.setAvailablePakLocales(new String[]{"en-US"});
        LibraryLoader.getInstance().setLibraryProcessType(
                browserProcess ? LibraryProcessType.PROCESS_BROWSER : LibraryProcessType.PROCESS_CHILD);
        if (browserProcess) {
            PathUtils.setPrivateDataDirectorySuffix("cefrium");
            ApplicationStatus.initialize(this);
            // 这些开关必须在引擎启动前设置。SDK 的 CefriumInitProvider 在本方法返回后
            // 就会读取库预读开关，放到 onCreate 已经太晚。
            Cefrium.setGpuProcessEnabled(true);
            Cefrium.setLibraryPrefetchEnabled(false);
            Cefrium.setComponentUpdatesEnabled(false);
        }
        // 让 SDK 自己的 CefriumInitProvider 不要再跑一遍：它在 Application 之后执行，
        // 重复设置 LibraryLoader 可能会在原生库已经加载后报错。
        Cefrium.setupProcess(this);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        CrashLog.install(this, Thread.getDefaultUncaughtExceptionHandler());
        CrashLog.deviceInfo(this, "app-start");
        if (isChildProcess()) return;
        try {
            boolean initialized = Cefrium.initialize(this);
            if (!initialized) {
                initializeError = "Cefrium.initialize 返回 false";
                Log.e(TAG, initializeError);
            } else {
                Log.i(TAG, "Cefrium " + Cefrium.getVersion() + " / Chromium " + Cefrium.getChromiumVersion());
                CrashLog.deviceInfo(this, "cefrium-ok " + Cefrium.getVersion());
            }
        } catch (Throwable error) {
            initializeError = Log.getStackTraceString(error);
            Log.e(TAG, "Cefrium initialize crashed", error);
            CrashLog.append(this, CrashLog.CRASH_LOG_FILE,
                    "cefrium-initialize: " + Log.getStackTraceString(error));
        }
    }

    private static boolean isChildProcess() {
        String name = ContextUtils.getProcessName();
        return name != null && name.contains(PRIVATE_PROCESS_SEPARATOR);
    }
}
