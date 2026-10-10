# 识矿 2.0 预览版

以手机上的矿物标本识别为核心。网页版与 Android 使用相同的识别逻辑、知识库和界面。

## 本次升级

- 拍照、视频、照片文件独立入口，视频在本机取帧；启动封面可跳过并限时结束。
- 工作线程运行推理、模型 SHA-256 校验、读取进度、停止分析与 120 秒上限。
- 原生拍照与相册导入，同一标本最多 3 个不同角度；预览框与实际中心裁剪区域一致。
- 稳定 softmax 后按照片等权汇总 3 个模型，避免后台模型突然加入造成同一操作不可复现。
- 低质量照片引导重拍；等待非标本筛查完成；移除容易误拒红褐色矿物的肤色规则。
- 展示候选、模型一致度与不确定原因。输入硬度、光泽可提示物性冲突，不提高图像分数。
- 105 项知识库资料检索，区分矿物、变种、集合体与部分岩石标本；图像模型仍支持原有 98 类。
- IndexedDB 标本记录、缩略图、编号、备注、人工确认方法、JSON 导入导出；迁移 1.0 历史。
- 晶体图标、手机底部导航、响应式布局、识别扫描动效和页面过渡；遵循减少动画偏好。
- 修复离线缓存与 GitHub Pages 子目录回退。发布文件不再包含共享 API 密钥。
- DeepSeek V4.1 Flash 用于可选的资料辅助，用户自行提供本次会话密钥，默认不上传照片；明确勾选后可附加照片，不修改本机候选分数。

## 运行与检查

使用 Node.js 20+。网页版没有 npm 运行依赖。

```sh
npm test
npm run check
npm run build
python3 -m http.server 8765
```

构建输出为 `dist/`。GitHub Pages 工作流在 PR 中只验证和生成预览文件；合并 main 后才部署。

## 准确率验证

本版本未训练新模型，未宣称真实实验室或生活场景准确率。保留 1.0 的权重与类序，并通过 SHA-256 防止文件或标签表意外变化。旧项目 `data/splits/classes.json` 与当前标签顺序相同；当前 ONNX 权重与旧目录导出文件校验值不同，仍需补齐导出记录。现有知识库未逐条审核，缺失物性不用于复核。

阈值目前为模型分数 0.65、首选与次选差距 0.20、模型一致度 2/3、各角度首选一致。这些是预览版的拒判规则，尚未通过现场样本校准。“线索较一致”仍是待复核候选，不能证明样本属于已覆盖类别。图像质量与 ImageNet 筛查也只是启发式规则，不能可靠拒绝所有未覆盖矿物、岩石或非矿物。

将 `tools/samples-template.csv` 复制到数据集目录，填写真实标本：

- `split` 为 `calibration` 或 `test`，同一实物标本只能属于一个分区。
- `specimen_id` 是实物编号；每个标本 1–3 张照片，禁止重复图片。
- `scene` 为 `lab` 或 `daily`；`label` 使用 `model-manifest.json` 中的模型键，未覆盖矿物、岩石、动物、日用品使用 `unknown`。
- `image` 相对 CSV 路径；`crop` 为中心裁剪比例 0.5–1，默认 1；实测 `hardness` 和 `luster` 可留空，光泽选 `metal` 或 `nonmetal`。
- 真值必须来自检测或可靠的人工鉴定，不能把 App 自己的候选当成真值。

```sh
python3 -m pip install -r tools/requirements.txt
python3 tools/predict_samples.py /path/to/samples.csv --out /path/to/raw.json
node tools/evaluate.cjs /path/to/raw.json > /path/to/report.json
```

报告按分区和场景分别给出 Top-1、Top-5、宏平均 F1、Cohen Kappa、强线索覆盖率、强线索子集正确率、未知类误报率与拒判率。质量与拒判规则调用共享 JavaScript 逻辑。Python 图像重采样与 WebView 可能有细微差异，最终还需在目标手机重复验证。没有真实数据时工具明确失败，不生成空准确率。

正式验收应包括实验室干净背景、生活复杂背景、光照与反光变化、模糊、共生/多矿物、相似矿物、未覆盖类别，并按不同实物、设备划分校准与盲测集。预览包通过构建与逻辑测试不等于通过准确率验收。

## 资料与 API

原知识库及模型来自所提供项目。手机拍照使用 [Capacitor 6 Camera](https://capacitorjs.com/docs/v6/apis/camera)，文字补充使用 [DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。版本与模型文件信息见 `model-manifest.json`。
