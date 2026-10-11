import { describe, it, expect } from 'vitest';
import {
  fieldValue,
  cnNumber,
  extractCityFromAddress,
  parseOrderText,
  splitOrderText,
  checkParsed,
} from '../src/orders/smartInput';
import { mkOrder } from './order-fixture';

describe('fieldValue', () => {
  it('按冒号取值并去掉首尾空白', () => {
    expect(fieldValue('客户姓名： 张三', ['客户姓名'])).toBe('张三');
    expect(fieldValue('客户姓名:张三', ['客户姓名'])).toBe('张三');
  });

  it('支持多个候选标签（正则片段）', () => {
    expect(fieldValue('姓 名：李四', ['客户姓名', '姓\\s*名'])).toBe('李四');
    expect(fieldValue('联系方式 17365306527', ['联系方式'])).toBe('17365306527');
  });

  it('标签后的括号备注不影响取值', () => {
    expect(fieldValue('办理地址（具体到房号） ：广州市天河区', ['办理地址'])).toBe('广州市天河区');
  });

  it('旧行为：括号备注只吃紧跟标签的那一个，值内备注保留', () => {
    expect(fieldValue('客户姓名：张三（备注）', ['客户姓名'])).toBe('张三（备注）');
  });

  it('没有冒号时退回空白分隔', () => {
    expect(fieldValue('手机号 17365306527', ['手机号'])).toBe('17365306527');
  });

  it('匹配不上返回空串', () => {
    expect(fieldValue('别的：东西', ['客户姓名'])).toBe('');
  });
});

describe('cnNumber', () => {
  it('纯阿拉伯数字直接解析', () => {
    expect(cnNumber('18')).toBe(18);
  });

  it('十位数（含缺位）', () => {
    expect(cnNumber('十')).toBe(10);
    expect(cnNumber('二十')).toBe(20);
    expect(cnNumber('二十三')).toBe(23);
  });

  it('个位数与「两」', () => {
    expect(cnNumber('三')).toBe(3);
    expect(cnNumber('两')).toBe(2);
  });

  it('无法解析返回 0', () => {
    expect(cnNumber('abc')).toBe(0);
    expect(cnNumber('')).toBe(0);
  });
});

describe('extractCityFromAddress', () => {
  it('标准「XX市」并反查省份', () => {
    expect(extractCityFromAddress('广东省广州市天河区某街道1号')).toEqual({
      city: '广州',
      province: '广东',
    });
  });

  it('省份名后紧跟市名', () => {
    expect(extractCityFromAddress('江苏省南京市鼓楼区中山路10号')).toEqual({
      city: '南京',
      province: '江苏',
    });
  });

  it('地址开头就是市名（无省前缀）', () => {
    expect(extractCityFromAddress('深圳市南山区科技园')).toEqual({ city: '深圳', province: '广东' });
  });

  it('城市不在对照表时返回空（旧行为：省份只来自城市反查）', () => {
    // 「惠州」不在 CITY_PROVINCE_MAP 里，extractCityFromAddress 两个都给空；
    // parseOrderText 再用 extractProvinceFromContext 从全文把省份找回来
    expect(extractCityFromAddress('广东省惠州市惠城区XX路')).toEqual({ city: '', province: '' });
    const p = parseOrderText('办理地址：广东省惠州市惠城区XX路');
    expect(p.province).toBe('广东');
    expect(p.city).toBe('');
  });

  it('对照表反查兜底（含别名）', () => {
    expect(extractCityFromAddress('江苏省无锡市滨湖区XX')).toEqual({ city: '无锡', province: '江苏' });
  });

  it('空白字符先剔除再匹配', () => {
    expect(extractCityFromAddress('广东省 广州市 天河区')).toEqual({ city: '广州', province: '广东' });
  });

  it('空地址返回空结果', () => {
    expect(extractCityFromAddress('')).toEqual({ city: '', province: '' });
  });
});

describe('parseOrderText', () => {
  it('完整模板：各字段正确解析', () => {
    const p = parseOrderText(
      '客户姓名：张三\n联系方式：17365306527\n办理地址：广东省广州市天河区某街道1号\n' +
        '办理套餐：联通 300M 宽带 600元/年\n佣金：300\n安装费：0',
    );
    expect(p.name).toBe('张三');
    expect(p.phone).toBe('17365306527');
    expect(p.address).toBe('广东省广州市天河区某街道1号');
    expect(p.carrier).toBe('联通');
    expect(p.package).toBe('300M');
    expect(p.packageFee).toBe(600);
    expect(p.commission).toBe(300);
    expect(p.province).toBe('广东');
    expect(p.city).toBe('广州');
  });

  it('未给出的字段取默认档位', () => {
    const p = parseOrderText('客户姓名：李四');
    expect(p.carrier).toBe('联通');
    expect(p.package).toBe('300m');
    expect(p.duration).toBe('1年');
    expect(p.packageFee).toBe(0);
    expect(p.applyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('千兆写作「千兆」', () => {
    const p = parseOrderText('办理套餐：联通千兆 600元');
    expect(p.package).toBe('1000M');
  });

  it('千兆写作「1000兆」', () => {
    const p = parseOrderText('办理套餐：1000兆 600元');
    expect(p.package).toBe('1000M');
  });

  it('电话里的横线与空格被剔除', () => {
    const p = parseOrderText('联系方式：173-6530-6527');
    expect(p.phone).toBe('17365306527');
  });

  it('标签没匹配上时全文兜底找手机号', () => {
    const p = parseOrderText('张三 17365306527 想装宽带');
    expect(p.phone).toBe('17365306527');
  });

  it('身份证号 x 转大写 X', () => {
    const p = parseOrderText('身份证号：11010119900307451x');
    expect(p.idCard).toBe('11010119900307451X');
  });

  it('时限「半年」「一年」「18个月」', () => {
    expect(parseOrderText('办理套餐：600元 半年').duration).toBe('6个月');
    expect(parseOrderText('办理套餐：600元 一年').duration).toBe('1年');
    expect(parseOrderText('办理套餐：600元 18个月').duration).toBe('18个月');
    expect(parseOrderText('办理套餐：600元 两年').duration).toBe('2年');
  });

  it('运营商独立行优先于套餐内识别', () => {
    const p = parseOrderText('办理套餐：宽带 600元\n运营商：移动');
    expect(p.carrier).toBe('移动');
  });

  it('套餐费在套餐文本里取「元」前数字', () => {
    expect(parseOrderText('办理套餐：300M 500元/月').packageFee).toBe(500);
  });
});

describe('splitOrderText', () => {
  it('按「姓名」行切分，抬头拼到每条前面', () => {
    const text = [
      '新增以下广东宽带',
      '客户姓名：张三',
      '联系方式：17365306527',
      '客户姓名：李四',
      '联系方式：17365306528',
    ].join('\n');
    const parts = splitOrderText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('新增以下广东宽带');
    expect(parts[0]).toContain('客户姓名：张三');
    expect(parts[1]).toContain('客户姓名：李四');
    expect(parts[1]).not.toContain('张三');
  });

  it('只有一条姓名行时不切', () => {
    const text = '客户姓名：张三\n联系方式：17365306527';
    expect(splitOrderText(text)).toEqual([text]);
  });

  it('按空行切分：每段各含一个手机号', () => {
    const text = '客户姓名：张三\n17365306527\n\n客户姓名：李四\n17365306528';
    const parts = splitOrderText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('张三');
    expect(parts[1]).toContain('李四');
  });

  it('空行分段但缺手机号的段落不切', () => {
    const text = '客户姓名：张三\n17365306527\n\n随便写点什么';
    expect(splitOrderText(text)).toEqual([text]);
  });
});

describe('checkParsed', () => {
  const base = parseOrderText(
    '客户姓名：张三\n联系方式：17365306527\n办理套餐：600元 一年',
  );

  it('完整记录无错误无提醒', () => {
    const r = checkParsed(base, new Set());
    expect(r.errors).toEqual([]);
    expect(r.warns).toEqual([]);
  });

  it('缺姓名 / 缺手机号 / 缺套餐费', () => {
    expect(checkParsed({ ...base, name: '' }, new Set()).errors).toContain('缺姓名');
    expect(checkParsed({ ...base, phone: '' }, new Set()).errors).toContain('缺手机号');
    expect(checkParsed({ ...base, packageFee: 0 }, new Set()).errors).toContain('缺套餐费');
  });

  it('手机号格式不对', () => {
    expect(checkParsed({ ...base, phone: '12345' }, new Set()).errors).toContain('手机号格式不对');
  });

  it('身份证号格式不对（仅在填了身份证时检查）', () => {
    expect(checkParsed({ ...base, idCard: '123' }, new Set()).errors).toContain('身份证号格式不对');
    expect(checkParsed({ ...base, idCard: '' }, new Set()).errors).not.toContain('身份证号格式不对');
  });

  it('全库已存在该手机号 → 提醒（第三参数 allOrders）', () => {
    const db = [mkOrder({ phone: '13900000001' })];
    const r = checkParsed({ ...base, phone: '13900000001' }, new Set(), db);
    expect(r.warns).toContain('手机号已存在');
    expect(r.errors).toEqual([]);
  });

  it('本批重复 → 提醒，且 seenPhones 会累积', () => {
    const seen = new Set<string>();
    const r1 = checkParsed({ ...base, phone: '13900000002' }, seen);
    expect(r1.warns).toEqual([]);
    const r2 = checkParsed({ ...base, phone: '13900000002' }, seen);
    expect(r2.warns).toContain('本批重复');
  });
});
