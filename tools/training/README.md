# 识矿真实照片训练与盲测

此流程重新训练矿物分类器，保留真实照片出处和权重身份。Kappa 0.95 是实测目标，不能由代码配置、资料数量或继承模型的旧报告证明。未获批的新照片不得进入训练；本文不提供虚构的达标结果。

## 数据准入与分区

输入有序 `labels.json`（至少两个标签）及冻结的 `train.csv`、`val.csv`、`test.csv`。每行必须有 `path,class,group_id,sha256,training_ready,source_url,author,license,license_url`。`training_ready=true` 必须来自真实像素、主目标、标签出处、逐图许可及分组审核；字段自身不能证明这些审核确实完成。原始图与裁剪衍生图都需保留来源 SHA、裁剪记录和独立审核状态，不能只凭分类网页标题自动批准。

- 已知实物编号填写 `specimen_id` 和 `specimen_namespace`，或使用 `RRUFF:R010001` 等带收藏机构/作者命名空间的编号。不同收藏机构的相同数字不会自动合并；同一已知标本不能更换 `group_id` 获得多个训练或评估身份。不同已知标本也不能合成一个多角度评估组。
- 同一原始照片、裁剪版本、近重复簇、同一视频及其帧全部属于同组。`source_url` 必须指向该照片的出处页，不能用一个泛化矿物介绍页替代所有图片出处。可保留带命名空间的 `source_asset_id`、`video_id`、`duplicate_group_id`；脚本审计这些显式身份，拒绝同一身份跨组、跨标签或跨分区。
- 字节完全相同的图片即使在同一训练分区也拒绝重复计数。程序无法凭 SHA 发现重压缩、裁剪和不同角度的同一实物，必须先做近重复检查和人工来源核对；把近重复簇写入分组。来源照片代理分组不等于已经证明的实物互斥分割，报告保留该限制。
- 按组、逐类划分约 80/10/10，每类至少十个独立组、每个分区至少一组；逐类各分区最多允许一组整数取整误差。报告真实组数、图片数、实际分组比例、已知实物组和来源代理组。数量不足时先补数据或明确缩小标签覆盖，不能把 1/1/1 等小试验称为正式 80/10/10 盲测。
- 标签顺序、三个 CSV 的字节 SHA、实际图片 SHA 和已知实物/来源身份都冻结。温度校准和最终评估会重新审计全部三个分区及图片，CSV SHA 相同也不能绕过身份检查。

## 训练、校准与防过拟合

只加载有来源证据的完整官方 ImageNet 预训练权重，必须提供 `--imagenet-source-url`。脚本先检查源分类头为 1000 类，再丢弃该分类头并随机初始化新矿物分类头。98 类矿物权重不能被剥去头后冒充 ImageNet 起点。1000 类头本身仍不能证明特征骨干的训练来源；应独立保存官方下载地址、下载时间及 SHA256。

训练提供头部热身、受限真实图增强、权重衰减、dropout、标签平滑、梯度裁剪与早停。逐类验证召回率会调整下一轮的有界损失权重，这是用户要求的及时反馈；验证集同时用于权重选择与温度拟合，因此验证结果是开发指标，不能称为未见数据上的最终准确率。训练分层抽样的 Kappa 和训练/验证差距用于观察过拟合，也不是独立验收数据。标签噪声、来源偏差或共生主目标错误仍需回到数据审核处理。

真实照片增强包含中心附近裁剪、翻转、直角转向、小角度旋转、受限透视/亮度/对比度/饱和度变化、轻微模糊与小范围遮挡；不得用生成矿物图片替代原照片。`stress` 命令在冻结验证照片上测试 90/180 度转向、75% 中心区域、0.7/1.3 倍亮度、轻微模糊和 JPEG 60 压缩，分别报告单模型与多模型的真实预测变化。它不访问测试集作推理，也不产生新的实验室实物样本；裁剪可能移走来源标记的主矿物，这些变化不能自动当作真实现场准确率或独立泛化证明。

训练监测先固定每组至多三张图。总量不超过 1024 张时评估所有训练组，否则逐类等额抽取完整组，避免按 CSV 前部截断遗漏最后类别或截断某组的角度。报告实际监测图片数、组数、逐类组数及是否覆盖全部训练组。`train_validation_kappa_gap` 是该训练监测队列与验证组的差值，不能称作全部原始训练照片与验证集的准确率差距。

训练完成后，先冻结选定的分类器与模式，再运行一次验证集温度校准。每模型温度仅通过验证组拟合（每组总照片 NLL 权重相同，0.3–5 范围）。评分按每模型 `softmax(logits/temperature)`、每张图平均模型、每个组平均照片，与 App 的 Core 顺序一致；原始 logits 不能先合并后做一次 softmax。

App 最多输入三张照片。验证与测试组在推理前按已审核照片 SHA256 升序固定选至多三张，避免无限增加组内角度放大手机指标，亦不根据标签、分数或预测结果挑图。报告记录原登记图片数和实际评估图片数。单模型/快速模式与多模型指标在同一次盲测中分别报告，不能只用多模型的 Kappa 代表快速模式。

## 测试锁与报告边界

盲测开始前，在数据根目录 `.evaluation-locks/<test-csv-sha256>.json` 原子写入锁。改报告文件名、校准文件或权重也无法意外重新评估同一个冻结测试集。锁保存测试、校准和权重 SHA。推理失败也保留锁，必须记录原因并经审查安排修复重试；不能无记录删除锁后挑选更好权重。

本地文件锁防止意外重测，并非物理防篡改机制。主动删除锁、复制数据到新根目录或更换测试 CSV 后重复挑选会破坏一次盲测声明，必须保留审计说明，并另行获得真正未见的新测试组。

结果包括组级 Top-1、Top-5、宏 F1、Kappa、混淆矩阵、每类支持数与召回、组重采样置信区间、ECE/Brier/NLL、单模型与多模型报告。是否达到 0.95 仅表示本次来源标记数据上的观察值，报告样本量与置信区间仍必须一起解读。这个分类器评估不包含未覆盖矿物、非矿物输入 gate、共生矿物拒判或 App 的一致性/低分阈值验收；不能将其称为所有矿物、任意场景或完整手机识别链路的准确率。

报告分别显示观察值达到目标和置信区间下界支持目标。小样本的自助重采样可能只含一个类别而使 Kappa 未定义；这些次数单独报告，达到 5% 时不发布看似精确的区间。任何全部预测正确的样本也不发布退化的 `[1,1]` Kappa 区间，因为从零次观察错误中重采样无法估计未见错误的不确定性；另报正确率的 Wilson 区间，不能将其冒充 Kappa 区间。即使区间较窄，它也只描述当前来源分布，不证明复杂背景或实验室外推。

保留审核后的可选 `scene_source_domain,background,lighting,device_id,coexistence,lab_scene_confirmed,specimen_regularity` 可获得分场景统计。没有字段或未观察值明确列为 `not_recorded`，组内不同角度的条件不一致/不完整列为 `mixed_or_incomplete`；不据这些组编造某个场景准确率。分组来源标记也不能独立证明照片拍摄环境或完成了实验室鉴定。

## 手机预处理与导出验收

评估使用 EXIF 正向/镜像校正、RGB、中心正方形、PIL bilinear 缩放至 224，随后按 ImageNet 均值和标准差归一化。App 使用 Canvas 处理选定 ROI。中心几何和归一化公式相同不代表两者逐像素相同。

2026-10-10 的本地真实照片回归发现：Chrome 154 与 PIL 12.3 的中心几何及八种 EXIF 方向检查通过，已有石英与狗的 smoke 照片缩放结果仍有像素差异（最大单通道差值 69；归一化最大差值约 1.208）。这些旧照片只用于预处理回归，不是新独立训练/盲测数据，也不是旧 Android WebView 或小米 10 真机验证。没有据此编造“允许误差”。报告在私有工作目录 `work/preprocessing-2.5/preprocessing-report.json`；可用项目测试 `tests/browser-preprocessing.cjs` 及 `tests/helpers/preprocessing-reference.py` 复跑。

新权重导出后，需要在同一批冻结验证照片上实际比较 PIL/PyTorch 与 Canvas/ONNX 的模型分数、排名、快速/多模型结果、非矿物拒判和 ROI；先在验证集确定可解释的门，再做最终手机/端到端测试。当前脚本的 ONNX 检查只比较一个固定随机输入张量上的图计算，报告明确未验证真实图像前处理和现场泛化。这里的随机张量是导出数值测试，绝不作为矿物训练照片。

## 运行与测试

环境需 Python、PyTorch、torchvision、timm、safetensors、NumPy 与 Pillow；导出另需 onnx 和 onnxruntime。保留实际环境版本与来源记录。审核后的训练调用需要三份 CSV、标签、数据根目录、完整 ImageNet 权重、来源 URL 与输出路径，例如：

```sh
python tools/training/train.py train --train-csv DATA/train.csv --val-csv DATA/val.csv --test-csv DATA/test.csv --labels DATA/labels.json --data-root DATA --imagenet-weights WEIGHTS/model.safetensors --imagenet-source-url https://OFFICIAL-SOURCE/model.safetensors --output WORK/classifier.pt
python tools/training/train.py calibrate --val-csv DATA/val.csv --labels DATA/labels.json --data-root DATA --checkpoints WORK/classifier.pt WORK/second.pt --output WORK/calibration.json
python tools/training/train.py stress --val-csv DATA/val.csv --labels DATA/labels.json --data-root DATA --checkpoints WORK/classifier.pt WORK/second.pt --calibration WORK/calibration.json --output WORK/validation-stress.json
python tools/training/train.py evaluate --test-csv DATA/test.csv --labels DATA/labels.json --data-root DATA --checkpoints WORK/classifier.pt WORK/second.pt --calibration WORK/calibration.json --output WORK/test.json
python tools/training/train.py export --checkpoint WORK/classifier.pt --output WORK/classifier.onnx
```

两个分类器须分别训练并用同一冻结分区，各自官方 ImageNet 初始源和架构必须匹配。命令中的占位路径不能用于正式交付；无获批数据时不运行真实训练或盲测。

```sh
python -m unittest discover -s tools/training/tests -v
```

合约单测只使用算术、身份与文件字节夹具，不训练模型、不产生交付准确率。测试真实 Core 的分数顺序时需要本机 Node；其他测试检查分区泄漏、实物命名空间、重复、取整比例、三角度选择、数据集锁、冻结图片变更、错误输出和预训练头。
