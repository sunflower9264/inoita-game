package io.github.sunflower9264.inoita;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 更新指针与文件清单的解析、校验和签名验证。
 *
 * 指针很小，回答「有没有新版本、清单在哪」；清单列出新版本的全部文件。两者都由
 * 服务端签名，客户端只信任能用内置公钥验过的字节。这里不碰网络和磁盘写入，只做
 * 纯数据校验，方便在检查线程里直接调用。
 */
final class UpdateManifest {

    private static final int SCHEMA = 1;
    private static final Pattern HEX_16 = Pattern.compile("[0-9a-f]{16}");
    private static final Pattern HEX_64 = Pattern.compile("[0-9a-f]{64}");
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final int FINGERPRINT_HEX_DIGITS = 16;
    /** 清单为体积使用单字符字段名：p=路径，h=指纹，s=大小。 */
    private static final String FIELD_PATH = "p";
    private static final String FIELD_HASH = "h";
    private static final String FIELD_SIZE = "s";

    private UpdateManifest() {
    }

    /** latest.json / latest-staging.json。 */
    static final class Pointer {
        final int schema;
        final String buildId;
        final String builtAt;
        final long builtAtMillis;
        final String manifest;
        final String manifestSha256;
        final int minShell;

        Pointer(int schema, String buildId, String builtAt, long builtAtMillis,
                String manifest, String manifestSha256, int minShell) {
            this.schema = schema;
            this.buildId = buildId;
            this.builtAt = builtAt;
            this.builtAtMillis = builtAtMillis;
            this.manifest = manifest;
            this.manifestSha256 = manifestSha256;
            this.minShell = minShell;
        }
    }

    /** 清单里的一个文件。hash 是 16 位十六进制的内容指纹。 */
    static final class FileEntry {
        final String path;
        final String hash;
        final long size;

        FileEntry(String path, String hash, long size) {
            this.path = path;
            this.hash = hash;
            this.size = size;
        }
    }

    /** <buildId>.json。文件顺序保持服务端给出的顺序，便于稳定比较。 */
    static final class Manifest {
        final int schema;
        final String buildId;
        final String assetVersion;
        final String contentVersion;
        final List<FileEntry> files;
        private final Map<String, FileEntry> byPath;

        Manifest(int schema, String buildId, String assetVersion, String contentVersion,
                 List<FileEntry> files) {
            this.schema = schema;
            this.buildId = buildId;
            this.assetVersion = assetVersion;
            this.contentVersion = contentVersion;
            this.files = Collections.unmodifiableList(files);
            Map<String, FileEntry> map = new HashMap<>(files.size() * 2);
            for (FileEntry entry : files) map.put(entry.path, entry);
            this.byPath = Collections.unmodifiableMap(map);
        }

        FileEntry find(String path) {
            return byPath.get(path);
        }

        Set<String> pathSet() {
            return byPath.keySet();
        }
    }

    static Pointer parsePointer(byte[] bytes) throws IOException {
        try {
            JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            int schema = json.optInt("schema", -1);
            if (schema != SCHEMA) throw new IOException("不支持的指针版本: " + schema);

            String buildId = requireString(json, "buildId");
            if (!HEX_16.matcher(buildId).matches()) {
                throw new IOException("buildId 格式不对: " + buildId);
            }

            String builtAt = requireString(json, "builtAt");
            long builtAtMillis;
            try {
                builtAtMillis = Instant.parse(builtAt).toEpochMilli();
            } catch (DateTimeParseException error) {
                throw new IOException("builtAt 不是 ISO8601: " + builtAt, error);
            }

            // 清单地址由 buildId 唯一决定，客户端不允许指针把它指到别处。
            String expectedManifest = "update/" + buildId + ".json";
            String manifest = requireString(json, "manifest");
            if (!expectedManifest.equals(manifest)) {
                throw new IOException("清单地址与 buildId 不一致: " + manifest);
            }

            String manifestSha256 = requireString(json, "manifestSha256");
            if (!HEX_64.matcher(manifestSha256).matches()) {
                throw new IOException("manifestSha256 格式不对");
            }

            int minShell = json.optInt("minShell", -1);
            if (minShell < 1) throw new IOException("minShell 无效: " + minShell);

            return new Pointer(schema, buildId, builtAt, builtAtMillis,
                    manifest, manifestSha256, minShell);
        } catch (JSONException error) {
            throw new IOException("指针 JSON 解析失败", error);
        }
    }

    static Manifest parseManifest(byte[] bytes) throws IOException {
        try {
            JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            int schema = json.optInt("schema", -1);
            if (schema != SCHEMA) throw new IOException("不支持的清单版本: " + schema);

            String buildId = requireString(json, "buildId");
            if (!HEX_16.matcher(buildId).matches()) {
                throw new IOException("清单 buildId 格式不对: " + buildId);
            }

            // 版本元数据不参与路径和哈希校验，允许空值以兼容没有素材版本号的老构建。
            String assetVersion = json.optString("assetVersion", "");
            String contentVersion = json.optString("contentVersion", "");
            if (!assetVersion.isEmpty() && !HEX_16.matcher(assetVersion).matches()) {
                throw new IOException("assetVersion 格式不对");
            }
            if (!contentVersion.isEmpty() && !HEX_16.matcher(contentVersion).matches()) {
                throw new IOException("contentVersion 格式不对");
            }

            JSONArray array = json.optJSONArray("files");
            if (array == null) throw new IOException("清单缺少 files");

            List<FileEntry> files = new ArrayList<>(array.length());
            Set<String> seen = new HashSet<>(array.length() * 2);
            for (int index = 0; index < array.length(); index++) {
                JSONObject item = array.optJSONObject(index);
                if (item == null) throw new IOException("files[" + index + "] 不是对象");

                String path = requireString(item, FIELD_PATH);
                if (!isSafeRelativePath(path)) {
                    throw new IOException("清单路径不安全: " + path);
                }
                if (!seen.add(path)) throw new IOException("清单路径重复: " + path);

                String hash = requireString(item, FIELD_HASH);
                if (!HEX_16.matcher(hash).matches()) {
                    throw new IOException("文件指纹格式不对: " + path);
                }

                long size = item.optLong(FIELD_SIZE, -1);
                if (size < 0) throw new IOException("文件大小无效: " + path);

                files.add(new FileEntry(path, hash, size));
            }

            return new Manifest(schema, buildId, assetVersion, contentVersion, files);
        } catch (JSONException error) {
            throw new IOException("清单 JSON 解析失败", error);
        }
    }

    /**
     * 清单里的路径必须是相对路径，且不能通过 . / .. / 反斜杠 / NUL / 隐藏段逃出
     * 版本目录。这里先挡一次，PathHandler 运行时还会用 canonicalPath 再挡一次。
     */
    static boolean isSafeRelativePath(String path) {
        if (path == null || path.isEmpty()) return false;
        if (path.startsWith("/") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) {
            return false;
        }
        if (path.equals("update") || path.startsWith("update/")) return false;
        String[] segments = path.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return false;
            if (segment.charAt(0) == '.') return false;
        }
        return true;
    }

    static boolean verifySignature(byte[] data, byte[] signatureFile, String publicKeyBase64) {
        if (publicKeyBase64 == null || publicKeyBase64.isEmpty()) return false;
        try {
            byte[] keyDer = Base64.getDecoder().decode(stripWhitespace(publicKeyBase64));
            PublicKey publicKey = KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(keyDer));

            String signatureText = new String(signatureFile, StandardCharsets.US_ASCII);
            byte[] signatureBytes = Base64.getDecoder().decode(stripWhitespace(signatureText));

            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(publicKey);
            verifier.update(data);
            return verifier.verify(signatureBytes);
        } catch (Exception error) {
            return false;
        }
    }

    /** 单文件指纹：SHA-256(相对路径 + NUL + 内容 + NUL)，取前 16 位小写十六进制。 */
    static String fingerprint(File file, String relativePath) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return fingerprint(relativePath, input);
        }
    }

    static String fingerprint(String relativePath, InputStream input) throws IOException {
        MessageDigest digest = sha256();
        digest.update(relativePath.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
        byte[] buffer = new byte[BUFFER_BYTES];
        int read;
        while ((read = input.read(buffer)) != -1) {
            digest.update(buffer, 0, read);
        }
        digest.update((byte) 0);
        return hex(digest.digest()).substring(0, FINGERPRINT_HEX_DIGITS);
    }

    static String sha256Hex(byte[] bytes) {
        return hex(sha256().digest(bytes));
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 不可用", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(Character.forDigit((value >> 4) & 0xf, 16));
            builder.append(Character.forDigit(value & 0xf, 16));
        }
        return builder.toString();
    }

    private static String stripWhitespace(String text) {
        return text.replaceAll("\\s+", "");
    }

    private static String requireString(JSONObject json, String key) throws IOException {
        String value = json.optString(key, null);
        if (value == null || value.isEmpty()) throw new IOException("缺少字段: " + key);
        return value;
    }
}
