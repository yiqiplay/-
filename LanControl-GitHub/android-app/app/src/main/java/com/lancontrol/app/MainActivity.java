package com.lancontrol.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * 主界面：
 *  第一屏 = 搜索/输入电脑地址；第二屏 = 内嵌控制界面（WebView 加载被控端页面）。
 * 纯 Android Framework 实现，不依赖 AndroidX 或任何第三方库。
 */
public class MainActivity extends Activity {

    private static final String TAG = "LanControl";
    private static final int REQ_FILE = 1001;
    private static final String PREFS = "lancontrol";

    private LinearLayout connectScreen;
    private FrameLayout webScreen;
    private WebView webView;
    private ProgressBar webProgress;
    private TextView statusText;
    private ListView serverList;
    private EditText manualInput;
    private CheckBox rememberBox;
    private ArrayAdapter<String> listAdapter;
    private final List<Discovery.ServerInfo> servers = new ArrayList<>();
    private Discovery discovery;
    private ValueCallback<Uri[]> fileCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private String currentUrl;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawableResource(R.color.bg);
        buildUi();
        prefillLastAddress();
    }

    /* ---------------- 界面构建 ---------------- */

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);

        // ---------- 连接页 ----------
        connectScreen = new LinearLayout(this);
        connectScreen.setOrientation(LinearLayout.VERTICAL);
        connectScreen.setBackgroundColor(getColor(R.color.bg));
        connectScreen.setPadding(dp(22), dp(48), dp(22), dp(22));

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(getColor(R.color.txt));
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        connectScreen.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText(R.string.hint);
        subtitle.setTextColor(getColor(R.color.dim));
        subtitle.setTextSize(13);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, dp(8), 0, dp(18));
        connectScreen.addView(subtitle);

        Button scanBtn = new Button(this);
        scanBtn.setText(R.string.scan);
        scanBtn.setAllCaps(false);
        scanBtn.setTextSize(16);
        scanBtn.setTextColor(Color.parseColor("#06121f"));
        scanBtn.setBackgroundColor(getColor(R.color.accent));
        scanBtn.setOnClickListener(v -> startScan());
        connectScreen.addView(scanBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        statusText = new TextView(this);
        statusText.setText("");
        statusText.setTextColor(getColor(R.color.dim));
        statusText.setTextSize(13);
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(0, dp(12), 0, dp(6));
        connectScreen.addView(statusText);

        serverList = new ListView(this);
        serverList.setDividerHeight(0);
        serverList.setBackgroundColor(getColor(R.color.bg2));
        listAdapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, new ArrayList<>());
        serverList.setAdapter(listAdapter);
        serverList.setOnItemClickListener((parent, view, position, id) -> {
            if (position >= 0 && position < servers.size()) {
                Discovery.ServerInfo s = servers.get(position);
                openControl(s.address + ":" + s.port, s.host);
            }
        });
        LinearLayout.LayoutParams listParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        listParams.topMargin = dp(4);
        connectScreen.addView(serverList, listParams);

        TextView manualLabel = new TextView(this);
        manualLabel.setText(R.string.manual);
        manualLabel.setTextColor(getColor(R.color.dim));
        manualLabel.setTextSize(12);
        manualLabel.setPadding(0, dp(14), 0, dp(6));
        connectScreen.addView(manualLabel);

        LinearLayout manualRow = new LinearLayout(this);
        manualRow.setOrientation(LinearLayout.HORIZONTAL);

        manualInput = new EditText(this);
        manualInput.setHint("192.168.1.100:8848");
        manualInput.setHintTextColor(getColor(R.color.dim));
        manualInput.setTextColor(getColor(R.color.txt));
        manualInput.setTextSize(16);
        manualInput.setSingleLine(true);
        manualInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        manualRow.addView(manualInput, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button connectBtn = new Button(this);
        connectBtn.setText(R.string.connect);
        connectBtn.setAllCaps(false);
        connectBtn.setTextColor(getColor(R.color.txt));
        connectBtn.setBackgroundColor(getColor(R.color.bg3));
        connectBtn.setOnClickListener(v -> {
            String addr = normalize(manualInput.getText().toString());
            if (addr == null) {
                Toast.makeText(this, "请输入电脑地址，例如 192.168.1.100", Toast.LENGTH_SHORT).show();
                return;
            }
            openControl(addr, addr);
        });
        LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(dp(88), dp(46));
        btnParams.leftMargin = dp(8);
        manualRow.addView(connectBtn, btnParams);

        connectScreen.addView(manualRow);

        // ── 记住此设备 ────────────────────────────────────────────────
        // 勾选后把"地址 + 配对码"存进 SharedPreferences，下次启动自动填好并带入网页，
        // 免去每次手输 6 位配对码。
        // 注意：需要电脑端先点「固定配对码」，否则电脑端每次重启都换码，记住了也没用。
        rememberBox = new CheckBox(this);
        rememberBox.setText(R.string.remember);
        rememberBox.setChecked(sp().getBoolean("remember", false));
        rememberBox.setTextColor(getColor(R.color.dim));
        rememberBox.setTextSize(13);
        rememberBox.setPadding(0, dp(10), 0, 0);
        rememberBox.setOnCheckedChangeListener((v, checked) -> {
            if (!checked) {
                sp().edit().putBoolean("remember", false).remove("savedCode").commit();
                Toast.makeText(this, R.string.forget, Toast.LENGTH_SHORT).show();
            } else {
                sp().edit().putBoolean("remember", true).commit();
                Toast.makeText(this, R.string.remembered, Toast.LENGTH_SHORT).show();
            }
        });
        connectScreen.addView(rememberBox);

        // 手机端版本号：之前界面完全不显示版本，"改了却看不出变化"很难判断，
        // 现在直接写在连接页底部，和电脑端控制面板的 vX.Y.Z 对得上。
        TextView verText = new TextView(this);
        try {
            verText.setText(getString(R.string.app_ver, getPackageManager()
                    .getPackageInfo(getPackageName(), 0).versionName));
        } catch (Exception e) {
            verText.setText("手机端");
        }
        verText.setTextColor(getColor(R.color.dim));
        verText.setTextSize(12);
        verText.setText(verText.getText() + "    " + getString(R.string.copyright));
        verText.setPadding(0, dp(12), 0, 0);
        connectScreen.addView(verText);

        root.addView(connectScreen, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // ---------- 控制页（WebView） ----------
        webScreen = new FrameLayout(this);
        webScreen.setBackgroundColor(Color.BLACK);
        webScreen.setVisibility(View.GONE);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        // 网页 ↔ App 桥：让网页也能读写"记住此设备"。
        // 只暴露两个窄接口：读存档 / 写存档，不做任何其它能力，风险可控。
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public String getRemembered() {
                SharedPreferences p = sp();
                if (!p.getBoolean("remember", false)) return "";
                return p.getString("lastAddress", "") + "|" + p.getString("savedCode", "");
            }

            @android.webkit.JavascriptInterface
            public void saveRemembered(String address, String code) {
                // 只有用户勾选了「记住此设备」才落盘；未勾选直接忽略，
                // 免得网页把用户没同意的选择强加上去。
                if (!sp().getBoolean("remember", false)) return;
                if (code == null || code.length() != 6) return;
                // commit() 同步写：apply() 异步落盘，用户马上退出可能还没写完 ——
                // 这正是"退出后重进没保存住"的直接原因之一。
                sp().edit()
                        .putString("lastAddress", address == null ? "" : address)
                        .putString("savedCode", code)
                        .commit();
                Log.i(TAG, "已记住此设备: " + address + " 配对码已保存");
            }
        }, "LanControlApp");
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            s.setForceDark(WebSettings.FORCE_DARK_ON);
        }
        // 让网页识别自己运行在 App 里（会自动进入沉浸模式）
        s.setUserAgentString(s.getUserAgentString() + " LanControlApp/1.0");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith("http")) {
                    runOnUiThread(() -> {
                        Toast.makeText(MainActivity.this,
                                "无法连接：请确认电脑被控端正在运行，且与本机在同一局域网",
                                Toast.LENGTH_LONG).show();
                        showConnectScreen();
                    });
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "网页日志: " + cm.message() + " @" + cm.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(intent, "选择要上传的文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "打开文件选择器失败: " + e.getMessage());
                    fileCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 仅用于页面内可能出现的媒体权限请求，直接拒绝更安全
                request.deny();
            }

            // ---- 网页请求全屏（Fullscreen API）时接管，让整机进入沉浸式 ----
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                Log.i(TAG, "网页请求全屏");
                customView = view;
                customViewCallback = callback;
                webScreen.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                view.setBackgroundColor(Color.BLACK);
                webView.setVisibility(View.GONE);
                applyImmersiveMode(true);
            }

            @Override
            public void onHideCustomView() {
                Log.i(TAG, "网页退出全屏");
                if (customView == null) return;
                webScreen.removeView(customView);
                customView = null;
                webView.setVisibility(View.VISIBLE);
                applyImmersiveMode(false);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });
        webScreen.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        webProgress.setIndeterminate(true);
        FrameLayout.LayoutParams pp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        webScreen.addView(webProgress, pp);
        webProgress.setVisibility(View.GONE);

        root.addView(webScreen, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private SharedPreferences sp() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void prefillLastAddress() {
        SharedPreferences p = sp();
        String last = p.getString("lastAddress", "");
        if (!last.isEmpty()) {
            manualInput.setText(last);
            String code = p.getString("savedCode", "");
            if (p.getBoolean("remember", false) && !code.isEmpty()) {
                // 记住了这台设备：明确告诉用户配对码已自动填入，不必再手输
                statusText.setText("已记住此设备：" + last + "（配对码已自动填入）");
            } else {
                statusText.setText("上次连接：" + last);
            }
        }
    }

    /* ---------------- 搜索 ---------------- */

    private void startScan() {
        if (discovery != null) discovery.stop();
        servers.clear();
        listAdapter.clear();
        listAdapter.notifyDataSetChanged();
        statusText.setText(R.string.scanning);

        discovery = new Discovery(this);
        discovery.start(5000, new Discovery.Callback() {
            @Override
            public void onFound(List<Discovery.ServerInfo> list) {
                servers.clear();
                servers.addAll(list);
                listAdapter.clear();
                for (Discovery.ServerInfo s : list) {
                    listAdapter.add(s.display());
                }
                listAdapter.notifyDataSetChanged();
                statusText.setText("发现 " + list.size() + " 台电脑，点击即可连接");
            }

            @Override
            public void onFinished(List<Discovery.ServerInfo> list) {
                if (list.isEmpty()) {
                    statusText.setText(R.string.not_found);
                }
            }
        });
    }

    private String normalize(String raw) {
        if (raw == null) return null;
        String a = raw.trim().replace("http://", "").replace("https://", "");
        int slash = a.indexOf('/');
        if (slash >= 0) a = a.substring(0, slash);
        if (a.isEmpty()) return null;
        if (!a.matches("^[0-9a-zA-Z\\.\\-]+(:[0-9]{1,5})?$")) return null;
        if (!a.contains(":")) a = a + ":8848";
        return a;
    }

    /* ---------------- 控制页 ---------------- */

    /** 从地址里取出配对码并保存（支持 192.168.1.5:8848?code=123456 或 code=123456 混写）。 */
    private void captureAndSaveCode(String rawAddress) {
        try {
            String code = "";
            int q = rawAddress.indexOf("code=");
            if (q >= 0) {
                code = rawAddress.substring(q + 5);
                int amp = code.indexOf('&');
                if (amp >= 0) code = code.substring(0, amp);
                code = code.replaceAll("[^0-9]", "");
            }
            if (code.length() == 6 && sp().getBoolean("remember", false)) {
                // 用 commit() 而不是 apply()：apply 是异步落盘，
                // 紧接着读偏好可能读到旧值；配对码这种小数据用同步写更稳。
                sp().edit().putString("savedCode", code).commit();
                Log.i(TAG, "已记住配对码（来自地址）");
            }
        } catch (Exception ignored) { }
    }

    private void openControl(String address, String label) {
        if (discovery != null) discovery.stop();
        // 先把地址里的配对码存下来（若带 ?code=），再决定 URL —— 顺序不能反，
        // 否则读到的还是旧值（apply 异步 + 读到上一次的存档）。
        captureAndSaveCode(address);
        SharedPreferences p = sp();
        String savedCode = p.getBoolean("remember", false) ? p.getString("savedCode", "") : "";
        // 地址里已经带了 code 就用它，否则用记住的
        String effective = address.contains("code=") ? "" : savedCode;
        currentUrl = "http://" + address + (effective.isEmpty() ? "" : ("?code=" + effective));
        p.edit().putString("lastAddress", address).commit();

        connectScreen.setVisibility(View.GONE);
        webScreen.setVisibility(View.VISIBLE);
        webProgress.setVisibility(View.VISIBLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Log.i(TAG, "打开控制页面: " + currentUrl);
        webView.loadUrl(currentUrl);
        webView.postDelayed(() -> webProgress.setVisibility(View.GONE), 4000);
    }

    private void showConnectScreen() {
        runOnUiThread(() -> {
            webScreen.setVisibility(View.GONE);
            connectScreen.setVisibility(View.VISIBLE);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            prefillLastAddress();
        });
    }

    /** 全屏沉浸：隐藏状态栏/导航栏并允许内容延伸到刘海区域。 */
    private void applyImmersiveMode(boolean on) {
        View decor = getWindow().getDecorView();
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            decor.setSystemUiVisibility(flags);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                getWindow().getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                getWindow().getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            }
        }
    }

    /* ---------------- 生命周期与按键 ---------------- */

    @Override
    public void onBackPressed() {
        // 先退出网页触发的全屏
        if (customView != null) {
            onHideCustomViewInternal();
            return;
        }
        if (webScreen.getVisibility() == View.VISIBLE) {
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 2000) {
                showConnectScreen();
                webView.loadUrl("about:blank");
            } else {
                lastBackAt = now;
                Toast.makeText(this, "再按一次返回连接页", Toast.LENGTH_SHORT).show();
            }
            return;
        }
        super.onBackPressed();
    }

    /** 供返回键调用：等价于网页退出全屏。 */
    private void onHideCustomViewInternal() {
        if (customView == null) return;
        webScreen.removeView(customView);
        customView = null;
        if (webView != null) webView.setVisibility(View.VISIBLE);
        applyImmersiveMode(false);
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            // 音量键交给系统（保持原有行为）
            return super.onKeyDown(keyCode, event);
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (discovery != null) discovery.stop();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
        }
        super.onDestroy();
    }
}
