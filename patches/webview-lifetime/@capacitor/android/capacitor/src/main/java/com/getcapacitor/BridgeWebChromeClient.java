package com.getcapacitor;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.EditText;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.util.PermissionHelper;
import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * Custom WebChromeClient handler, required for showing dialogs, confirms, etc. in our
 * WebView instance.
 */
public class BridgeWebChromeClient extends WebChromeClient {

    private interface PermissionListener {
        void onPermissionSelect(Boolean isGranted);
    }

    private interface ActivityResultListener {
        void onActivityResult(ActivityResult result);
    }

    private ActivityResultLauncher permissionLauncher;
    private ActivityResultLauncher activityLauncher;
    private PermissionListener permissionListener;
    private ActivityResultListener activityListener;

    private Bridge bridge;
    private boolean bridgeClosing;
    private final Set<PendingProviderCallback> pendingProviderCallbacks = new LinkedHashSet<>();
    private final Set<AlertDialog> pendingDialogs = new LinkedHashSet<>();
    private final Map<PermissionRequest, PendingProviderCallback> permissionRequests = new IdentityHashMap<>();
    private PendingProviderCallback geolocationPending;
    private PendingProviderCallback fileChooserPending;

    private static void requireMainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("WebChrome lifecycle must run on the main thread");
    }

    private boolean isActive() { return !bridgeClosing && bridge.isWebViewActive(); }

    private void abandoned(String operation) {
        Logger.debug("Abandoned late WebChrome callback after owner close: " + operation);
    }

    /** Exactly one provider result while live, or an explicit pre-destroy cancellation. */
    private final class PendingProviderCallback {
        private final Runnable cancel;
        private boolean done;
        PendingProviderCallback(Runnable cancel) {
            requireMainThread();
            this.cancel = cancel;
            pendingProviderCallbacks.add(this);
        }
        void finish(Runnable result) {
            requireMainThread();
            if (done) return;
            done = true;
            pendingProviderCallbacks.remove(this);
            if (isActive()) result.run();
            else abandoned("provider result");
        }
        void abandon() {
            requireMainThread();
            done = true;
            pendingProviderCallbacks.remove(this);
        }
        void cancelBeforeDestroy() {
            requireMainThread();
            if (done) return;
            done = true;
            pendingProviderCallbacks.remove(this);
            // Explicit owner cancellation while its provider is still alive:
            // before destroy during close, or immediately after a live UI failure.
            cancel.run();
        }
    }

    /** Called exactly once by the Bridge owner on main, before destroying its WebView. */
    public void handleBridgeClose() {
        requireMainThread();
        if (bridgeClosing) return;
        bridgeClosing = true;
        permissionListener = null;
        activityListener = null;
        Throwable failure = null;
        for (PendingProviderCallback pending : new ArrayList<>(pendingProviderCallbacks)) {
            try { pending.cancelBeforeDestroy(); }
            catch (RuntimeException | Error error) {
                if (failure == null) failure = error; else if (failure != error) failure.addSuppressed(error);
            }
        }
        permissionRequests.clear();
        geolocationPending = null;
        fileChooserPending = null;
        for (AlertDialog dialog : new ArrayList<>(pendingDialogs)) {
            try { dialog.dismiss(); }
            catch (RuntimeException | Error error) {
                if (failure == null) failure = error; else if (failure != error) failure.addSuppressed(error);
            }
        }
        pendingDialogs.clear();
        if (failure instanceof RuntimeException) throw (RuntimeException) failure;
        if (failure instanceof Error) throw (Error) failure;
    }

    private void showDialog(AlertDialog dialog, PendingProviderCallback pending) {
        pendingDialogs.add(dialog);
        dialog.setOnDismissListener(dismissed -> pendingDialogs.remove(dialog));
        try { dialog.show(); }
        catch (RuntimeException | Error failure) {
            pendingDialogs.remove(dialog);
            try { if (isActive()) pending.cancelBeforeDestroy(); else pending.abandon(); }
            catch (RuntimeException | Error cleanup) { if (cleanup != failure) failure.addSuppressed(cleanup); }
            try { dialog.dismiss(); }
            catch (RuntimeException | Error cleanup) { if (cleanup != failure) failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    public BridgeWebChromeClient(Bridge bridge) {
        this.bridge = bridge;

        ActivityResultCallback<Map<String, Boolean>> permissionCallback = (Map<String, Boolean> isGranted) -> {
            requireMainThread();
            PermissionListener listener = permissionListener;
            permissionListener = null;
            if (!isActive()) { abandoned("permission result"); return; }
            if (listener != null) {
                boolean granted = true;
                for (Map.Entry<String, Boolean> permission : isGranted.entrySet()) {
                    if (!permission.getValue()) granted = false;
                }
                listener.onPermissionSelect(granted);
            }
        };

        permissionLauncher = bridge.registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), permissionCallback);
        activityLauncher =
            bridge.registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    requireMainThread();
                    ActivityResultListener listener = activityListener;
                    activityListener = null;
                    if (!isActive()) { abandoned("Activity result"); return; }
                    if (listener != null) listener.onActivityResult(result);
                }
            );
    }

    /**
     * Render web content in `view`.
     *
     * Both this method and {@link #onHideCustomView()} are required for
     * rendering web content in full screen.
     *
     * @see <a href="https://developer.android.com/reference/android/webkit/WebChromeClient#onShowCustomView(android.view.View,%20android.webkit.WebChromeClient.CustomViewCallback)">onShowCustomView() docs</a>
     */
    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        requireMainThread();
        if (!isActive()) { abandoned("custom view"); return; }
        callback.onCustomViewHidden();
        super.onShowCustomView(view, callback);
    }

    /**
     * Render web content in the original Web View again.
     *
     * Do not remove this method--@see #onShowCustomView(View, CustomViewCallback).
     */
    @Override
    public void onHideCustomView() {
        super.onHideCustomView();
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        requireMainThread();
        if (!isActive()) { abandoned("permission request"); return; }
        if (permissionRequests.containsKey(request)) { Logger.warn("Duplicate pending WebChrome permission request"); return; }
        final PendingProviderCallback pending = new PendingProviderCallback(request::deny);
        permissionRequests.put(request, pending);
        if (permissionListener != null) {
            pending.finish(request::deny);
            permissionRequests.remove(request);
            return;
        }
        boolean required = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
        List<String> permissions = new ArrayList<>();
        if (Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) permissions.add(Manifest.permission.CAMERA);
        if (Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            permissions.add(Manifest.permission.MODIFY_AUDIO_SETTINGS);
            permissions.add(Manifest.permission.RECORD_AUDIO);
        }
        if (!permissions.isEmpty() && required) {
            permissionListener = granted -> {
                permissionRequests.remove(request);
                pending.finish(() -> { if (granted) request.grant(request.getResources()); else request.deny(); });
            };
            try { permissionLauncher.launch(permissions.toArray(new String[0])); }
            catch (RuntimeException error) {
                permissionListener = null;
                permissionRequests.remove(request);
                pending.finish(request::deny);
                throw error;
            }
        } else {
            permissionRequests.remove(request);
            pending.finish(() -> request.grant(request.getResources()));
        }
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
        requireMainThread();
        PendingProviderCallback pending = permissionRequests.remove(request);
        if (pending != null) pending.abandon();
    }

    /**
     * Show the browser alert modal
     * @param view
     * @param url
     * @param message
     * @param result
     * @return
     */
    @Override
    public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
        requireMainThread();
        if (!isActive()) { abandoned("onJsAlert"); return true; }
        if (bridge.getActivity().isFinishing()) { result.cancel(); return true; }
        final PendingProviderCallback pending = new PendingProviderCallback(result::cancel);

        AlertDialog.Builder builder = new AlertDialog.Builder(view.getContext());
        builder
            .setMessage(message)
            .setPositiveButton(
                "OK",
                (dialog, buttonIndex) -> {
                    dialog.dismiss();
                    pending.finish(result::confirm);
                }
            )
            .setOnCancelListener(
                dialog -> {
                    dialog.dismiss();
                    pending.finish(result::cancel);
                }
            );

        AlertDialog dialog = builder.create();

        showDialog(dialog, pending);

        return true;
    }

    /**
     * Show the browser confirm modal
     * @param view
     * @param url
     * @param message
     * @param result
     * @return
     */
    @Override
    public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
        requireMainThread();
        if (!isActive()) { abandoned("onJsConfirm"); return true; }
        if (bridge.getActivity().isFinishing()) { result.cancel(); return true; }
        final PendingProviderCallback pending = new PendingProviderCallback(result::cancel);

        final AlertDialog.Builder builder = new AlertDialog.Builder(view.getContext());

        builder
            .setMessage(message)
            .setPositiveButton(
                "OK",
                (dialog, buttonIndex) -> {
                    dialog.dismiss();
                    pending.finish(result::confirm);
                }
            )
            .setNegativeButton(
                "Cancel",
                (dialog, buttonIndex) -> {
                    dialog.dismiss();
                    pending.finish(result::cancel);
                }
            )
            .setOnCancelListener(
                dialog -> {
                    dialog.dismiss();
                    pending.finish(result::cancel);
                }
            );

        AlertDialog dialog = builder.create();

        showDialog(dialog, pending);

        return true;
    }

    /**
     * Show the browser prompt modal
     * @param view
     * @param url
     * @param message
     * @param defaultValue
     * @param result
     * @return
     */
    @Override
    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, final JsPromptResult result) {
        requireMainThread();
        if (!isActive()) { abandoned("onJsPrompt"); return true; }
        if (bridge.getActivity().isFinishing()) { result.cancel(); return true; }
        final PendingProviderCallback pending = new PendingProviderCallback(result::cancel);

        final AlertDialog.Builder builder = new AlertDialog.Builder(view.getContext());
        final EditText input = new EditText(view.getContext());

        builder
            .setMessage(message)
            .setView(input)
            .setPositiveButton(
                "OK",
                (dialog, buttonIndex) -> {
                    dialog.dismiss();

                    String inputText1 = input.getText().toString().trim();
                    pending.finish(() -> result.confirm(inputText1));
                }
            )
            .setNegativeButton(
                "Cancel",
                (dialog, buttonIndex) -> {
                    dialog.dismiss();
                    pending.finish(result::cancel);
                }
            )
            .setOnCancelListener(
                dialog -> {
                    dialog.dismiss();
                    pending.finish(result::cancel);
                }
            );

        AlertDialog dialog = builder.create();

        showDialog(dialog, pending);

        return true;
    }

    /**
     * Handle the browser geolocation permission prompt
     * @param origin
     * @param callback
     */
    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        requireMainThread();
        if (!isActive()) { abandoned("geolocation prompt"); return; }
        if (geolocationPending != null) { callback.invoke(origin, false, false); return; }
        final PendingProviderCallback pending = new PendingProviderCallback(() -> callback.invoke(origin, false, false));
        geolocationPending = pending;
        final String[] permissions = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION };
        if (PermissionHelper.hasPermissions(bridge.getContext(), permissions)) {
            pending.finish(() -> callback.invoke(origin, true, false));
            geolocationPending = null;
        } else if (permissionListener != null) {
            pending.finish(() -> callback.invoke(origin, false, false));
            geolocationPending = null;
        } else {
            permissionListener = granted -> {
                geolocationPending = null;
                boolean allowed = granted || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    PermissionHelper.hasPermissions(bridge.getContext(), new String[] { Manifest.permission.ACCESS_COARSE_LOCATION }));
                pending.finish(() -> callback.invoke(origin, allowed, false));
            };
            try { permissionLauncher.launch(permissions); }
            catch (RuntimeException error) {
                permissionListener = null;
                geolocationPending = null;
                pending.finish(() -> callback.invoke(origin, false, false));
                throw error;
            }
        }
    }

    @Override
    public void onGeolocationPermissionsHidePrompt() {
        requireMainThread();
        PendingProviderCallback pending = geolocationPending;
        geolocationPending = null;
        if (pending != null) pending.abandon();
    }

    @Override
    public boolean onShowFileChooser(
        WebView webView,
        final ValueCallback<Uri[]> originalFilePathCallback,
        final FileChooserParams fileChooserParams
    ) {
        requireMainThread();
        if (!isActive()) { abandoned("file chooser"); return true; }
        if (fileChooserPending != null || activityListener != null) {
            originalFilePathCallback.onReceiveValue(null);
            return true;
        }
        final PendingProviderCallback pending = new PendingProviderCallback(() -> originalFilePathCallback.onReceiveValue(null));
        fileChooserPending = pending;
        final ValueCallback<Uri[]> filePathCallback = values -> {
            fileChooserPending = null;
            pending.finish(() -> originalFilePathCallback.onReceiveValue(values));
        };
        List<String> acceptTypes = Arrays.asList(fileChooserParams.getAcceptTypes());
        boolean captureEnabled = fileChooserParams.isCaptureEnabled();
        boolean capturePhoto = captureEnabled && acceptTypes.contains("image/*");
        final boolean captureVideo = captureEnabled && acceptTypes.contains("video/*");
        if ((capturePhoto || captureVideo)) {
            if (isMediaCaptureSupported()) {
                showMediaCaptureOrFilePicker(filePathCallback, fileChooserParams, captureVideo);
            } else {
                if (permissionListener != null) { filePathCallback.onReceiveValue(null); return true; }
                permissionListener =
                    isGranted -> {
                        if (isGranted) {
                            showMediaCaptureOrFilePicker(filePathCallback, fileChooserParams, captureVideo);
                        } else {
                            Logger.warn(Logger.tags("FileChooser"), "Camera permission not granted");
                            filePathCallback.onReceiveValue(null);
                        }
                    };
                final String[] camPermission = { Manifest.permission.CAMERA };
                try { permissionLauncher.launch(camPermission); }
                catch (RuntimeException error) { permissionListener = null; filePathCallback.onReceiveValue(null); throw error; }
            }
        } else {
            showFilePicker(filePathCallback, fileChooserParams);
        }

        return true;
    }

    private boolean isMediaCaptureSupported() {
        String[] permissions = { Manifest.permission.CAMERA };
        return (
            PermissionHelper.hasPermissions(bridge.getContext(), permissions) ||
            !PermissionHelper.hasDefinedPermission(bridge.getContext(), Manifest.permission.CAMERA)
        );
    }

    private void showMediaCaptureOrFilePicker(ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams, boolean isVideo) {
        // TODO: add support for video capture on Android M and older
        // On Android M and lower the VIDEO_CAPTURE_INTENT (e.g.: intent.getData())
        // returns a file:// URI instead of the expected content:// URI.
        // So we disable it for now because it requires a bit more work
        boolean isVideoCaptureSupported = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N;
        boolean shown = false;
        if (isVideo && isVideoCaptureSupported) {
            shown = showVideoCapturePicker(filePathCallback);
        } else {
            shown = showImageCapturePicker(filePathCallback);
        }
        if (!shown) {
            Logger.warn(Logger.tags("FileChooser"), "Media capture intent could not be launched. Falling back to default file picker.");
            showFilePicker(filePathCallback, fileChooserParams);
        }
    }

    @SuppressLint("QueryPermissionsNeeded")
    private boolean showImageCapturePicker(final ValueCallback<Uri[]> filePathCallback) {
        Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (takePictureIntent.resolveActivity(bridge.getActivity().getPackageManager()) == null) {
            return false;
        }

        final Uri imageFileUri;
        try {
            imageFileUri = createImageFileUri();
        } catch (Exception ex) {
            Logger.error("Unable to create temporary media capture file: " + ex.getMessage());
            return false;
        }
        takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, imageFileUri);
        activityListener =
            activityResult -> {
                Uri[] result = null;
                if (activityResult.getResultCode() == Activity.RESULT_OK) {
                    result = new Uri[] { imageFileUri };
                }
                filePathCallback.onReceiveValue(result);
            };
        try { activityLauncher.launch(takePictureIntent); }
        catch (RuntimeException error) { activityListener = null; filePathCallback.onReceiveValue(null); throw error; }

        return true;
    }

    @SuppressLint("QueryPermissionsNeeded")
    private boolean showVideoCapturePicker(final ValueCallback<Uri[]> filePathCallback) {
        Intent takeVideoIntent = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);
        if (takeVideoIntent.resolveActivity(bridge.getActivity().getPackageManager()) == null) {
            return false;
        }

        activityListener =
            activityResult -> {
                Uri[] result = null;
                if (activityResult.getResultCode() == Activity.RESULT_OK) {
                    result = new Uri[] { activityResult.getData().getData() };
                }
                filePathCallback.onReceiveValue(result);
            };
        try { activityLauncher.launch(takeVideoIntent); }
        catch (RuntimeException error) { activityListener = null; filePathCallback.onReceiveValue(null); throw error; }

        return true;
    }

    private void showFilePicker(final ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        Intent intent = fileChooserParams.createIntent();
        if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        if (fileChooserParams.getAcceptTypes().length > 1 || intent.getType().startsWith(".")) {
            String[] validTypes = getValidTypes(fileChooserParams.getAcceptTypes());
            intent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes);
            if (intent.getType().startsWith(".")) {
                intent.setType(validTypes[0]);
            }
        }
        try {
            activityListener =
                activityResult -> {
                    Uri[] result;
                    Intent resultIntent = activityResult.getData();
                    if (activityResult.getResultCode() == Activity.RESULT_OK && resultIntent != null && resultIntent.getClipData() != null) {
                        final int numFiles = resultIntent.getClipData().getItemCount();
                        result = new Uri[numFiles];
                        for (int i = 0; i < numFiles; i++) {
                            result[i] = resultIntent.getClipData().getItemAt(i).getUri();
                        }
                    } else {
                        result = WebChromeClient.FileChooserParams.parseResult(activityResult.getResultCode(), resultIntent);
                    }
                    filePathCallback.onReceiveValue(result);
                };
            activityLauncher.launch(intent);
        } catch (ActivityNotFoundException e) {
            activityListener = null;
            filePathCallback.onReceiveValue(null);
        } catch (RuntimeException error) {
            activityListener = null;
            filePathCallback.onReceiveValue(null);
            throw error;
        }
    }

    private String[] getValidTypes(String[] currentTypes) {
        List<String> validTypes = new ArrayList<>();
        MimeTypeMap mtm = MimeTypeMap.getSingleton();
        for (String mime : currentTypes) {
            if (mime.startsWith(".")) {
                String extension = mime.substring(1);
                String extensionMime = mtm.getMimeTypeFromExtension(extension);
                if (extensionMime != null && !validTypes.contains(extensionMime)) {
                    validTypes.add(extensionMime);
                }
            } else if (!validTypes.contains(mime)) {
                validTypes.add(mime);
            }
        }
        Object[] validObj = validTypes.toArray();
        return Arrays.copyOf(validObj, validObj.length, String[].class);
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
        String tag = Logger.tags("Console");
        if (consoleMessage.message() != null && isValidMsg(consoleMessage.message())) {
            String msg = String.format(
                "File: %s - Line %d - Msg: %s",
                consoleMessage.sourceId(),
                consoleMessage.lineNumber(),
                consoleMessage.message()
            );
            String level = consoleMessage.messageLevel().name();
            if ("ERROR".equalsIgnoreCase(level)) {
                Logger.error(tag, msg, null);
            } else if ("WARNING".equalsIgnoreCase(level)) {
                Logger.warn(tag, msg);
            } else if ("TIP".equalsIgnoreCase(level)) {
                Logger.debug(tag, msg);
            } else {
                Logger.info(tag, msg);
            }
        }
        return true;
    }

    public boolean isValidMsg(String msg) {
        return !(
            msg.contains("%cresult %c") ||
            (msg.contains("%cnative %c")) ||
            msg.equalsIgnoreCase("[object Object]") ||
            msg.equalsIgnoreCase("console.groupEnd")
        );
    }

    private Uri createImageFileUri() throws IOException {
        Activity activity = bridge.getActivity();
        File photoFile = createImageFile(activity);
        return FileProvider.getUriForFile(activity, bridge.getContext().getPackageName() + ".fileprovider", photoFile);
    }

    private File createImageFile(Activity activity) throws IOException {
        // Create an image file name
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        String imageFileName = "JPEG_" + timeStamp + "_";
        File storageDir = activity.getExternalFilesDir(Environment.DIRECTORY_PICTURES);

        return File.createTempFile(imageFileName, ".jpg", storageDir);
    }
}
