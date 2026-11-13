package io.github.sunflower9264.inoita;

import android.webkit.MimeTypeMap;

import java.io.IOException;
import java.net.URLDecoder;
import java.util.Locale;

/**
 * 本地资源服务的路径与响应头规则。
 *
 * 和原来的 WebViewAssetLoader 一样：资源清单是权威，磁盘优先，APK assets 兜底。
 */
final class AssetPaths {

    /** 构建产物文件名带内容哈希，可以按 immutable 缓存一年。 */
    private static final long IMMUTABLE_CACHE_MAX_AGE_SECONDS = 365L * 24 * 60 * 60;

    private AssetPaths() {}

    /** 按段解码并拒绝 .、..、反斜杠、NUL、隐藏段和空段。 */
    static String normalize(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) return null;
        String path = rawPath.charAt(0) == '/' ? rawPath.substring(1) : rawPath;
        if (path.isEmpty()) return null;
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return null;

        String[] segments = path.split("/", -1);
        StringBuilder result = new StringBuilder(path.length());
        for (String segment : segments) {
            if (segment.isEmpty()) return null;
            String decoded;
            try {
                // URLDecoder 会把 + 当成空格；路径里 + 是字面量，先转义回来。
                decoded = URLDecoder.decode(segment.replace("+", "%2B"), "UTF-8");
            } catch (IllegalArgumentException | IOException error) {
                return null;
            }
            if (decoded.isEmpty() || decoded.equals(".") || decoded.equals("..")) return null;
            if (decoded.charAt(0) == '.') return null;
            if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0
                    || decoded.indexOf('\0') >= 0) return null;
            if (result.length() > 0) result.append('/');
            result.append(decoded);
        }
        return result.toString();
    }

    static String mimeType(String relative) {
        int dot = relative.lastIndexOf('.');
        String extension = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase(Locale.US);
        switch (extension) {
            case "json":
                return "application/json";
            case "js":
            case "mjs":
                return "text/javascript";
            case "html":
                return "text/html";
            case "css":
                return "text/css";
            case "svg":
                return "image/svg+xml";
            case "webmanifest":
                return "application/manifest+json";
            case "wasm":
                return "application/wasm";
            case "mp3":
                return "audio/mpeg";
            case "webp":
                return "image/webp";
            default:
                String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return guessed == null ? "application/octet-stream" : guessed;
        }
    }

    static boolean needsUtf8(String relative) {
        String mime = mimeType(relative);
        int dot = relative.lastIndexOf('.');
        String extension = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase(Locale.US);
        return extension.equals("json") || extension.equals("js") || extension.equals("mjs")
                || extension.equals("html") || extension.equals("css") || extension.equals("svg")
                || extension.equals("webmanifest") || mime.startsWith("text/");
    }

    static String cachePolicy(String relative) {
        if (relative.startsWith("bundles/")) {
            return "public, max-age=" + IMMUTABLE_CACHE_MAX_AGE_SECONDS + ", immutable";
        }
        if (relative.equals("index.html") || relative.equals("diagnostics.js")) return "no-store";
        return "no-cache";
    }
}
