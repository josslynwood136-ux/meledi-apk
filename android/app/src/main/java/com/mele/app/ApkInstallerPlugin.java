package com.mele.app;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        final String target = url.trim();
        new Thread(new Runnable() {
            @Override
            public void run() {
                File apk = null;
                try {
                    apk = new File(getContext().getCacheDir(), "update.apk");
                    HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(120000);
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code / 100 != 2) {
                        throw new Exception("HTTP " + code);
                    }
                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                    }
                    out.close();
                    in.close();

                    Uri uri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            apk);
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, "application/vnd.android.package-archive");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);

                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    call.resolve(ret);
                } catch (Exception e) {
                    if (apk != null && apk.exists()) {
                        apk.delete();
                    }
                    call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
                }
            }
        }).start();
    }
}
