package com.hqtwitter;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 웹 UI(app.js)에서 window.HqNative 로 호출한다. 파일은 MediaStore를 통해 갤러리에 저장한다.
 * - GIF: JS에서 변환한 바이트를 base64 조각으로 넘겨받아 저장 (begin → append… → finish)
 * - 영상: 메모리를 아끼려고 네이티브에서 직접 받아 저장 (saveUrl), 진행 상황은 window.__native 로 알린다
 */
public class NativeBridge {
    private static final String ALBUM = "고해상도 트위터";
    private static final String MEDIA_HOST = "video.twimg.com";
    private static final long MAX_BYTES = 1024L * 1024 * 1024; // 1GB
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9_]{1,80}\\.(gif|mp4)");

    private final Activity activity;
    private final WebView webView;
    private final Map<String, Pending> pending = new HashMap<>();

    private static class Pending {
        final Uri uri;
        final OutputStream out;
        long written;
        Pending(Uri uri, OutputStream out) { this.uri = uri; this.out = out; }
    }

    NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    private ContentResolver resolver() {
        return activity.getContentResolver();
    }

    // ---------- 입력 검증: 브릿지로 들어오는 값은 전부 믿지 않는다 ----------

    private static String checkMime(String mime) throws IOException {
        if ("image/gif".equals(mime) || "video/mp4".equals(mime)) return mime;
        throw new IOException("지원하지 않는 형식이에요.");
    }

    private static String checkName(String fileName, String mime) throws IOException {
        if (fileName != null && SAFE_NAME.matcher(fileName).matches()
                && fileName.endsWith(mime.equals("image/gif") ? ".gif" : ".mp4")) return fileName;
        throw new IOException("파일 이름이 올바르지 않아요.");
    }

    private static boolean isMediaUrl(URL u) {
        return "https".equals(u.getProtocol()) && MEDIA_HOST.equals(u.getHost());
    }

    /** 갤러리에 보이는 위치에 빈 항목을 만든다 (저장이 끝날 때까지 IS_PENDING). */
    private Uri createEntry(String fileName, String mime) throws IOException {
        checkName(fileName, checkMime(mime));
        boolean video = mime.startsWith("video/");
        Uri collection = video
                ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        // GIF와 영상을 한 폴더에 모아서 갤러리에 앨범 하나로 보이게 한다
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + ALBUM);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver().insert(collection, v);
        if (uri == null) throw new IOException("갤러리 항목을 만들지 못했어요.");
        return uri;
    }

    private void publish(Uri uri) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver().update(uri, v, null, null);
    }

    private void discard(Uri uri) {
        try { resolver().delete(uri, null, null); } catch (Exception ignored) { }
    }

    // ---------- JS → 네이티브 ----------

    @JavascriptInterface
    public boolean isNative() {
        return true;
    }

    @JavascriptInterface
    public synchronized String begin(String id, String fileName, String mime) {
        try {
            if (pending.size() >= 8) return "저장 작업이 너무 많아요.";
            Uri uri = createEntry(fileName, mime);
            OutputStream out = resolver().openOutputStream(uri);
            if (out == null) { discard(uri); return "파일을 열지 못했어요."; }
            pending.put(id, new Pending(uri, out));
            return "";
        } catch (Exception e) {
            return String.valueOf(e.getMessage());
        }
    }

    @JavascriptInterface
    public synchronized String append(String id, String base64) {
        Pending p = pending.get(id);
        if (p == null) return "저장이 시작되지 않았어요.";
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            p.written += bytes.length;
            if (p.written > MAX_BYTES) throw new IOException("파일이 너무 커요.");
            p.out.write(bytes);
            return "";
        } catch (Exception e) {
            abort(id);
            return String.valueOf(e.getMessage());
        }
    }

    @JavascriptInterface
    public synchronized String finish(String id) {
        Pending p = pending.remove(id);
        if (p == null) return "저장이 시작되지 않았어요.";
        try {
            p.out.close();
            publish(p.uri);
            return "";
        } catch (Exception e) {
            discard(p.uri);
            return String.valueOf(e.getMessage());
        }
    }

    @JavascriptInterface
    public synchronized void abort(String id) {
        Pending p = pending.remove(id);
        if (p == null) return;
        try { p.out.close(); } catch (Exception ignored) { }
        discard(p.uri);
    }

    @JavascriptInterface
    public void saveUrl(String id, String url, String fileName, String mime) {
        new Thread(() -> {
            Uri uri = null;
            HttpURLConnection conn = null;
            try {
                checkName(fileName, checkMime(mime));
                URL target = new URL(url);
                if (!isMediaUrl(target)) throw new IOException("트위터 미디어 주소가 아니에요.");
                conn = (HttpURLConnection) target.openConnection();
                conn.setInstanceFollowRedirects(false); // 다른 호스트로 넘어가지 않게
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) HqTwitter/1.0");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                int code = conn.getResponseCode();
                if (code / 100 != 2) throw new IOException("다운로드 실패 (" + code + ")");
                long total = conn.getContentLengthLong();
                if (total > MAX_BYTES) throw new IOException("파일이 너무 커요.");

                uri = createEntry(fileName, mime);
                long got = 0;
                long lastReport = 0;
                try (InputStream in = conn.getInputStream();
                     OutputStream out = resolver().openOutputStream(uri)) {
                    if (out == null) throw new IOException("파일을 열지 못했어요.");
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        got += n;
                        if (got > MAX_BYTES) throw new IOException("파일이 너무 커요.");
                        out.write(buf, 0, n);
                        long now = System.currentTimeMillis();
                        if (total > 0 && now - lastReport > 200) {
                            lastReport = now;
                            js("progress", id, String.valueOf((double) got / total));
                        }
                    }
                }
                publish(uri);
                js("done", id, String.valueOf(got));
            } catch (Exception e) {
                if (uri != null) discard(uri);
                js("fail", id, JSONObject.quote(String.valueOf(e.getMessage())));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /** 공유로 열린 경우에만 화면을 닫아서 공유한 앱(X)으로 돌아간다. */
    @JavascriptInterface
    public void returnToSource() {
        activity.runOnUiThread(() -> {
            if (Intent.ACTION_SEND.equals(activity.getIntent().getAction())) activity.finish();
        });
    }

    @JavascriptInterface
    public void toast(String msg) {
        if (msg == null || msg.length() > 100) return;
        activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show());
    }

    // ---------- 네이티브 → JS ----------

    private void js(String fn, String id, String arg) {
        String code = "window.__native && window.__native." + fn + "(" + JSONObject.quote(id) + "," + arg + ")";
        activity.runOnUiThread(() -> webView.evaluateJavascript(code, null));
    }
}
