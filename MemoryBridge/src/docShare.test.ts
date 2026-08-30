// docShare 提取测试：docx / sheets / file（附件块）三类链接都要命中并去重。
import { describe, expect, it } from 'vitest';
import { extractDriveFiles } from './docShare.js';

describe('extractDriveFiles', () => {
  it('识别 docx 与 sheets 链接', () => {
    expect(extractDriveFiles('文档 https://my.feishu.cn/docx/BRoAdjCk0ojpR9xDEZzcklyqnyc 和表格 https://www.feishu.cn/sheets/Tre0dFaFaoicKMx2yFkcMieHnqf'))
      .toEqual([
        { id: 'BRoAdjCk0ojpR9xDEZzcklyqnyc', type: 'docx' },
        { id: 'Tre0dFaFaoicKMx2yFkcMieHnqf', type: 'sheet' },
      ]);
  });

  it('识别 /file/ 附件块链接（此前漏提权导致用户打不开附件）', () => {
    expect(extractDriveFiles('附件 https://my.feishu.cn/file/CHndbfJsBoZWB3xnS4ocifTgnxe 已生成'))
      .toEqual([{ id: 'CHndbfJsBoZWB3xnS4ocifTgnxe', type: 'file' }]);
  });

  it('同一 id 重复出现只提一次', () => {
    const out = extractDriveFiles('a /docx/BRoAdjCk0ojpR9xDEZzcklyqnyc b /docx/BRoAdjCk0ojpR9xDEZzcklyqnyc');
    expect(out).toHaveLength(1);
  });

  it('无链接返回空', () => {
    expect(extractDriveFiles('普通回复')).toEqual([]);
    expect(extractDriveFiles(null)).toEqual([]);
  });
});
