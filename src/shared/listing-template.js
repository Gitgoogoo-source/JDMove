// 上架表的固定模板（纯函数）：任务面板“下载上架表模板”生成这份表，用户照着填好后点“上传表格”。
// 表头和 listing-sheet.js 读取的列一一对应：参考链接必填，其余选填；
// 协议价不填进 VC 发布页，只随商品记下，发布成功后写进上架总表
import { buildXlsx } from './xlsx-write.js';

export const LISTING_TEMPLATE_NAME = '上架表模板.xlsx';
export const LISTING_SHEET_NAME = '上架表';

/** 模板的列：header 表头；width 列宽；text 设成文本格式（长数字不变成科学计数法）；note 填写说明 */
export const LISTING_TEMPLATE_COLUMNS = Object.freeze([
  { header: '品牌', width: 14, note: '选填，只给自己看，插件按采集到的品牌发布' },
  { header: '商品名称', width: 30, note: '选填，商品的说明（参考链接前面没写名称时用它）' },
  { header: '参考链接', width: 40, text: true, note: '必填：京东商品链接；一个格子可以换行写多个链接，每个链接是一个商品' },
  { header: '市场价(元)', width: 12, note: '选填，最多 2 位小数；没填的到发布前检查表里补' },
  { header: '京东价(元)', width: 12, note: '选填，最多 2 位小数，不能高于市场价' },
  { header: '采购价(元)', width: 12, note: '选填，最多 4 位小数' },
  { header: '协议价(元)', width: 12, note: '选填，最多 4 位小数；不填进发布页，发布成功后写进上架总表' },
  { header: '条形码(69码)', width: 16, text: true, note: '选填，8~14 位数字（如 69 开头的 13 位码），没有可以不填' },
  { header: '型号', width: 14, text: true, note: '选填，留空用采集到的型号' },
  { header: '采购员ERP', width: 14, text: true, note: '选填，留空用设置里的 ERP' },
  { header: '销售员ERP', width: 14, text: true, note: '选填，留空用设置里的 ERP' },
  { header: '备注', width: 20, note: '选填，插件不读' },
]);

const GUIDE_ROWS = [
  ['上架表填写说明'],
  ['1. 在“上架表”工作表里每行填一个商品，表头不要改名、不要删列（可以在最后加自己的列，插件不读）。'],
  ['2. 一行写了多个参考链接时，价格、协议价、条形码等不知道属于哪个商品，不会导入，到发布前检查表里分别填写。'],
  ['3. 填好后在任务面板点“上传表格”。插件会匹配已有采集记录，全部匹配时直接生成发布前检查表；缺少采集记录时会先列出商品并询问是否采集。'],
  ['4. 发布成功的商品写进上架总表（品牌、商品上架名称、市场价、京东价、采购价、协议价、商品编码sku、上架参考链接、69码）。'],
  [],
  ['列', '说明'],
  // 列名加书名号：说明表里不能出现以“参考链接”开头的格子，否则上传时会被当成上架表来读
  ...LISTING_TEMPLATE_COLUMNS.map((c) => [`「${c.header}」`, c.note]),
];

/** @returns {import('./xlsx-write.js').SheetSpec[]} */
export function listingTemplateSheets() {
  const header = LISTING_TEMPLATE_COLUMNS.map((c) => c.header);
  return [
    {
      name: LISTING_SHEET_NAME,
      rows: [header],
      widths: LISTING_TEMPLATE_COLUMNS.map((c) => c.width),
      textColumns: LISTING_TEMPLATE_COLUMNS.map((c, i) => (c.text ? i : -1)).filter((i) => i >= 0),
    },
    { name: '填写说明', rows: GUIDE_ROWS, widths: [16, 90] },
  ];
}

/** @returns {Uint8Array} 上架表模板 .xlsx */
export const listingTemplateXlsx = (opts) => buildXlsx(listingTemplateSheets(), opts);
