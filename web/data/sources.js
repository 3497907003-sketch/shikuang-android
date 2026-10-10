window.MINERAL_SOURCES = [
  {id:'ima',title:'IMA-CNMNC 官方矿物目录（2026-09）',url:'https://cnmnc.units.it/files/editor/IMA_Master_List_(2026-09).pdf',use:'6239 个有效目录条目；状态 A/G/Rn/Rd/Q/A ? 按原表保留，并非全部批准状态 A。保存名称、化学式、首次发现国家、书目与页码；CC BY-SA 3.0 署名随离线包。目录范围不等于 98 个原模型标签的识别范围',status:'基础目录已收录'},
  {id:'amcsd',title:'AMCSD / RRUFF 晶体文献记录',url:'https://www.rruff.net/about/download-data/',use:'9895 条文献样品记录，关联 3430 个规范矿物名称；晶胞、空间群、条件与文献元数据本地保存，不从照片推定晶胞，不打包论文全文',status:'事实元数据已收录'},
  {id:'rruff-images',title:'RRUFF 标本图库与鉴定出处',url:'https://www.rruff.net/',use:'与 Wikimedia Commons 合计 780 条图片出处、130 种规范名称，79 种对应原模型范围。原站鉴定状态保留出处，照片许可、质量和标签仍需审核；图片未下载，training_ready 为 0',status:'出处元数据 · 待审核'},
  {id:'commons-images',title:'Wikimedia Commons 标本图库',url:'https://commons.wikimedia.org/',use:'逐图保存作者、许可、博物馆标签及原始页面；公开许可不证明标签正确，共生矿物需专家标注。只列在线出处，未作为新增训练图集',status:'出处元数据 · 待审核'},
  {id:'mindat',title:'Mindat',url:'https://www.mindat.org',use:'矿物、产地和标本参考；尚未系统采集，系统提取及 AI 使用需另行授权',status:'来源链接'},
  {id:'webmineral',title:'Webmineral',url:'https://www.webmineral.com',use:'少量历史属性参考；尚未系统采集，晶体、化学式、物理与光学性质仍须逐条核对版本',status:'可查阅 · 未系统采集'},
  {id:'minerals',title:'Minerals.net',url:'https://www.minerals.net',use:'外观、变种及相似矿物资料；尚未系统采集，图片许可需逐图确认',status:'可查阅 · 未系统采集'},
  {id:'nhsc',title:'nhsc.cn（用户提供）',url:'https://www.nhsc.cn',use:'待确认站点与标本条目',status:'尚未核验'},
  {id:'cgsi',title:'实物地质资料标本园',url:'https://www.cgsi.cn/bby/index.htm',use:'国内标本、馆藏与地质资料；尚未系统采集，历史条目部分可查阅，需保留藏品编号和出处',status:'未系统采集'},
  {id:'handbook',title:'Handbook of Mineralogy（MSA）',url:'https://handbookofmineralogy.org/',use:'5366 个精确 PDF 链接；89 个原知识条目标签对应 88 个 PDF，477 个物性字段已核验。保存原文、单位、页码、状态；仅选定事实及书目/链接索引，PDF 全文需联网，原项目成因与用途仍待复核',status:'索引与部分物性已核验'},
  {id:'manual',title:'Manual of Mineral Science，第 23 版',url:'https://www.wiley-vch.de/en/areas-interest/natural-sciences/manual-of-mineral-science-978-0-471-72157-4',use:'Cornelis Klein、Barbara Dutrow；Wiley，ISBN 9780471721574；物性、分析方法与鉴定表',status:'书目已核验'},
  {id:'zlibrary',title:'Z-Library（用户提供的书目线索）',url:'https://zh.zlib.bz',use:'目前未读取全文；书目与版本需回到出版方或图书馆核对',status:'尚未核验'}
];
