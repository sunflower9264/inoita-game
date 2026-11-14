package io.github.sunflower9264.inoita;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 诊断上报：页面和更新流程共用同一条 HTTP 通道。 */
final class Diagnostics {

    private static final String TAG = "InotiaDiagnostics";
    /** 单次上报的 JSON 上限；超过直接丢弃，避免异常内容占满内存。 */
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 8000;
    /** 更新流程的诊断上报走后台线程，不能让 8 秒网络超时挡在冷启动前面。 */
    private static final ExecutorService REPORTER = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "diagnostics-report");
        thread.setDaemon(true);
        return thread;
    });

    private Diagnostics() {}

    /** 返回上游 HTTP 状态码；0 表示请求没有到达或发生了网络错误。 */
    static int post(String body) {
        if (body == null || body.isEmpty() || body.length() > MAX_BODY_BYTES) return 0;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BuildConfig.DIAGNOSTICS_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "diagnostics report returned HTTP " + code);
            }
            // 把状态码交给页面，让 413/400 的缩批与丢弃路径在 APK 里也能生效。
            return code;
        } catch (Exception error) {
            Log.w(TAG, "diagnostics report failed: " + error.getClass().getSimpleName());
            return 0;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 把更新生命周期事件写进现有诊断通道；失败只记日志，不影响更新流程。 */
    static void report(String kind, String... keyValues) {
        try {
            JSONObject details = new JSONObject();
            for (int index = 0; index + 1 < keyValues.length; index += 2) {
                details.put(keyValues[index], keyValues[index + 1]);
            }
            JSONObject entry = new JSONObject();
            entry.put("id", UUID.randomUUID().toString());
            entry.put("kind", kind);
            entry.put("time", Instant.now().toString());
            entry.put("page", "/update");
            entry.put("details", details);
            JSONObject root = new JSONObject();
            root.put("version", 1);
            root.put("entries", new JSONArray().put(entry));
            REPORTER.execute(() -> post(root.toString()));
        } catch (Exception error) {
            Log.w("InotiaUpdate", "更新事件上报失败: " + error.getMessage());
        }
    }
}
