window.MINERAL_SOURCES = [
  {id:'ima',title:'IMA-CNMNC 官方矿物目录（2026-09）',url:'https://cnmnc.units.it/files/editor/IMA_Master_List_(2026-09).pdf',use:'6239 个有效目录条目；状态 A/G/Rn/Rd/Q/A ? 按原表保留，并非全部批准状态 A。保存名称、化学式、首次发现国家、书目与页码；CC BY-SA 3.0 署名随离线包。目录范围不等于 98 个原模型标签的识别范围',status:'基础目录已收录'},
  {id:'amcsd',title:'AMCSD / RRUFF 晶体文献记录',url:'https://www.rruff.net/about/download-data/',use:'9895 条文献样品记录，关联 3430 个规范矿物名称；晶胞、空间群、条件与文献元数据本地保存，不从照片推定晶胞，不打包论文全文',status:'事实元数据已收录'},
  {id:'rruff-images',title:'RRUFF 标本图库与鉴定出处',url:'https://www.rruff.net/',use:'482 条标本图片出处，保留原站编号及鉴定依据；这些 RRUFF 照片尚未完成项目逐图许可、质量和目标审核，未内置为已审核照片',status:'出处元数据 · 待审核'},
  {id:'commons-images',title:'Wikimedia Commons 标本图库',url:'https://commons.wikimedia.org/',use:'389 条图片出处，其中 117 张真实照片经过来源、逐图许可及像素/目标审核并内置，可离线对照。与 RRUFF 合计 871 条出处、131 个来源名称；其余 754 条未完成训练准入。公开许可与来源标签不等于独立物相鉴定，共生主体仍需专家标注，内置照片不等于现行模型已训练',status:'117 张审核照片 · 可离线对照'},
  {id:'mindat',title:'Mindat',url:'https://www.mindat.org',use:'矿物、产地和标本参考入口。官方现行条款要求 AI 训练、评测及知识库使用事先取得书面授权，照片还须核对摄影者许可；本项目尚未取得该授权，未系统导入',status:'参考入口 · AI 使用待授权'},
  {id:'nimrf',title:'国家岩矿化石标本资源共享平台',url:'http://www.nimrf.net.cn',use:'已核对矿物标本及系统矿物学查询入口；按标本编号、保存单位和原始记录核查。平台数据与图片使用须申请授权，当前未批量导入或用于模型训练',status:'入口已核查 · 数据待授权'},
  {id:'csmpg',title:'中国矿物岩石地球化学学会',url:'http://www.csmpg.org.cn',use:'学术、科普及矿物学资料线索；已确认学会身份。具体内容须回到原文逐项核验，尚未收录为已审核标本图库或训练资料',status:'学术来源 · 未系统导入'},
  {id:'arkenstone',title:'The Arkenstone / iRocks 标本图库',url:'https://www.irocks.com',use:'标本照片、库存编号、产地、尺寸与摄影者线索；同一标本多视角须同组。照片使用须核对权利人许可，商品名称与说明不作为独立物相检测结果，尚未用于本项目模型训练',status:'标本参考 · 照片需许可'},
  {id:'earthchem',title:'EarthChem 地球化学数据',url:'https://www.earthchem.org',use:'按样品、分析方法与文献核对地球化学数据，许可按具体数据集检查。全岩分析不直接证明照片中单个矿物的身份；当前未系统导入，也不计作训练照片',status:'分析数据来源 · 未系统导入'},
  {id:'webmineral',title:'Webmineral',url:'https://www.webmineral.com',use:'少量历史属性参考；尚未系统采集，晶体、化学式、物理与光学性质仍须逐条核对版本',status:'可查阅 · 未系统采集'},
  {id:'minerals',title:'Minerals.net',url:'https://www.minerals.net',use:'外观、变种及相似矿物资料；尚未系统采集，图片许可需逐图确认',status:'可查阅 · 未系统采集'},
  {id:'nhsc',title:'nhsc.cn（用户提供）',url:'https://www.nhsc.cn',use:'待确认站点与标本条目',status:'尚未核验'},
  {id:'cgsi',title:'实物地质资料标本园',url:'https://www.cgsi.cn/bby/index.htm',use:'国内标本、馆藏与地质资料；尚未系统采集，历史条目部分可查阅，需保留藏品编号和出处',status:'未系统采集'},
  {id:'handbook',title:'Handbook of Mineralogy（MSA）',url:'https://handbookofmineralogy.org/',use:'5366 个精确 PDF 链接；89 个原知识条目标签对应 88 个 PDF，477 个物性字段已核验。保存原文、单位、页码、状态；仅选定事实及书目/链接索引，PDF 全文需联网，原项目成因与用途仍待复核',status:'索引与部分物性已核验'},
  {id:'manual',title:'Manual of Mineral Science，第 23 版',url:'https://www.wiley-vch.de/en/areas-interest/natural-sciences/manual-of-mineral-science-978-0-471-72157-4',use:'Cornelis Klein、Barbara Dutrow；Wiley，ISBN 9780471721574；物性、分析方法与鉴定表',status:'书目已核验'},
  {id:'zlibrary',title:'Z-Library（用户提供的书目线索）',url:'https://zh.zlib.bz',use:'目前未读取全文；书目与版本需回到出版方或图书馆核对',status:'尚未核验'}
];
