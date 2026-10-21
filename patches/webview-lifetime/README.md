# 识矿 WebView 生命周期依赖补丁

上游来源：[Capacitor Android 6.2.2](https://registry.npmjs.org/@capacitor/android/-/android-6.2.2.tgz)、[Capacitor App 6.0.3](https://registry.npmjs.org/@capacitor/app/-/app-6.0.3.tgz)。上游代码为 MIT 许可，完整原始许可证分别保存在 `LICENSE.capacitor-android` 与 `LICENSE.capacitor-app`。本目录中针对这些上游源码的修改同样按 MIT 许可提供。

完整 Java 源码载荷与 `manifest.json` 一起受审查和 SHA-256 固定。`tools/apply-webview-lifetime-patch.cjs` 在 npm postinstall 时验证精确版本、所有原始源码与载荷哈希后安装；重复执行仅接受精确的修改前或修改后字节。Gradle preBuild 只校验已安装状态，不修改依赖。

升级任何被补丁覆盖的版本、源码或实际插件调用面时，必须重新审查主线程释放、共享生命周期与迟到回调，并更新经审查的哈希。未知源码会失败退出，禁止跳过校验或直接手改 node_modules 冒充持久修复。

补丁的 Java/Android 编译、真实生命周期与设备回归需要单独执行。源代码和队列测试不代表原生崩溃已修复。
