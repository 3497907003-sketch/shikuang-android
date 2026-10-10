# 识矿矿物资料来源与核验

采集日期：2026-10-10。资料范围与图像模型范围单独计算；本次没有重新训练权重。

## 全部有效矿物基础目录

采用 [IMA-CNMNC 2026 年 9 月官方清单](https://cnmnc.units.it/files/editor/IMA_Master_List_(2026-09).pdf) 中的全部 **6,239** 个条目。保存原始七列：认可英文名、化学式、IMA 状态、IMA 编号或描述/更名年份、首次发现国家、最初及较新参考文献，并保存来源 PDF 页码。

名称和公式按 PDF 表格及字符坐标提取，不生成新中文名、硬度、成因或用途。原名录的 Q、A ?、unknown、original paper? 和空白第二文献保持原义；“首次发现国家”不表示完整分布，更不表示上传标本的真实产地。该版目录覆盖截至该版已列出的有效种，不能保证包括后续新发现、全部旧名或所有变种。

本部分及其格式转换衍生目录采用 **CC BY-SA 3.0 Unported**。署名：IMA Commission on New Minerals, Nomenclature and Classification；The New IMA List of Minerals，September 2026。改动为机器可读格式、化学式上下标编码、来源链接和旧项目名称关联。原说明及完整贡献者名单随安装包提供于 `data/licenses/ima-cnmnc-2026-09.txt`。许可：https://creativecommons.org/licenses/by-sa/3.0/。这不为 App 代码、其他资料或照片另行指定许可证。

## 晶体结构文献数据

从 [RRUFF 官方批量下载](https://www.rruff.net/about/download-data/) 的 AMCSD `amc.zip` 提取晶胞长度、角度、原始空间群、实验条件、作者、参考文献、记录编号和源文件名。仅按认可矿物名精确关联；排除明确合成、模拟、假想、预测、量子计算及数学模型的条目，不转载原子坐标表或论文正文。

当前 **9,895** 条文献记录关联 **3,430** 个官方矿物种。不同压力、温度、组成、晶型和样品的数值分别保留，不能将某条晶胞数据泛化为每个标本的固定值。未注明样品来源也不等于证明其为天然标本。没有从照片推算晶胞。

引用：Downs, R. T., and Hall-Wallace, M. (2003), The American Mineralogist Crystal Structure Database, American Mineralogist 88, 247–250；各条记录另保留原论文书目。公开下载不替代照片及论文正文的再利用许可。原 ZIP 校验值保存在 `data/crystals.json` 的 source 元数据。

## 矿物学书籍与物性

[MSA Handbook of Mineralogy 官方索引](https://handbookofmineralogy.org/pdf-search/) 提供 5,663 个公开 PDF 标题/链接；其中 **5,366** 个与官方名录唯一匹配。歧义或未匹配条目不猜选。资料页可在线查阅晶体、物性、光性、形成环境、伴生、分布及引用文献；PDF 全文不在安装包内。

逐页渲染核对 **88 个唯一官方 PDF**，关联原项目 **89 个标签**，补充 **477 个 verified 科学事实字段**：摩氏硬度 89、实测密度 89、晶系 89、解理 51、光泽 88、条痕 71。每个字段保存原值、具体 PDF 地址、页码、单位和核验状态；仅经来源核验的 verified 值用于补充已知物性。32 个解理字段在提取时丢失负指数或角度字形，明确标为待复核并留空。方向性硬度保留晶向，不能参与无方向的自动硬度对照。`n.d.`、未刊载值、无法确认的乱码与推测值不冒充实测数据。原项目成因、用途及部分旧属性没有因此自动获得核验。

引用：John W. Anthony, Richard A. Bideaux, Kenneth W. Bladh, and Monte C. Nichols, Eds., Handbook of Mineralogy, Mineralogical Society of America, Chantilly, VA, USA。仅收录选定事实及来源索引；没有识别到允许完整 PDF/正文转载的开放许可证，不打包书籍全文、插图或长段描述。再出版指引：https://msaweb.org/copyright-permission-request-form/。

## 真实标本图库索引

RRUFF 样品及 Wikimedia Commons 标本照片只收录来源元数据：样品编号、页面/原图地址、作者、逐图许可状态、产地描述和原站鉴定依据。共生矿物需单独标注，博物馆标签不自动等同于检测真值；RRUFF 原站的 XRD/化学分析状态保留出处，不宣称项目独立完成了鉴定。

当前有 **780 条图片出处**，覆盖 **130 个矿物名称**，其中 482 条来自 RRUFF、298 条来自 Wikimedia Commons。RRUFF 中 435 条的原站标本记录提供 XRD/化学分析或单晶 XRD 的鉴定依据，并不表示项目已独立检验。

图片未被批量下载、纳入训练或用合成图替代。每条 `training_ready` 仍为 false，直到逐图许可、像素质量、矿物组成、近重复、标本分组和 80/10/10 划分经过审核。重复的同一标本不能跨训练/验证/测试集。`data/image-sources.json` 保存实际数量和状态。

## 其他用户指定来源

Mindat、Webmineral、Minerals.net、nhsc.cn、实物地质资料标本园及书目线索继续保留真实采集状态。没有把网站“可以打开”、一本书“查到书目”或获得一个链接称为已采集全文。Mindat 的 AI/机器学习使用和各站照片需要遵循其具体条款。用户所称五本书未有完整书目/全文；Z-Library 链接不替代出版方版本与许可核验。

## 可重复更新

`tools/import-crystal-records.py` 从官方 ZIP 与 IMA JSON 重新提取事实；`tools/import-reference-catalog.cjs` 合并已核验数据和原标签的明确别名表。构建检查核验所有资料 JSON 的 SHA-256、数量、ID 唯一性、晶胞条目匹配及模型标签顺序。图鉴按需加载大数据，首屏识别不等待资料下载；Android 同步这些本地资产。
