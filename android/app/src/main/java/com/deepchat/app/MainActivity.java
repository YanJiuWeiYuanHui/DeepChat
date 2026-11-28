package com.deepchat.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class MainActivity extends BridgeActivity {

    private static final int MAX_LINE_BYTES = 16 * 1024;
    private static final int MAX_HEADERS = 128;
    private static final int MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_BACKUP_SESSION_BYTES = 64 * 1024 * 1024;
    private static final long MAX_SAVE_FILE_BYTES = 256L * 1024 * 1024;
    private static final String STATE_PENDING_SAVE_FILE = "pending_save_file";
    private static final String STATE_PENDING_SAVE_NAME = "pending_save_name";
    private static final String STATE_PENDING_CAMERA_FILE = "pending_camera_file";

    private final Object backupLock = new Object();
    private final Object saveFileLock = new Object();

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
        "host",
        "origin",
        "referer",
        "connection",
        "content-length",
        "transfer-encoding",
        "x-proxy-target",
        "x-proxy-token",
        "accept-encoding",
        "cookie"
    ));

    private final String proxyToken = generateToken();
    private final AtomicBoolean updateDownloading = new AtomicBoolean(false);
    private final Map<String, File> capturedPhotos = new ConcurrentHashMap<>();

    private volatile ServerSocket proxyServer;
    private volatile int proxyPort = -1;
    private ExecutorService proxyPool;

    private volatile String updateStatus = "idle";
    private volatile int updateProgress = 0;
    private volatile long updateDownloaded = 0;
    private volatile long updateTotal = 0;
    private volatile String updateError = "";
    private volatile File downloadedApkFile = null;
    private long lastBackPressAt = 0L;
    private volatile File pendingSaveFile = null;
    private volatile String pendingSaveFileName = "";
    private volatile File pendingCameraFile = null;
    private volatile String pendingReadyPhotoId = null;
    private volatile String pendingReadyPhotoName = null;
    private ActivityResultLauncher<Intent> saveFileLauncher;
    private ActivityResultLauncher<Intent> cameraCaptureLauncher;
    private ActivityResultLauncher<String> cameraPermissionLauncher;

    private static String generateToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static boolean isZhLocale() {
        return Locale.getDefault().getLanguage().toLowerCase(Locale.ROOT).startsWith("zh");
    }

    private static boolean isAllowedApkUrl(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) {
            return false;
        }
        String host = url.getHost();
        if (host == null) {
            return false;
        }
        String lower = host.toLowerCase(Locale.ROOT);
        return "github.com".equals(lower)
            || "objects.githubusercontent.com".equals(lower)
            || lower.endsWith(".githubusercontent.com");
    }

    private static String sanitizeApkName(String fileName) {
        if (fileName == null || fileName.trim().isEmpty()) {
            return "DeepChat-update.apk";
        }
        String cleaned = fileName.trim().replaceAll("[^a-zA-Z0-9._-]", "_").replaceAll("^\\.+", "");
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "DeepChat-update.apk";
        }
        return cleaned;
    }

    public class ProxyBridge {
        @JavascriptInterface
        public String getProxyOrigin() {
            return proxyPort > 0 ? "http://127.0.0.1:" + proxyPort : "";
        }

        @JavascriptInterface
        public String getProxyToken() {
            return proxyToken;
        }

        @JavascriptInterface
        public String getAppInfo() {
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
                String versionName = info.versionName != null ? info.versionName : "1.0.0";
                return "{\"isAndroid\":true,\"versionCode\":" + versionCode
                    + ",\"versionName\":\"" + escapeJson(versionName) + "\"}";
            } catch (Exception e) {
                return "{\"isAndroid\":true,\"versionCode\":1,\"versionName\":\"1.0.0\"}";
            }
        }

        @JavascriptInterface
        public boolean capturePhoto() {
            if (isFinishing() || isDestroyed()) {
                return false;
            }
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                    }
                });
                return true;
            }
            return launchNativeCamera();
        }

        @JavascriptInterface
        public String consumePendingNativePhoto() {
            String id = pendingReadyPhotoId;
            String name = pendingReadyPhotoName;
            pendingReadyPhotoId = null;
            pendingReadyPhotoName = null;
            if (id == null || id.isEmpty() || !capturedPhotos.containsKey(id)) {
                return "";
            }
            return "{\"id\":\"" + escapeJson(id) + "\",\"name\":\"" + escapeJson(name != null ? name : "photo.jpg") + "\"}";
        }

        @JavascriptInterface
        public void downloadAndInstallApk(String apkUrl, String fileName) {
            if (!updateDownloading.compareAndSet(false, true)) {
                return;
            }
            URL initialUrl;
            try {
                initialUrl = new URL(apkUrl);
            } catch (Exception e) {
                updateStatus = "error";
                updateError = "Invalid APK URL";
                updateDownloading.set(false);
                return;
            }
            if (!isAllowedApkUrl(initialUrl)) {
                updateStatus = "error";
                updateError = "Untrusted APK URL";
                updateDownloading.set(false);
                return;
            }
            updateStatus = "downloading";
            updateProgress = 0;
            updateDownloaded = 0;
            updateTotal = 0;
            updateError = "";
            downloadedApkFile = null;

            final String safeName = sanitizeApkName(fileName);

            Thread downloadThread = new Thread(() -> {
                HttpURLConnection conn = null;
                File tempFile = null;
                try {
                    File updateDir = new File(getCacheDir(), "updates");
                    if (!updateDir.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        updateDir.mkdirs();
                    }
                    File[] oldFiles = updateDir.listFiles();
                    if (oldFiles != null) {
                        for (File old : oldFiles) {
                            if (!old.getName().equals(safeName)) {
                                //noinspection ResultOfMethodCallIgnored
                                old.delete();
                            }
                        }
                    }
                    tempFile = new File(updateDir, safeName + ".part");
                    File finalFile = new File(updateDir, safeName);

                    URL currentUrl = initialUrl;
                    int redirects = 0;
                    while (true) {
                        if (!isAllowedApkUrl(currentUrl)) {
                            throw new IOException("Untrusted APK redirect URL");
                        }
                        conn = (HttpURLConnection) currentUrl.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(60000);
                        conn.setRequestProperty("User-Agent", "DeepChat-Android");
                        int code = conn.getResponseCode();
                        if (code >= 300 && code < 400 && redirects < 8) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            conn = null;
                            if (loc == null || loc.isEmpty()) {
                                throw new IOException("Redirect without location");
                            }
                            currentUrl = new URL(currentUrl, loc);
                            redirects++;
                            continue;
                        }
                        if (code < 200 || code >= 300) {
                            throw new IOException("HTTP " + code);
                        }
                        break;
                    }

                    long total = conn.getContentLengthLong();
                    updateTotal = Math.max(0, total);
                    try (
                        InputStream in = new BufferedInputStream(conn.getInputStream());
                        FileOutputStream fileOut = new FileOutputStream(tempFile)
                    ) {
                        byte[] buf = new byte[16384];
                        long downloaded = 0;
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            fileOut.write(buf, 0, n);
                            downloaded += n;
                            updateDownloaded = downloaded;
                            if (total > 0) {
                                updateProgress = (int) Math.min(100, (downloaded * 100L) / total);
                            }
                        }
                        fileOut.flush();
                    }
                    if (finalFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        finalFile.delete();
                    }
                    if (!tempFile.renameTo(finalFile)) {
                        throw new IOException("Failed to prepare APK file");
                    }
                    tempFile = null;
                    downloadedApkFile = finalFile;
                    updateProgress = 100;
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) {
                            triggerApkInstall(finalFile);
                        }
                    });
                } catch (Exception e) {
                    if (tempFile != null && tempFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        tempFile.delete();
                    }
                    updateStatus = "error";
                    updateError = e.getMessage() != null ? e.getMessage() : "Download failed";
                } finally {
                    updateDownloading.set(false);
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            }, "DeepChatApkDownloader");
            downloadThread.setDaemon(true);
            downloadThread.start();
        }

        @JavascriptInterface
        public String getUpdateDownloadState() {
            return "{\"status\":\"" + escapeJson(updateStatus) + "\""
                + ",\"progress\":" + updateProgress
                + ",\"downloaded\":" + updateDownloaded
                + ",\"total\":" + updateTotal
                + ",\"error\":\"" + escapeJson(updateError) + "\""
                + ",\"hasDownloadedFile\":" + (downloadedApkFile != null && downloadedApkFile.exists())
                + "}";
        }

        @JavascriptInterface
        public void retryInstallDownloadedApk() {
            final File file = downloadedApkFile;
            if (file != null && file.exists()) {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        triggerApkInstall(file);
                    }
                });
            }
        }
    }

    private boolean launchNativeCamera() {
        try {
            File picturesDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if (picturesDir == null) {
                picturesDir = new File(getCacheDir(), "Pictures");
            }
            if (!picturesDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                picturesDir.mkdirs();
            }
            File photoFile = File.createTempFile("IMG_" + System.currentTimeMillis() + "_", ".jpg", picturesDir);
            Uri photoUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            intent.setClipData(android.content.ClipData.newRawUri("", photoUri));
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            pendingCameraFile = photoFile;
            runOnUiThread(() -> {
                try {
                    if (!isFinishing() && !isDestroyed()) {
                        cameraCaptureLauncher.launch(intent);
                    }
                } catch (ActivityNotFoundException e) {
                    if (pendingCameraFile != null && pendingCameraFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        pendingCameraFile.delete();
                    }
                    pendingCameraFile = null;
                    Toast.makeText(
                        this,
                        isZhLocale() ? "未找到可用相机应用" : "No camera app found",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            });
            return true;
        } catch (Exception e) {
            if (pendingCameraFile != null && pendingCameraFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                pendingCameraFile.delete();
            }
            pendingCameraFile = null;
            return false;
        }
    }

    private void triggerApkInstall(File apkFile) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
                updateStatus = "permission_required";
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(permIntent);
                return;
            }
            Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            updateStatus = "installing";
            startActivity(installIntent);
        } catch (Exception e) {
            updateStatus = "error";
            updateError = e.getMessage() != null ? e.getMessage() : "Install failed";
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", " ")
            .replace("\n", " ");
    }

    private static String stripCrLf(String value) {
        return value == null ? "" : value.replace("\r", "").replace("\n", " ");
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        final File pending;
        final String name;
        synchronized (saveFileLock) {
            pending = pendingSaveFile;
            name = pendingSaveFileName;
        }
        if (pending != null) {
            outState.putString(STATE_PENDING_SAVE_FILE, pending.getAbsolutePath());
            outState.putString(STATE_PENDING_SAVE_NAME, name);
        }
        File camFile = pendingCameraFile;
        if (camFile != null) {
            outState.putString(STATE_PENDING_CAMERA_FILE, camFile.getAbsolutePath());
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null) {
            String path = savedInstanceState.getString(STATE_PENDING_SAVE_FILE);
            if (path != null) {
                synchronized (saveFileLock) {
                    pendingSaveFile = new File(path);
                    pendingSaveFileName = savedInstanceState.getString(STATE_PENDING_SAVE_NAME, "");
                }
            }
            String camPath = savedInstanceState.getString(STATE_PENDING_CAMERA_FILE);
            if (camPath != null && !camPath.isEmpty()) {
                pendingCameraFile = new File(camPath);
            }
        }
        cameraPermissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            granted -> {
                if (granted) {
                    launchNativeCamera();
                } else {
                    Toast.makeText(
                        this,
                        isZhLocale() ? "未授予相机权限，请在系统设置中开启" : "Camera permission denied",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            }
        );
        cameraCaptureLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                try {
                    final File photoFile = pendingCameraFile;
                    pendingCameraFile = null;
                    if (result != null
                        && result.getResultCode() == Activity.RESULT_OK
                        && photoFile != null
                        && photoFile.exists()
                        && photoFile.length() > 0) {
                        final String id = UUID.randomUUID().toString();
                        final String fileName = photoFile.getName();
                        capturedPhotos.put(id, photoFile);
                        pendingReadyPhotoId = id;
                        pendingReadyPhotoName = fileName;
                        runOnUiThread(() -> {
                            try {
                                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                                if (webView != null && !isFinishing() && !isDestroyed()) {
                                    String js = "window.__deepchatOnNativePhoto && window.__deepchatOnNativePhoto(\""
                                        + escapeJson(id) + "\",\"" + escapeJson(fileName) + "\");";
                                    webView.evaluateJavascript(js, null);
                                }
                            } catch (Throwable ignored) {
                                // 若 Activity 刚重建 WebView 尚未挂载，前端启动后会通过 consumePendingNativePhoto() 拉取
                            }
                        });
                    } else if (photoFile != null && photoFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        photoFile.delete();
                    }
                } catch (Throwable ignored) {
                    // 防止相机返回时因低内存重建或 OEM 异常导致闪退
                }
            }
        );
        saveFileLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                final File src;
                final String name;
                synchronized (saveFileLock) {
                    src = pendingSaveFile;
                    name = pendingSaveFileName;
                    pendingSaveFile = null;
                    pendingSaveFileName = "";
                }
                if (result.getResultCode() == Activity.RESULT_OK
                    && result.getData() != null
                    && result.getData().getData() != null
                    && src != null
                    && src.exists()) {
                    final Uri destUri = result.getData().getData();
                    new Thread(() -> {
                        try (
                            InputStream fis = new FileInputStream(src);
                            OutputStream os = getContentResolver().openOutputStream(destUri)
                        ) {
                            if (os != null) {
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = fis.read(buf)) != -1) {
                                    os.write(buf, 0, n);
                                }
                                os.flush();
                            }
                            runOnUiThread(() -> {
                                if (!isFinishing() && !isDestroyed()) {
                                    String msg = isZhLocale() ? "已保存：" + name : "Saved: " + name;
                                    Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                                }
                            });
                        } catch (Exception e) {
                            runOnUiThread(() -> {
                                if (!isFinishing() && !isDestroyed()) {
                                    String msg = isZhLocale() ? "保存失败：" + e.getMessage() : "Save failed: " + e.getMessage();
                                    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
                                }
                            });
                        } finally {
                            //noinspection ResultOfMethodCallIgnored
                            src.delete();
                        }
                    }, "DeepChatSavePicker").start();
                } else if (src != null && src.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    src.delete();
                }
            }
        );
        startLocalProxy();
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new ProxyBridge(), "__DEEPCHAT_ANDROID_BRIDGE__");
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    handleRootBackPress();
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){try{return !!(window.__deepchatHandleAndroidBack && window.__deepchatHandleAndroidBack());}catch(e){return false;}})()",
                    value -> {
                        if (isFinishing() || isDestroyed()) {
                            return;
                        }
                        if ("true".equals(value)) {
                            return;
                        }
                        if (webView.canGoBack()) {
                            webView.goBack();
                            return;
                        }
                        handleRootBackPress();
                    }
                );
            }
        });
    }

    private void handleRootBackPress() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressAt <= 2000L) {
            finish();
            return;
        }
        lastBackPressAt = now;
        Toast.makeText(
            this,
            isZhLocale() ? "再按一次退出 DeepChat" : "Press back again to exit DeepChat",
            Toast.LENGTH_SHORT
        ).show();
    }

    @Override
    public void onDestroy() {
        stopLocalProxy();
        if (isFinishing()) {
            for (File photo : capturedPhotos.values()) {
                if (photo != null && photo.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    photo.delete();
                }
            }
            capturedPhotos.clear();
            if (pendingCameraFile != null && pendingCameraFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                pendingCameraFile.delete();
                pendingCameraFile = null;
            }
        }
        super.onDestroy();
    }

    private void startLocalProxy() {
        try {
            ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            proxyServer = server;
            proxyPort = server.getLocalPort();
            proxyPool = Executors.newFixedThreadPool(16);
            Thread acceptThread = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket client = server.accept();
                        proxyPool.submit(() -> handleClient(client));
                    } catch (IOException ignored) {
                        break;
                    }
                }
            }, "DeepChatLocalProxy");
            acceptThread.setDaemon(true);
            acceptThread.start();
        } catch (IOException ignored) {
            proxyPort = -1;
        }
    }

    private void stopLocalProxy() {
        try {
            if (proxyServer != null) {
                proxyServer.close();
            }
        } catch (IOException ignored) {
        }
        if (proxyPool != null) {
            proxyPool.shutdownNow();
        }
    }

    private static String resolveAllowedOrigin(Map<String, List<String>> headers) {
        List<String> origins = headers.get("origin");
        if (origins == null || origins.isEmpty()) {
            return "https://localhost";
        }
        String origin = origins.get(0);
        if (origin == null) {
            return null;
        }
        String lower = origin.trim().toLowerCase(Locale.ROOT);
        if ("https://localhost".equals(lower)
            || "http://localhost".equals(lower)
            || "capacitor://localhost".equals(lower)
            || lower.startsWith("http://127.0.0.1:")
            || "http://127.0.0.1".equals(lower)) {
            return stripCrLf(origin.trim());
        }
        return null;
    }

    private boolean isAuthorizedToken(Map<String, List<String>> headers) {
        List<String> tokens = headers.get("x-proxy-token");
        if (tokens == null || tokens.isEmpty()) {
            return false;
        }
        String supplied = tokens.get(0);
        if (supplied == null) {
            return false;
        }
        return MessageDigest.isEqual(
            supplied.getBytes(StandardCharsets.UTF_8),
            proxyToken.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static byte[] readChunkedBody(BufferedInputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(in);
            if (sizeLine == null) {
                break;
            }
            int semi = sizeLine.indexOf(';');
            String hex = (semi >= 0 ? sizeLine.substring(0, semi) : sizeLine).trim();
            if (hex.isEmpty()) {
                continue;
            }
            int chunkSize = Integer.parseInt(hex, 16);
            if (chunkSize == 0) {
                String trailer;
                while ((trailer = readLine(in)) != null && !trailer.isEmpty()) {
                    // consume trailers
                }
                break;
            }
            if (out.size() + chunkSize > maxBytes) {
                throw new IOException("Request body too large");
            }
            byte[] buf = new byte[Math.min(16384, chunkSize)];
            int remaining = chunkSize;
            while (remaining > 0) {
                int r = in.read(buf, 0, Math.min(buf.length, remaining));
                if (r < 0) {
                    throw new IOException("Unexpected EOF in chunked body");
                }
                out.write(buf, 0, r);
                remaining -= r;
            }
            readLine(in); // CRLF after chunk
        }
        return out.toByteArray();
    }

    private void handleClient(Socket client) {
        boolean headersSent = false;
        String corsOrigin = "https://localhost";
        try (Socket socket = client) {
            socket.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.ROOT) : "GET";
            String requestPath = parts.length > 1 ? parts[1] : "/";

            Map<String, List<String>> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            long contentLength = 0L;
            boolean isChunked = false;
            int headerCount = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                if (++headerCount > MAX_HEADERS) {
                    sendJsonError(out, 431, "Too many headers", corsOrigin);
                    return;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    String value = line.substring(colon + 1).trim();
                    headers.computeIfAbsent(name, k -> new ArrayList<>()).add(value);
                    if ("content-length".equalsIgnoreCase(name)) {
                        try {
                            contentLength = Math.max(0L, Long.parseLong(value));
                        } catch (NumberFormatException ignored) {
                        }
                    } else if ("transfer-encoding".equalsIgnoreCase(name)
                        && value.toLowerCase(Locale.ROOT).contains("chunked")) {
                        isChunked = true;
                    }
                }
            }

            String matchedOrigin = resolveAllowedOrigin(headers);
            if (matchedOrigin == null) {
                sendJsonError(out, 403, "Forbidden origin", "https://localhost");
                return;
            }
            corsOrigin = matchedOrigin;

            if ("OPTIONS".equals(method)) {
                String cors = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
                    + "Vary: Origin\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: *\r\n"
                    + "Access-Control-Expose-Headers: *\r\n"
                    + "Access-Control-Max-Age: 86400\r\n"
                    + "x-local-proxy: 1\r\n"
                    + "Connection: close\r\n\r\n";
                out.write(cors.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return;
            }

            if (!isAuthorizedToken(headers)) {
                sendJsonError(out, 403, "Invalid proxy token", corsOrigin);
                return;
            }

            if ("GET".equals(method) && requestPath.startsWith("/__deepchat_captured_photo")) {
                handleCapturedPhotoRequest(requestPath, out, corsOrigin);
                return;
            }

            if (requestPath.startsWith("/__deepchat_backup/")) {
                handleBackupRequest(method, requestPath, contentLength, isChunked, in, out, corsOrigin);
                return;
            }

            if ("POST".equals(method) && requestPath.startsWith("/__deepchat_save_file")) {
                if (contentLength > MAX_SAVE_FILE_BYTES) {
                    sendJsonError(out, 413, "File too large", corsOrigin);
                    return;
                }
                handleSaveFileRequest(requestPath, contentLength, in, out, corsOrigin);
                return;
            }

            if ("POST".equals(method) && requestPath.startsWith("/__deepchat_share_image")) {
                if (contentLength > 64L * 1024 * 1024) {
                    sendJsonError(out, 413, "Image too large", corsOrigin);
                    return;
                }
                handleShareImageRequest(requestPath, contentLength, in, out, corsOrigin);
                return;
            }

            byte[] body;
            if (isChunked) {
                body = readChunkedBody(in, MAX_PROXY_BODY_BYTES);
            } else {
                if (contentLength > MAX_PROXY_BODY_BYTES) {
                    sendJsonError(out, 413, "Request body too large", corsOrigin);
                    return;
                }
                int bodyLen = (int) contentLength;
                body = new byte[bodyLen];
                int offset = 0;
                while (offset < bodyLen) {
                    int read = in.read(body, offset, bodyLen - offset);
                    if (read < 0) {
                        break;
                    }
                    offset += read;
                }
                if (offset < bodyLen) {
                    body = Arrays.copyOf(body, offset);
                }
            }

            List<String> targets = headers.get("x-proxy-target");
            String targetUrlStr = (targets != null && !targets.isEmpty()) ? targets.get(0) : null;
            if (targetUrlStr == null || !(targetUrlStr.startsWith("http://") || targetUrlStr.startsWith("https://"))) {
                sendJsonError(out, 400, "Missing or invalid x-proxy-target header", corsOrigin);
                return;
            }

            URL currentUrl = new URL(targetUrlStr);
            HttpURLConnection conn = null;
            try {
                int redirects = 0;
                String activeMethod = method;
                byte[] activeBody = body;
                while (true) {
                    conn = (HttpURLConnection) currentUrl.openConnection();
                    conn.setRequestMethod(activeMethod);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(120000);
                    conn.setRequestProperty("Accept-Encoding", "identity");

                    boolean crossHost = !currentUrl.getHost().equalsIgnoreCase(new URL(targetUrlStr).getHost());
                    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                        String keyLower = entry.getKey().toLowerCase(Locale.ROOT);
                        if (HOP_BY_HOP.contains(keyLower)) {
                            continue;
                        }
                        if (crossHost && "authorization".equals(keyLower)) {
                            continue;
                        }
                        for (String val : entry.getValue()) {
                            conn.addRequestProperty(entry.getKey(), val);
                        }
                    }

                    if (activeBody.length > 0 && !"GET".equals(activeMethod) && !"HEAD".equals(activeMethod)) {
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(activeBody.length);
                        try (OutputStream reqOut = conn.getOutputStream()) {
                            reqOut.write(activeBody);
                            reqOut.flush();
                        }
                    }

                    int code = conn.getResponseCode();
                    if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && redirects < 6) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.isEmpty()) {
                            break;
                        }
                        URL nextUrl = new URL(currentUrl, loc);
                        if (!("http".equalsIgnoreCase(nextUrl.getProtocol()) || "https".equalsIgnoreCase(nextUrl.getProtocol()))) {
                            throw new IOException("Unsupported redirect protocol");
                        }
                        if (code == 303 || ((code == 301 || code == 302) && "POST".equals(activeMethod))) {
                            activeMethod = "GET";
                            activeBody = new byte[0];
                        }
                        currentUrl = nextUrl;
                        redirects++;
                        continue;
                    }
                    break;
                }

                if (conn == null) {
                    sendJsonError(out, 502, "Invalid upstream redirect", corsOrigin);
                    return;
                }

                int status = conn.getResponseCode();
                String reason = stripCrLf(conn.getResponseMessage());
                if (reason.isEmpty()) {
                    reason = "OK";
                }

                boolean noBody = "HEAD".equals(activeMethod) || status == 204 || status == 304 || (status >= 100 && status < 200);
                StringBuilder respHeaders = new StringBuilder();
                respHeaders.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
                respHeaders.append("Access-Control-Allow-Origin: ").append(corsOrigin).append("\r\n");
                respHeaders.append("Vary: Origin\r\n");
                respHeaders.append("Access-Control-Expose-Headers: *\r\n");
                respHeaders.append("x-local-proxy: 1\r\n");
                respHeaders.append("Connection: close\r\n");

                for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                    String key = entry.getKey();
                    if (key == null) {
                        continue;
                    }
                    String lower = key.toLowerCase(Locale.ROOT);
                    if (
                        "transfer-encoding".equals(lower)
                        || "content-length".equals(lower)
                        || "content-encoding".equals(lower)
                        || "connection".equals(lower)
                        || "vary".equals(lower)
                        || lower.startsWith("access-control-")
                    ) {
                        continue;
                    }
                    String safeKey = stripCrLf(key);
                    for (String value : entry.getValue()) {
                        respHeaders.append(safeKey).append(": ").append(stripCrLf(value)).append("\r\n");
                    }
                }
                if (!noBody) {
                    respHeaders.append("Transfer-Encoding: chunked\r\n");
                }
                respHeaders.append("\r\n");
                out.write(respHeaders.toString().getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                headersSent = true;

                if (!noBody) {
                    InputStream upstream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    if (upstream == null && status < 400) {
                        upstream = conn.getErrorStream();
                    }
                    if (upstream != null) {
                        try (InputStream stream = upstream) {
                            byte[] buf = new byte[4096];
                            int n;
                            while ((n = stream.read(buf)) != -1) {
                                if (n > 0) {
                                    out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.US_ASCII));
                                    out.write(buf, 0, n);
                                    out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
                                    out.flush();
                                }
                            }
                        }
                    }
                    out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                }
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        } catch (Exception e) {
            if (!headersSent) {
                try {
                    sendJsonError(
                        client.getOutputStream(),
                        502,
                        e.getMessage() != null ? e.getMessage() : "Proxy failed",
                        corsOrigin
                    );
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void handleCapturedPhotoRequest(String requestPath, OutputStream out, String corsOrigin) throws IOException {
        String id = null;
        int qIndex = requestPath.indexOf('?');
        if (qIndex >= 0) {
            String query = requestPath.substring(qIndex + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && "id".equals(URLDecoder.decode(pair.substring(0, eq), "UTF-8"))) {
                    id = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    break;
                }
            }
        }
        File file = id != null ? capturedPhotos.remove(id) : null;
        if (file == null || !file.exists()) {
            sendJsonError(out, 404, "Photo not found", corsOrigin);
            return;
        }
        try {
            long len = file.length();
            String header = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: image/jpeg\r\n"
                + "Content-Length: " + len + "\r\n"
                + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
                + "Vary: Origin\r\n"
                + "Access-Control-Expose-Headers: *\r\n"
                + "x-local-proxy: 1\r\n"
                + "Connection: close\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
            out.flush();
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static String readLine(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                break;
            }
            if (b != '\r') {
                if (buf.size() >= MAX_LINE_BYTES) {
                    throw new IOException("HTTP header line too long");
                }
                buf.write(b);
            }
        }
        if (b == -1 && buf.size() == 0) {
            return null;
        }
        return buf.toString(StandardCharsets.ISO_8859_1.name());
    }

    private void handleSaveFileRequest(
        String requestPath,
        long contentLength,
        BufferedInputStream in,
        OutputStream out,
        String corsOrigin
    ) throws IOException {
        String fileName = "deepchat-export.bin";
        String mimeType = "application/octet-stream";
        int qIndex = requestPath.indexOf('?');
        if (qIndex >= 0) {
            String query = requestPath.substring(qIndex + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    String key = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String val = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    if ("name".equals(key) && !val.trim().isEmpty()) {
                        fileName = val.trim();
                    } else if ("mime".equals(key) && !val.trim().isEmpty()) {
                        mimeType = val.trim();
                    }
                }
            }
        }
        final String safeName = fileName.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_");
        File exportDir = new File(getCacheDir(), "exports");
        if (!exportDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            exportDir.mkdirs();
        }
        File tempFile = new File(exportDir, System.currentTimeMillis() + "_" + safeName);
        boolean handedOff = false;
        try {
            byte[] buf = new byte[16384];
            long remaining = contentLength;
            try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                while (remaining > 0L) {
                    int toRead = (int) Math.min(buf.length, remaining);
                    int read = in.read(buf, 0, toRead);
                    if (read < 0) {
                        throw new IOException("Unexpected EOF in save file body");
                    }
                    fos.write(buf, 0, read);
                    remaining -= read;
                }
                fos.flush();
            }

            saveTempFileToDownloads(tempFile, safeName, mimeType, out, corsOrigin);
            handedOff = true;
        } finally {
            boolean ownedByPicker;
            synchronized (saveFileLock) {
                ownedByPicker = pendingSaveFile == tempFile;
            }
            if (!handedOff && !ownedByPicker && tempFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tempFile.delete();
            }
        }
    }

    private void handleShareImageRequest(
        String requestPath,
        long contentLength,
        BufferedInputStream in,
        OutputStream out,
        String corsOrigin
    ) throws IOException {
        String fileName = "deepchat-share.jpg";
        String mimeType = "image/jpeg";
        int qIndex = requestPath.indexOf('?');
        if (qIndex >= 0) {
            String query = requestPath.substring(qIndex + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    String key = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String val = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    if ("name".equals(key) && !val.trim().isEmpty()) {
                        fileName = val.trim();
                    } else if ("mime".equals(key) && !val.trim().isEmpty()) {
                        mimeType = val.trim();
                    }
                }
            }
        }
        String safeName = fileName.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_");
        String lowerName = safeName.toLowerCase(Locale.ROOT);
        if (!lowerName.endsWith(".jpg") && !lowerName.endsWith(".jpeg") && !lowerName.endsWith(".png")) {
            safeName = safeName + ("image/png".equalsIgnoreCase(mimeType) ? ".png" : ".jpg");
        }
        File shareDir = new File(getCacheDir(), "share");
        if (!shareDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            shareDir.mkdirs();
        }
        File[] oldFiles = shareDir.listFiles();
        if (oldFiles != null && oldFiles.length > 5) {
            Arrays.sort(oldFiles, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (int i = 0; i < oldFiles.length - 5; i++) {
                //noinspection ResultOfMethodCallIgnored
                oldFiles[i].delete();
            }
        }
        File shareFile = new File(shareDir, System.currentTimeMillis() + "_" + safeName);
        byte[] buf = new byte[16384];
        long remaining = contentLength;
        try (FileOutputStream fos = new FileOutputStream(shareFile)) {
            while (remaining > 0L) {
                int toRead = (int) Math.min(buf.length, remaining);
                int read = in.read(buf, 0, toRead);
                if (read < 0) {
                    throw new IOException("Unexpected EOF in share image body");
                }
                fos.write(buf, 0, read);
                remaining -= read;
            }
            fos.flush();
        }
        try {
            Uri shareUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", shareFile);
            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType(mimeType);
            shareIntent.putExtra(Intent.EXTRA_STREAM, shareUri);
            shareIntent.setClipData(android.content.ClipData.newRawUri("", shareUri));
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(
                shareIntent,
                isZhLocale() ? "分享对话图片" : "Share chat image"
            );
            runOnUiThread(() -> {
                try {
                    if (!isFinishing() && !isDestroyed()) {
                        startActivity(chooser);
                    }
                } catch (Throwable ignored) {
                    Toast.makeText(
                        this,
                        isZhLocale() ? "未找到可分享的应用" : "No share target available",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            });
            sendJsonOk(out, "{\"ok\":true}", corsOrigin);
        } catch (Exception e) {
            sendJsonError(out, 500, "Failed to share image: " + e.getMessage(), corsOrigin);
        }
    }

    private void saveTempFileToDownloads(
        File tempFile,
        String safeName,
        String mimeType,
        OutputStream out,
        String corsOrigin
    ) throws IOException {
        long fileBytes = tempFile.length();
        byte[] buf = new byte[16384];
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri insertedUri = null;
            ContentResolver resolver = getContentResolver();
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DeepChat");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                insertedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (insertedUri != null) {
                    try (
                        InputStream fis = new FileInputStream(tempFile);
                        OutputStream dest = resolver.openOutputStream(insertedUri)
                    ) {
                        if (dest == null) {
                            throw new IOException("Cannot open download output stream");
                        }
                        int n;
                        while ((n = fis.read(buf)) != -1) {
                            dest.write(buf, 0, n);
                        }
                        dest.flush();
                    }
                    values.clear();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(insertedUri, values, null, null);
                    //noinspection ResultOfMethodCallIgnored
                    tempFile.delete();
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) {
                            String msg = isZhLocale()
                                ? "已保存到「下载/DeepChat/" + safeName + "」"
                                : "Saved to Download/DeepChat/" + safeName;
                            Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                    sendJsonOk(
                        out,
                        "{\"ok\":true,\"mode\":\"android\",\"fileName\":\""
                            + escapeJson(safeName)
                            + "\",\"bytes\":"
                            + fileBytes
                            + "}",
                        corsOrigin
                    );
                    return;
                }
            } catch (Exception ignored) {
                if (insertedUri != null) {
                    try {
                        resolver.delete(insertedUri, null, null);
                    } catch (Exception deleteIgnored) {
                        // ignore cleanup failure
                    }
                }
                // 回退到系统文档保存选择器
            }
        }

        synchronized (saveFileLock) {
            if (pendingSaveFile != null && pendingSaveFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                pendingSaveFile.delete();
            }
            pendingSaveFile = tempFile;
            pendingSaveFileName = safeName;
        }
        final String finalMime = mimeType;
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(finalMime);
                intent.putExtra(Intent.EXTRA_TITLE, safeName);
                saveFileLauncher.launch(intent);
            } else {
                synchronized (saveFileLock) {
                    if (pendingSaveFile == tempFile) {
                        pendingSaveFile = null;
                        pendingSaveFileName = "";
                    }
                }
                if (tempFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    tempFile.delete();
                }
            }
        });
        sendJsonOk(
            out,
            "{\"ok\":true,\"mode\":\"picker\",\"fileName\":\""
                + escapeJson(safeName)
                + "\",\"bytes\":"
                + fileBytes
                + "}",
            corsOrigin
        );
    }

    private static String getQueryParam(String requestPath, String targetKey) {
        int qIndex = requestPath.indexOf('?');
        if (qIndex < 0) {
            return null;
        }
        String query = requestPath.substring(qIndex + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                try {
                    String key = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    if (targetKey.equals(key)) {
                        return URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    }
                } catch (Exception ignored) {
                    // ignore malformed query encoding
                }
            }
        }
        return null;
    }

    private static String stripQuery(String requestPath) {
        int qIndex = requestPath.indexOf('?');
        return qIndex >= 0 ? requestPath.substring(0, qIndex) : requestPath;
    }

    private static String sanitizeBackupSessionId(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 128) {
            return null;
        }
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z')
                || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c == '-'
                || c == '_';
            if (!ok) {
                return null;
            }
        }
        return raw;
    }

    private File getBackupDir() {
        File dir = new File(getFilesDir(), "chat_backup");
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    private static boolean isSymbolicLink(File file) {
        if (file == null) {
            return false;
        }
        try {
            return OsConstants.S_ISLNK(Os.lstat(file.getPath()).st_mode);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void measureDirStats(File target, int depth, long[] outBytesAndFiles) {
        if (target == null || depth > 14 || !target.exists() || isSymbolicLink(target)) {
            return;
        }
        if (target.isFile()) {
            outBytesAndFiles[0] += Math.max(0L, target.length());
            outBytesAndFiles[1] += 1L;
            return;
        }
        File[] children = target.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            measureDirStats(child, depth + 1, outBytesAndFiles);
        }
    }

    private static void collectIndexedDbRoots(File dir, String relPrefix, int depth, List<File> outDirs, List<String> outNames) {
        if (dir == null || depth > 5 || !dir.isDirectory() || isSymbolicLink(dir)) {
            return;
        }
        String name = dir.getName();
        String rel = relPrefix.isEmpty() ? name : relPrefix + "/" + name;
        if ("IndexedDB".equals(name)) {
            outDirs.add(dir);
            outNames.add(rel);
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (child.isDirectory()) {
                collectIndexedDbRoots(child, rel, depth + 1, outDirs, outNames);
            }
        }
    }

    private static void collectAllIndexedDbRoots(File dataDir, List<File> outDirs, List<String> outNames) {
        if (dataDir == null || !dataDir.isDirectory()) {
            return;
        }
        File[] topEntries = dataDir.listFiles();
        if (topEntries == null) {
            return;
        }
        Arrays.sort(topEntries, (a, b) -> a.getName().compareTo(b.getName()));
        for (File entry : topEntries) {
            if (entry.isDirectory() && entry.getName().toLowerCase(Locale.ROOT).contains("webview")) {
                collectIndexedDbRoots(entry, "", 0, outDirs, outNames);
            }
        }
    }

    private static void addDirectoryToZip(
        ZipOutputStream zos,
        File dir,
        String zipPrefix,
        int depth,
        List<String> skipped,
        long[] statsOut
    ) throws IOException {
        if (dir == null || depth > 14 || !dir.exists() || isSymbolicLink(dir)) {
            return;
        }
        if (dir.isFile()) {
            if ("LOCK".equals(dir.getName())) {
                return;
            }
            InputStream fis;
            try {
                fis = new BufferedInputStream(new FileInputStream(dir));
            } catch (IOException e) {
                skipped.add(zipPrefix + ": " + (e.getMessage() != null ? e.getMessage() : "read error"));
                return;
            }
            byte[] buf = new byte[16384];
            long copied = 0L;
            boolean entryOpen = false;
            boolean readFailed = false;
            try (InputStream stream = fis) {
                ZipEntry entry = new ZipEntry(zipPrefix);
                zos.putNextEntry(entry);
                entryOpen = true;
                while (true) {
                    int r;
                    try {
                        r = stream.read(buf);
                    } catch (IOException readError) {
                        readFailed = true;
                        skipped.add(
                            zipPrefix
                                + ": "
                                + (readError.getMessage() != null ? readError.getMessage() : "read error")
                        );
                        break;
                    }
                    if (r == -1) {
                        break;
                    }
                    zos.write(buf, 0, r);
                    copied += r;
                }
                zos.closeEntry();
                entryOpen = false;
                if (!readFailed) {
                    statsOut[0] += 1L;
                }
                statsOut[1] += copied;
            } finally {
                if (entryOpen) {
                    try {
                        zos.closeEntry();
                    } catch (IOException ignored) {
                        // ignore closeEntry failure when stream is already broken
                    }
                }
            }
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            String nextPrefix = zipPrefix.isEmpty() ? child.getName() : zipPrefix + "/" + child.getName();
            addDirectoryToZip(zos, child, nextPrefix, depth + 1, skipped, statsOut);
        }
    }

    private void handleBackupRequest(
        String method,
        String requestPath,
        long contentLength,
        boolean isChunked,
        BufferedInputStream in,
        OutputStream out,
        String corsOrigin
    ) throws IOException {
        String path = stripQuery(requestPath);
        if ("/__deepchat_backup/xray".equals(path) && "GET".equals(method)) {
            File dataDir = getFilesDir().getParentFile();
            long totalDataBytes = 0L;
            StringBuilder foldersJson = new StringBuilder();
            StringBuilder idbJson = new StringBuilder();

            if (dataDir != null && dataDir.isDirectory()) {
                File[] topEntries = dataDir.listFiles();
                if (topEntries != null) {
                    Arrays.sort(topEntries, (a, b) -> a.getName().compareTo(b.getName()));
                    for (File entry : topEntries) {
                        long[] stats = new long[2];
                        measureDirStats(entry, 0, stats);
                        totalDataBytes += stats[0];
                        if (stats[0] <= 0L && stats[1] <= 0L) {
                            continue;
                        }
                        if (foldersJson.length() > 0) {
                            foldersJson.append(',');
                        }
                        foldersJson
                            .append("{\"name\":\"")
                            .append(escapeJson(entry.getName()))
                            .append("\",\"bytes\":")
                            .append(stats[0])
                            .append(",\"files\":")
                            .append(stats[1])
                            .append('}');
                    }
                }

                List<File> idbRoots = new ArrayList<>();
                List<String> idbNames = new ArrayList<>();
                collectAllIndexedDbRoots(dataDir, idbRoots, idbNames);
                for (int i = 0; i < idbRoots.size(); i++) {
                    File idbRoot = idbRoots.get(i);
                    String idbRel = idbNames.get(i);
                    File[] subEntries = idbRoot.listFiles();
                    if (subEntries == null || subEntries.length == 0) {
                        long[] stats = new long[2];
                        measureDirStats(idbRoot, 0, stats);
                        if (idbJson.length() > 0) {
                            idbJson.append(',');
                        }
                        idbJson
                            .append("{\"name\":\"")
                            .append(escapeJson(idbRel))
                            .append("\",\"bytes\":")
                            .append(stats[0])
                            .append(",\"files\":")
                            .append(stats[1])
                            .append('}');
                        continue;
                    }
                    Arrays.sort(subEntries, (a, b) -> a.getName().compareTo(b.getName()));
                    for (File sub : subEntries) {
                        long[] stats = new long[2];
                        measureDirStats(sub, 0, stats);
                        if (idbJson.length() > 0) {
                            idbJson.append(',');
                        }
                        idbJson
                            .append("{\"name\":\"")
                            .append(escapeJson(idbRel + "/" + sub.getName()))
                            .append("\",\"bytes\":")
                            .append(stats[0])
                            .append(",\"files\":")
                            .append(stats[1])
                            .append('}');
                    }
                }
            }

            sendJsonOk(
                out,
                "{\"totalDataBytes\":"
                    + totalDataBytes
                    + ",\"folders\":["
                    + foldersJson
                    + "],\"idbFolders\":["
                    + idbJson
                    + "]}",
                corsOrigin
            );
            return;
        }

        if ("/__deepchat_backup/export_raw_idb".equals(path) && "POST".equals(method)) {
            File dataDir = getFilesDir().getParentFile();
            List<File> idbRoots = new ArrayList<>();
            List<String> idbNames = new ArrayList<>();
            collectAllIndexedDbRoots(dataDir, idbRoots, idbNames);
            if (idbRoots.isEmpty()) {
                sendJsonError(out, 404, "No IndexedDB folder found", corsOrigin);
                return;
            }

            String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
            String safeZipName = "deepchat_raw_idb-" + stamp + ".zip";
            File exportDir = new File(getCacheDir(), "exports");
            if (!exportDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                exportDir.mkdirs();
            }
            File tempZip = new File(exportDir, System.currentTimeMillis() + "_" + safeZipName);
            boolean handedOff = false;
            try {
                List<String> skipped = new ArrayList<>();
                long[] zipStats = new long[2];
                try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(tempZip))) {
                    zos.setLevel(Deflater.BEST_SPEED);
                    for (int i = 0; i < idbRoots.size(); i++) {
                        addDirectoryToZip(zos, idbRoots.get(i), idbNames.get(i), 0, skipped, zipStats);
                    }
                    StringBuilder manifest = new StringBuilder();
                    manifest.append("files=").append(zipStats[0]).append('\n');
                    manifest.append("rawBytes=").append(zipStats[1]).append('\n');
                    if (!skipped.isEmpty()) {
                        manifest.append("skipped:\n");
                        for (String line : skipped) {
                            manifest.append(line).append('\n');
                        }
                    }
                    zos.putNextEntry(new ZipEntry("export_manifest.txt"));
                    zos.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
                    zos.closeEntry();
                    zos.flush();
                }
                saveTempFileToDownloads(tempZip, safeZipName, "application/zip", out, corsOrigin);
                handedOff = true;
            } finally {
                boolean ownedByPicker;
                synchronized (saveFileLock) {
                    ownedByPicker = pendingSaveFile == tempZip;
                }
                if (!handedOff && !ownedByPicker && tempZip.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    tempZip.delete();
                }
            }
            return;
        }

        if ("/__deepchat_backup/list".equals(path) && "GET".equals(method)) {
            StringBuilder ids = new StringBuilder();
            long totalBytes = 0L;
            synchronized (backupLock) {
                File dir = getBackupDir();
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (!f.isFile()) {
                            continue;
                        }
                        String name = f.getName();
                        if (!name.endsWith(".json")) {
                            continue;
                        }
                        String id = sanitizeBackupSessionId(name.substring(0, name.length() - 5));
                        if (id == null) {
                            continue;
                        }
                        if (ids.length() > 0) {
                            ids.append(',');
                        }
                        ids.append('"').append(escapeJson(id)).append('"');
                        totalBytes += f.length();
                    }
                }
            }
            sendJsonOk(out, "{\"sessions\":[" + ids + "],\"totalBytes\":" + totalBytes + "}", corsOrigin);
            return;
        }

        if ("/__deepchat_backup/clear".equals(path) && "POST".equals(method)) {
            synchronized (backupLock) {
                File[] files = getBackupDir().listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (f.isFile() && (f.getName().endsWith(".json") || f.getName().endsWith(".tmp"))) {
                            //noinspection ResultOfMethodCallIgnored
                            f.delete();
                        }
                    }
                }
            }
            sendJsonOk(out, "{\"ok\":true}", corsOrigin);
            return;
        }

        if ("/__deepchat_backup/session".equals(path)) {
            String sessionId = sanitizeBackupSessionId(getQueryParam(requestPath, "id"));
            if (sessionId == null) {
                sendJsonError(out, 400, "Invalid session id", corsOrigin);
                return;
            }
            File dir = getBackupDir();
            File target = new File(dir, sessionId + ".json");

            if ("GET".equals(method)) {
                byte[] snapshot;
                synchronized (backupLock) {
                    if (!target.isFile()) {
                        sendJsonError(out, 404, "Backup not found", corsOrigin);
                        return;
                    }
                    long len = target.length();
                    if (len <= 0L || len > MAX_BACKUP_SESSION_BYTES) {
                        sendJsonError(out, 404, "Invalid backup size", corsOrigin);
                        return;
                    }
                    snapshot = new byte[(int) len];
                    try (InputStream fis = new BufferedInputStream(new FileInputStream(target))) {
                        int offset = 0;
                        while (offset < snapshot.length) {
                            int r = fis.read(snapshot, offset, snapshot.length - offset);
                            if (r < 0) {
                                break;
                            }
                            offset += r;
                        }
                        if (offset < snapshot.length) {
                            snapshot = Arrays.copyOf(snapshot, offset);
                        }
                    }
                }
                String header = "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + snapshot.length + "\r\n"
                    + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
                    + "Vary: Origin\r\n"
                    + "Access-Control-Expose-Headers: *\r\n"
                    + "x-local-proxy: 1\r\n"
                    + "Connection: close\r\n\r\n";
                out.write(header.getBytes(StandardCharsets.ISO_8859_1));
                out.write(snapshot);
                out.flush();
                return;
            }

            if ("POST".equals(method)) {
                if (!isChunked && (contentLength <= 0L || contentLength > MAX_BACKUP_SESSION_BYTES)) {
                    sendJsonError(out, contentLength > MAX_BACKUP_SESSION_BYTES ? 413 : 400, "Invalid backup body length", corsOrigin);
                    return;
                }
                File tmp = new File(dir, sessionId + ".json." + UUID.randomUUID() + ".tmp");
                try {
                    try (FileOutputStream fos = new FileOutputStream(tmp)) {
                        if (isChunked) {
                            byte[] chunked = readChunkedBody(in, MAX_BACKUP_SESSION_BYTES);
                            if (chunked.length == 0) {
                                throw new IOException("Empty backup body");
                            }
                            fos.write(chunked);
                        } else {
                            byte[] buf = new byte[16384];
                            long remaining = contentLength;
                            while (remaining > 0L) {
                                int toRead = (int) Math.min(buf.length, remaining);
                                int r = in.read(buf, 0, toRead);
                                if (r < 0) {
                                    throw new IOException("Unexpected EOF in backup body");
                                }
                                fos.write(buf, 0, r);
                                remaining -= r;
                            }
                        }
                        fos.flush();
                    }
                    synchronized (backupLock) {
                        if (!tmp.renameTo(target)) {
                            if (target.exists() && !target.delete()) {
                                throw new IOException("Cannot replace existing backup");
                            }
                            if (!tmp.renameTo(target)) {
                                throw new IOException("Cannot commit backup file");
                            }
                        }
                    }
                    sendJsonOk(out, "{\"ok\":true}", corsOrigin);
                } finally {
                    if (tmp.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        tmp.delete();
                    }
                }
                return;
            }

            if ("DELETE".equals(method)) {
                synchronized (backupLock) {
                    if (target.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                    }
                }
                sendJsonOk(out, "{\"ok\":true}", corsOrigin);
                return;
            }
        }

        sendJsonError(out, 404, "Unknown backup endpoint", corsOrigin);
    }

    private static void sendJsonOk(OutputStream out, String json, String corsOrigin) throws IOException {
        byte[] payload = json.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
            + "Vary: Origin\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }

    private static void sendJsonError(OutputStream out, int status, String message, String corsOrigin) throws IOException {
        String safeMsg = escapeJson(message != null ? message : "Error");
        byte[] payload = ("{\"error\":{\"message\":\"" + safeMsg + "\"}}").getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " Error\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
            + "Vary: Origin\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }
}
