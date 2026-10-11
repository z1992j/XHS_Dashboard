import type { ComboGroup, CityGroup, GroupStat } from '../stats';

export interface AnalysisCardsProps {
  /** 热销组合：城市 × 运营商 × 套餐（comboGroups 的结果） */
  combos: ComboGroup[];
  /** 城市 Top5（cityGroups 的结果，已不吃 region 筛选） */
  cities: CityGroup[];
  /** 运营商表现（groupBy carrier，已不吃 carrier 筛选） */
  carriers: GroupStat[];
  /** 当前生效的筛选，用来高亮选中行（高亮而不是筛掉） */
  activeProvince: string;
  activeCity: string;
  activeCarrier: string;
  activePkg: string;
  /** 点击一次落 省+市+运营商+套餐 四个条件，再点整组取消 */
  onComboClick: (g: ComboGroup) => void;
  onCityClick: (g: CityGroup) => void;
  onCarrierClick: (key: string) => void;
}

/**
 * 三张分析卡都吃当前筛选；但按某维度拆分的卡不吃自己那一维的筛选
 * （否则只剩一行），改为把选中的那一项高亮 —— 这条规则在数据侧完成，
 * 组件只负责展示与点击。
 */
export default function AnalysisCards(props: AnalysisCardsProps) {
  const {
    combos, cities, carriers,
    activeProvince, activeCity, activeCarrier, activePkg,
    onComboClick, onCityClick, onCarrierClick,
  } = props;

  const comboTop = combos.slice(0, 6);
  const comboMax = Math.max(...comboTop.map((g) => g.count), 1);
  const cityTop = cities.slice(0, 5);
  const cityMax = Math.max(...cityTop.map((g) => g.commission), 1);
  const carrierTotal = carriers.reduce((s, g) => s + g.commission, 0) || 1;

  return (
    <div className="orders-analysis-grid">
      {/* 左：卖什么最好卖 · 中：在哪卖得最多 · 右：跟谁家合作更划算 */}
      <div className="orders-an-card">
        <h3>热销组合</h3>
        <div className="an-hint">
          城市 × 运营商 × 套餐，按笔数排序
          {combos.length > 6 ? `（共 ${combos.length} 种组合，只显示前 6）` : ''}
        </div>
        {comboTop.length === 0 ? (
          <div className="orders-an-empty">当前口径下暂无可分析的组合</div>
        ) : (
          <table className="orders-an-table">
            <thead>
              <tr><th>城市 · 运营商 · 套餐</th><th>笔数</th><th>佣金</th></tr>
            </thead>
            <tbody>
              {comboTop.map((g) => {
                const label = `${g.city || '未填'} · ${g.carrier || '未填'} · ${g.pkg || '未填'}`;
                // 选中判定要跟 setComboFilter 的「already」口径一致：
                // 省+市+运营商+搜索框里的套餐全对上才算选中
                const selected = activeCity === g.city && activeCarrier === g.carrier &&
                  activePkg.trim().toUpperCase() === g.pkg &&
                  (!g.province || activeProvince === g.province);
                return (
                  <tr
                    key={label}
                    className={`orders-an-row clickable${selected ? ' selected' : ''}`}
                    onClick={() => onComboClick(g)}
                    title={`点击只看「${label}」的订单，再点一次取消`}
                  >
                    <td className="an-combo">
                      <span className="orders-an-swatch" style={{ background: 'var(--c-bar)' }} />
                      {label}
                    </td>
                    <td>
                      <div className="orders-an-share">
                        <div className="orders-an-track">
                          {/* 「热销」看的是走量，条长与排序都用笔数，佣金另列 */}
                          <div className="orders-an-fill" style={{ width: `${((g.count / comboMax) * 100).toFixed(1)}%`, background: 'var(--c-bar)' }} />
                        </div>
                        <span className="orders-an-val">{g.count}</span>
                      </div>
                    </td>
                    <td>{g.commission.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="orders-an-card">
        <h3>城市 Top 5</h3>
        <div className="an-hint">
          按佣金排序
          {cities.length > 5 ? `（共 ${cities.length} 个城市，只显示前 5）` : ''}
        </div>
        {cityTop.length === 0 ? (
          <div className="orders-an-empty">当前口径下暂无城市数据</div>
        ) : (
          cityTop.map((g) => {
            const selected = activeCity === g.city;
            return (
              <div
                key={g.city}
                className={`orders-an-row clickable${selected ? ' selected' : ''}`}
                onClick={() => onCityClick(g)}
                title={`点击只看${g.city}，再点一次取消`}
              >
                <span className="orders-an-label">{g.city}</span>
                <div className="orders-an-track">
                  <div className="orders-an-fill" style={{ width: `${((g.commission / cityMax) * 100).toFixed(1)}%`, background: 'var(--c-bar)' }} />
                </div>
                <span className="orders-an-val"><b>{g.commission.toLocaleString()}</b> · {g.count} 笔</span>
              </div>
            );
          })
        )}
      </div>

      <div className="orders-an-card">
        <h3>运营商表现</h3>
        <div className="an-hint">单均佣金决定把客资给谁，结佣周期决定钱多久到（中位数）</div>
        {carriers.length === 0 ? (
          <div className="orders-an-empty">当前口径下暂无数据</div>
        ) : (
          <table className="orders-an-table">
            <thead>
              <tr><th>运营商</th><th>佣金占比</th><th>笔数</th><th>单均佣金</th><th>结佣周期</th></tr>
            </thead>
            <tbody>
              {carriers.map((g) => {
                const pct = Math.round((g.commission / carrierTotal) * 100);
                const selected = activeCarrier === g.key;
                return (
                  <tr
                    key={g.key}
                    className={`orders-an-row clickable${selected ? ' selected' : ''}`}
                    onClick={() => onCarrierClick(g.key)}
                    title={`点击只看${g.key}`}
                  >
                    <td>
                      <span className="orders-an-swatch" style={{ background: `var(--c-${g.key === '联通' ? 'unicom' : g.key === '移动' ? 'mobile' : 'telecom'})` }} />
                      {g.key}
                    </td>
                    <td>
                      <div className="orders-an-share">
                        <div className="orders-an-track">
                          <div className="orders-an-fill" style={{ width: `${pct}%`, background: 'var(--c-bar)' }} />
                        </div>
                        <span className="orders-an-val">{pct}%</span>
                      </div>
                    </td>
                    <td>{g.count}</td>
                    <td>{g.avgCommission.toLocaleString()}</td>
                    <td>{g.settleMedian === null ? <span className="orders-an-muted">—</span> : `${g.settleMedian} 天`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
