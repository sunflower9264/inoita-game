package io.github.sunflower9264.inoita;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;

/**
 * 只监听 127.0.0.1 的本地 HTTP 服务。
 *
 * 页面从 http://127.0.0.1:端口 打开，和原生端点、云存档、诊断同源；热更目录由
 * UpdateManager 的版本快照决定，和原来的 WebViewAssetLoader 规则一致。
 */
final class LocalAssetServer extends NanoHTTPD {

    interface MigrationListener {
        void onMigrationDone();
    }

    interface FrameRateListener {
        void onFrameRateRequested(int rate);
    }

    static final int PORT = 47653;
    /** 页面通过原生桥只允许上报这两个游戏帧率。 */
    static final int FRAME_RATE_30 = 30;
    static final int FRAME_RATE_60 = 60;
    private static final String TAG = "InotiaAssets";
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int PROXY_CONNECT_TIMEOUT_MS = 15000;
    private static final int PROXY_READ_TIMEOUT_MS = 30000;
    private static final int HTTP_BAD_GATEWAY = 502;
    private static final int READ_BUFFER_BYTES = 16 * 1024;

    private final Context context;
    private final UpdateManager manager;
    private final MigrationListener migrationListener;
    private final FrameRateListener frameRateListener;
    private final String migrationJson;
    private boolean migrationPending;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    LocalAssetServer(Context context, UpdateManager manager, String migrationJson,
                     MigrationListener migrationListener, FrameRateListener frameRateListener) {
        super("127.0.0.1", PORT);
        this.context = context;
        this.manager = manager;
        this.migrationJson = migrationJson;
        this.migrationPending = migrationJson != null && !migrationJson.equals("{}");
        this.migrationListener = migrationListener;
        this.frameRateListener = frameRateListener;
    }

    String baseUrl() {
        return "http://127.0.0.1:" + PORT;
    }

    void startServer() throws IOException {
        start(SOCKET_READ_TIMEOUT, false);
    }

    @Override
    public Response serve(IHTTPSession session) {
        try {
            String uri = session.getUri();
            if (uri == null || uri.isEmpty()) uri = "/";
            if (uri.equals("/__native/report")) return nativeReport(session);
            if (uri.equals("/__native/boot-ok")) {
                mainHandler.post(manager::markBootOk);
                return empty(Response.Status.NO_CONTENT);
            }
            if (uri.equals("/__native/build-info")) return json(manager.buildInfoJson());
            if (uri.equals("/__native/frame-rate")) return nativeFrameRate(session);
            if (uri.equals("/__native/bootstrap.js")) return bootstrap();
            if (uri.equals("/__native/migration-done")) {
                mainHandler.post(() -> {
                    if (migrationListener != null) migrationListener.onMigrationDone();
                });
                return empty(Response.Status.NO_CONTENT);
            }
            if (uri.equals("/__diagnostics/report")) return proxyDiagnostics(session);
            if (uri.equals("/__cloud") || uri.startsWith("/__cloud/")) return proxyCloud(session, uri);
            return serveAsset(session, uri);
        } catch (Exception error) {
            Log.w(TAG, "本地资源请求失败: " + session.getUri(), error);
            return text(Response.Status.INTERNAL_ERROR, "local server error");
        }
    }

    private Response nativeReport(IHTTPSession session) {
        byte[] body = readBody(session);
        if (body == null) return text(Response.Status.BAD_REQUEST, "body too large");
        boolean ok = Diagnostics.post(new String(body, StandardCharsets.UTF_8));
        return empty(ok ? Response.Status.OK : Response.Status.INTERNAL_ERROR);
    }

    /** 页面只报 30/60；壳自己选刷新率能整除它的显示模式。 */
    private Response nativeFrameRate(IHTTPSession session) {
        String value = session.getParms().get("rate");
        int rate;
        try {
            rate = Integer.parseInt(value == null ? "" : value.trim());
        } catch (NumberFormatException error) {
            rate = 0;
        }
        if (rate == FRAME_RATE_30 || rate == FRAME_RATE_60) {
            final int requested = rate;
            mainHandler.post(() -> {
                if (frameRateListener != null) frameRateListener.onFrameRateRequested(requested);
            });
        }
        return empty(Response.Status.NO_CONTENT);
    }

    private Response proxyDiagnostics(IHTTPSession session) {
        byte[] body = readBody(session);
        if (body == null) return text(Response.Status.BAD_REQUEST, "body too large");
        boolean ok = Diagnostics.post(new String(body, StandardCharsets.UTF_8));
        return empty(ok ? Response.Status.OK : Response.Status.INTERNAL_ERROR);
    }

    private Response proxyCloud(IHTTPSession session, String uri) {
        String suffix = uri.substring("/__cloud".length());
        String query = session.getQueryParameterString();
        if (query != null && !query.isEmpty()) suffix += "?" + query;
        return proxy(session, BuildConfig.CLOUD_SAVE_URL + suffix);
    }

    private Response proxy(IHTTPSession session, String target) {
        HttpURLConnection connection = null;
        try {
            byte[] body = readBody(session);
            if (body == null) return text(Response.Status.BAD_REQUEST, "body too large");
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setRequestMethod(session.getMethod().toString());
            connection.setConnectTimeout(PROXY_CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(PROXY_READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept-Encoding", "identity");
            String contentType = header(session, "content-type");
            if (contentType != null) connection.setRequestProperty("Content-Type", contentType);
            String authorization = header(session, "authorization");
            if (authorization != null) connection.setRequestProperty("Authorization", authorization);
            if (body.length > 0) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
            }
            int code = connection.getResponseCode();
            InputStream input = code >= HttpURLConnection.HTTP_BAD_REQUEST
                    ? connection.getErrorStream() : connection.getInputStream();
            byte[] data = input == null ? new byte[0] : readAll(input);
            Response.Status status = Response.Status.lookup(code);
            if (status == null) status = Response.Status.INTERNAL_ERROR;
            String type = connection.getContentType();
            Response response = response(status, type == null ? "application/json" : type, data);
            String encoding = connection.getHeaderField("Content-Encoding");
            if (encoding != null) response.addHeader("Content-Encoding", encoding);
            return response;
        } catch (Exception error) {
            Log.w(TAG, "代理请求失败: " + target, error);
            Response.Status status = Response.Status.lookup(HTTP_BAD_GATEWAY);
            if (status == null) status = Response.Status.INTERNAL_ERROR;
            return text(status, "proxy error");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Response serveAsset(IHTTPSession session, String uri) {
        String relative = AssetPaths.normalize(uri);
        if (relative == null) return notFound();

        UpdateManager.Snapshot snapshot = manager.snapshot();
        File file = null;
        if (snapshot.isAuthoritative()) {
            if (!snapshot.paths().contains(relative)) return notFound();
            file = snapshot.files().get(relative);
        }

        try {
            if (file != null && file.isFile()) {
                if (relative.equals("index.html")) {
                    byte[] data;
                    try (InputStream input = new FileInputStream(file)) {
                        data = injectBootstrap(readAll(input));
                    }
                    Response response = response(Response.Status.OK, contentType(relative), data);
                    headers(response, relative);
                    return response;
                }
                Response response = newFixedLengthResponse(Response.Status.OK,
                        contentType(relative), new FileInputStream(file), file.length());
                headers(response, relative);
                return response;
            }
            try (InputStream input = context.getAssets().open(relative)) {
                byte[] data = readAll(input);
                if (relative.equals("index.html")) data = injectBootstrap(data);
                Response response = response(Response.Status.OK, contentType(relative), data);
                headers(response, relative);
                return response;
            }
        } catch (IOException error) {
            return notFound();
        }
    }

    /**
     * 在入口 HTML 的 head 最前面插入 bootstrap。
     *
     * 它比 Cefrium 的 document-start 注入更可靠：即使原生注入接口不可用，
     * 页面也一定能在模块脚本之前拿到 __inoitaEndpoints、原生桥和存档迁移数据。
     */
    private static byte[] injectBootstrap(byte[] htmlBytes) {
        String html = new String(htmlBytes, StandardCharsets.UTF_8);
        String tag = "<script src=\"/__native/bootstrap.js\"></script>";
        int head = html.toLowerCase(Locale.US).indexOf("<head");
        if (head >= 0) {
            int end = html.indexOf('>', head);
            if (end >= 0) html = html.substring(0, end + 1) + tag + html.substring(end + 1);
            else html = tag + html;
        } else {
            html = tag + html;
        }
        return html.getBytes(StandardCharsets.UTF_8);
    }

    private Response bootstrap() {
        String local = baseUrl();
        String endpoints = "{\"version\":1"
                + ",\"cloudBase\":" + jsString(local + "/__cloud")
                + ",\"diagnosticsReport\":" + jsString(local + "/__diagnostics/report")
                + "}";
        StringBuilder script = new StringBuilder();
        script.append("globalThis.__inoitaEngine='cefrium';");
        script.append("globalThis.__inoitaEndpoints=").append(endpoints).append(";");
        script.append("globalThis.__inoitaBuildInfo=").append(manager.buildInfoJson()).append(";");
        script.append("window.InotiaNative={")
                .append("report:function(body,id){")
                .append("fetch('/__native/report',{method:'POST',headers:{'Content-Type':'application/json'},body:body})")
                .append(".then(function(r){return r.ok}).catch(function(){return false})")
                .append(".then(function(ok){try{window.__inoitaNativeReportResult&&window.__inoitaNativeReportResult(id,ok)}catch(e){}});")
                .append("},")
                .append("markBootOk:function(){fetch('/__native/boot-ok',{method:'POST'}).catch(function(){});},")
                .append("setFrameRate:function(rate){fetch('/__native/frame-rate?rate='+encodeURIComponent(rate),{method:'POST'}).catch(function(){});},")
                .append("buildInfo:function(){return JSON.stringify(globalThis.__inoitaBuildInfo||{});}")
                .append("};");

        boolean migrate;
        synchronized (this) {
            migrate = migrationPending && migrationJson != null;
            if (migrate) migrationPending = false;
        }
        if (migrate) {
            script.append("try{var __inoitaMigration=").append(migrationJson).append(";")
                    .append("for(var __k in __inoitaMigration){")
                    .append("if(Object.prototype.hasOwnProperty.call(__inoitaMigration,__k))")
                    .append("localStorage.setItem(__k,__inoitaMigration[__k]);}")
                    .append("}catch(__e){}");
            script.append("fetch('/__native/migration-done',{method:'POST'}).catch(function(){});");
            mainHandler.post(() -> {
                if (migrationListener != null) migrationListener.onMigrationDone();
            });
        }

        Response response = newFixedLengthResponse(Response.Status.OK,
                "text/javascript; charset=utf-8", script.toString());
        response.addHeader("Cache-Control", "no-store");
        return response;
    }

    private static String jsString(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private static Response response(Response.Status status, String mime, byte[] data) {
        return newFixedLengthResponse(status, mime, new ByteArrayInputStream(data), data.length);
    }

    private static Response text(Response.Status status, String body) {
        return newFixedLengthResponse(status, "text/plain; charset=utf-8", body);
    }

    private static Response json(String body) {
        return newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", body);
    }

    private static Response empty(Response.Status status) {
        return newFixedLengthResponse(status, "text/plain", "");
    }

    private static Response notFound() {
        Response response = text(Response.Status.NOT_FOUND, "");
        response.addHeader("Cache-Control", "no-store");
        return response;
    }

    private static void headers(Response response, String relative) {
        response.addHeader("Cache-Control", AssetPaths.cachePolicy(relative));
        response.addHeader("Access-Control-Allow-Origin", "*");
        response.addHeader("Accept-Ranges", "none");
    }

    private static String contentType(String relative) {
        String mime = AssetPaths.mimeType(relative);
        return AssetPaths.needsUtf8(relative) ? mime + "; charset=utf-8" : mime;
    }

    private static String header(IHTTPSession session, String name) {
        for (Map.Entry<String, String> entry : session.getHeaders().entrySet()) {
            if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }

    private static byte[] readBody(IHTTPSession session) {
        try {
            String length = header(session, "content-length");
            if (length == null) return new byte[0];
            long size = Long.parseLong(length.trim());
            if (size < 0 || size > MAX_BODY_BYTES) return null;
            byte[] data = new byte[(int) size];
            InputStream input = session.getInputStream();
            int offset = 0;
            while (offset < data.length) {
                int read = input.read(data, offset, data.length - offset);
                if (read < 0) break;
                offset += read;
            }
            return offset == data.length ? data : Arrays.copyOf(data, offset);
        } catch (Exception error) {
            return null;
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[READ_BUFFER_BYTES];
        int read;
        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        return output.toByteArray();
    }
}
