# 官方资料提取与复核

这些脚本读取使用者指定的原始资料，输出到使用者指定的工作目录，不修改 App 数据或模型。Python 3.10+、`curl` 和 Node.js 用于此次已验证的环境；Python 依赖单独安装：

```sh
python3 -m pip install -r tools/source-import/requirements.txt
```

原始 PDF、ZIP、页面渲染图与缓存应放在仓库外的私人工作目录，不随 App 发布。下面的 `/path/to/` 是需要替换的路径，脚本中没有开发者目录。官方公开下载仍须遵守来源条款；本目录没有提供书籍全文或照片再利用许可。

## IMA-CNMNC 七列名录

从 [官方名录](https://cnmnc.units.it/files/editor/IMA_Master_List_(2026-09).pdf) 取得源 PDF，再运行：

```sh
python3 tools/source-import/extract_ima.py \
  --pdf /path/to/IMA_Master_List_2026-09.pdf \
  --output-dir /path/to/output/ima \
  --version 2026-09 --expected-count 6239 --retrieved-at 2026-10-10
```

输出 JSON、CSV 和 `ima-extraction-report.json`。使用 PDF 表格及原字符坐标保留化学式上下标、官方七列和页码；不生成描述、属性或分类。检查源文件的日期、数量及 CC BY-SA 3.0 声明。更新版本时同时传入 `--source-url`，重新核对表格布局及提取质量，不能只改变数量参数。

2026-09 原 PDF 的 `CIDFont+F8` 字体在三条公式中输出私用字符：第 79 页 Gachingite、第 160 页 Orcelite 和第 201 页 Sluzhenikinite 已逐页渲染核对，分别保留 `≈`、`≤` 与空格的原意。提取程序只转换这三个已核对字形，其余私用字符会中止提取并要求复核，避免手机显示方框或猜测化学式。正式目录、来源复跑结果和离线校验清单必须同时更新；`validate_sources.py` 检查全部条目可复现及这三条原式。

## Handbook 选定物性事实

`physical-targets.json` 是原项目 89 个标签的官方 PDF 来源清单，包含原数据缺项信息与未匹配的 16 个标签。它不是新推理类别列表。采集限最多 2 个请求同时运行，请求开始至少相隔 2 秒；本地复跑使用 `--offline`：

```sh
python3 tools/source-import/collect_physical_properties.py \
  --targets tools/source-import/physical-targets.json \
  --pdf-dir /path/to/private/physical-source-pdfs \
  --output /path/to/output/physical-candidates.json \
  --retrieved-at 2026-10-10 --offline
```

第一次取得公开官方 PDF 时去掉 `--offline`。源缓存保留内部追溯用途。采集脚本只摘录六个选定属性事实；输出中 `candidate` 状态不能导入产品。实测密度严格取 `D(meas.)`；`D(calc.)`、`n.d.` 与推测数据不当作已核验事实。原文的 Hexagonal、混合晶系、方向性硬度及数值范围不自动改写。

`physical-review-decisions.json` 保存此次逐页渲染核对的决定，包括手工纠正与待复核字段，绑定每个原 PDF 的 SHA-256。仅在源哈希完全一致时可复用：

```sh
python3 tools/source-import/finalize_physical_properties.py \
  --input /path/to/output/physical-candidates.json \
  --decisions tools/source-import/physical-review-decisions.json \
  --output /path/to/output/physical-properties.json \
  --report /path/to/output/physical-properties-report.json
```

此次输出应为 89 个标签、88 个唯一官方 PDF、477 个 verified 字段；32 个不确定解理值与 25 个未刊载字段的 `value` 保持 null。原 PDF 内容变化后应重新渲染逐页核验，并记录新的决定，禁止只替换旧决定中的哈希。不要使用 Python 的 `-O` 关闭提取/复核断言。

## 独立核验正式数据

`validate_sources.py` 只读正式 JSON、原 `data/minerals.js` 及私人源目录；仅写指定的摘要报告。Node.js 用于读取原 KB，可通过 `--node` 指定可执行文件。源目录需要当次已核验的 IMA JSON、物性 JSON、图片元数据、完整 IMA 署名文本、原名录 PDF、AMCSD ZIP 与私人物性 PDF 缓存。它不从网络取得数据。

```sh
python3 tools/source-import/validate_sources.py \
  --repo . --sources /path/to/private/reference-catalog \
  --re-extracted-ima /path/to/output/ima/ima-catalog-2026-09.json \
  --re-extracted-physical /path/to/output/physical-properties.json \
  --output /path/to/output/source-validation.json
```

全量检查 6,239 条七列数据及 Unicode/HTML 化学式、87 个原标签的官方公式、89 个物性标签、全部 9,895 条晶胞测量与原 ZIP 的一致性、780 条图片元数据的出处/状态、源文件及发布清单 SHA-256 和 IMA 署名文本。两个 `--re-extracted-*` 参数用于检查当次完整复跑一致性；省略时不报告该项已完成。

摘要含数量、原文件哈希、核验项与异常数，不含原 PDF、ZIP 文本、图片、Cookie 或凭据。返回码 0 表示这些一致性检查通过，1 表示存在异常。它不能代替照片许可裁定、像素质量检查、现场识别测试或模型准确率验证。
