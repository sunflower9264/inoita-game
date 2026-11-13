package io.github.sunflower9264.inoita;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * 热更新专用的 HTTP 客户端。
 *
 * 只允许访问 BuildConfig.UPDATE_BASE_URL 里的同一个 host，禁止重定向，超时固定；
 * 指针和清单允许 gzip（先解压再验哈希和签名），单文件强制 identity，保证清单里的
 * 原始字节指纹和 Range 续传偏移能对得上。
 */
final class UpdateHttp {

    interface Cancellation {
        boolean isCancelled();
    }

    static final int MAX_POINTER_BYTES = 64 * 1024;
    static final int MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
    private static final int MAX_SIGNATURE_BYTES = 32 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final int BUFFER_BYTES = 64 * 1024;

    private final URL base;

    UpdateHttp(String baseUrl) throws MalformedURLException {
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            throw new MalformedURLException("更新地址为空");
        }
        base = new URL(baseUrl.trim());
    }

    byte[] fetchPointer(String path) throws IOException {
        return fetch(path, true, MAX_POINTER_BYTES);
    }

    byte[] fetchManifest(String path) throws IOException {
        return fetch(path, true, MAX_MANIFEST_BYTES);
    }

    byte[] fetchSignature(String path) throws IOException {
        return fetch(path, false, MAX_SIGNATURE_BYTES);
    }

    /**
     * 下载单个文件。offset > 0 时带 Range 续传；服务端忽略 Range 返回 200 时自动
     * 从头写，避免把整份响应追加到旧半截后面。
     */
    long download(String path, File target, long offset, long maxBytes,
                  Cancellation cancellation) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = open(resolve(path), false);
            long start = Math.max(0, offset);
            if (start > 0) {
                connection.setRequestProperty("Range", "bytes=" + start + "-");
            }

            int code = connection.getResponseCode();
            if (isRedirect(code)) throw new IOException("更新源返回了重定向");
            if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_PARTIAL) {
                throw new IOException("下载失败 HTTP " + code);
            }

            boolean append;
            if (start > 0 && code == HttpURLConnection.HTTP_PARTIAL) {
                append = true;
            } else {
                // 200 表示服务端没按 Range 返回，只能从头覆盖写。
                append = false;
                start = 0;
            }

            long total = start;
            try (InputStream input = connection.getInputStream();
                 FileOutputStream output = new FileOutputStream(target, append)) {
                byte[] buffer = new byte[BUFFER_BYTES];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (cancellation != null && cancellation.isCancelled()) {
                        throw new IOException("下载已取消");
                    }
                    output.write(buffer, 0, read);
                    total += read;
                    // 清单已经写明文件大小；超出就中止，避免异常响应写满磁盘。
                    if (maxBytes >= 0 && total > maxBytes) {
                        throw new IOException("文件超过清单大小: " + path);
                    }
                }
            }
            return total;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private byte[] fetch(String path, boolean allowGzip, int maxBytes) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = open(resolve(path), allowGzip);
            int code = connection.getResponseCode();
            if (isRedirect(code)) throw new IOException("更新源返回了重定向");
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("请求失败 HTTP " + code);

            String encoding = connection.getContentEncoding();
            boolean gzip = encoding != null
                    && encoding.toLowerCase(Locale.US).contains("gzip");

            try (InputStream raw = connection.getInputStream();
                 InputStream input = gzip ? new GZIPInputStream(raw) : raw) {
                ByteArrayOutputStream output =
                        new ByteArrayOutputStream(Math.min(maxBytes, BUFFER_BYTES));
                byte[] buffer = new byte[BUFFER_BYTES];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    // 大小上限按解压后的字节算：清单验哈希用的就是这些字节。
                    if (total > maxBytes) throw new IOException("响应超过大小上限");
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private HttpURLConnection open(URL url, boolean allowGzip) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", allowGzip ? "gzip" : "identity");
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("User-Agent", "InotiaUpdater/" + BuildConfig.SHELL_VERSION);
        return connection;
    }

    private static boolean isRedirect(int statusCode) {
        return statusCode >= 300 && statusCode < 400;
    }

    /** 固定 host、协议和端口，防止清单或指针把客户端引到别的服务器。 */
    private URL resolve(String path) throws IOException {
        if (path == null || !path.startsWith("/") || path.contains("..")) {
            throw new IOException("更新路径不合法: " + path);
        }
        URL url = new URL(base, path);
        if (!base.getProtocol().equalsIgnoreCase(url.getProtocol())
                || !base.getHost().equalsIgnoreCase(url.getHost())
                || base.getPort() != url.getPort()
                || url.getUserInfo() != null) {
            throw new IOException("更新地址越界: " + url);
        }
        return url;
    }
}
