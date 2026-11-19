// 屏 1 字段
export interface Screen1Data {
  sellWhat: string;              // 卖什么
  whereSell: string;              // 在哪卖
  price: string;                  // 卖多少钱（由 priceMin/priceMax 拼出来的展示值）
  priceMin: string;               // 最低价
  priceMax: string;               // 最高价
  dailyQty: string;               // 一天大概卖多少份
  stallFixed: string;             // 摊位固定吗
  dailyHours: string;             // 每天摆多久
  stallType: string;              // 你的摊属于哪种情形（24 种实拍场景）
  timeSlot: string;               // 主要时段：早市/午间/夜市/全天候
  weather: string;                // 场地：露天/遮阳棚/室内
  competitors: string;            // 周边竞争：多/少/独门生意
  spotType: string;               // 点位类型：转角/老片区/热门街区...
  myDifficulty: string;           // 当前困境：顾客少/竞争大/没方向...
}

// 屏 2 字段
export interface Screen2Data {
  customerAction: string;         // 顾客走到你摊前，一般是
  customerLookAt: string[];       // 顾客先看什么（多选）
  selfFeelWrong: string[];        // 你自己觉得哪不对（多选）
}

// AI 判断（屏 3 产出）
export interface AiJudgment {
  mainProblem: string;            // 最该先改的是哪一个问题
  why: string;                    // 为什么是它
  howToFix: string;               // 怎么解决
  angles: string;                 // 从哪些方面解决
  skipForNow: string;             // 这一轮先别管的是哪些
}

// AI 方案（屏 4 产出）
export interface AiSolution {
  doWhat: string;                 // 具体做什么
  costAndTime: string;            // 花多少钱 / 多久
  revertPlan: string;             // 如果没用怎么退回原样
}

// 屏 7 的结果
export type EffectResult = 'good' | 'some' | 'none' | 'worse';

// AI 对话消息
export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  ts: number;
  typing?: boolean;   // 打字机输出中
  card?: any;         // Step Processor 产出的结构化卡（可选）
}

// 完整的会话数据
export interface SessionData {
  screen1: Screen1Data;
  screen2: Screen2Data;
  judgment: AiJudgment | null;
  solution: AiSolution | null;
  measureTip: string | null;      // 屏 5 的测量方法
  done: boolean;                  // 屏 6：「我做完了」
  lastAction: string | null;       // 上次做了什么
  effect: EffectResult | null;    // 屏 7 的效果
  screenNum: number;              // 当前屏号 1-7
  createdAt: number;
  chat: ChatMessage[];             // AI 对话历史
}

// 默认空值
export const emptySession: SessionData = {
  screen1: {
    sellWhat: '',
    whereSell: '',
    price: '',
    priceMin: '',
    priceMax: '',
    dailyQty: '',
    stallFixed: '',
    dailyHours: '',
    stallType: '',
    timeSlot: '',
    weather: '',
    competitors: '',
    spotType: '',
    myDifficulty: '',
  },
  screen2: {
    customerAction: '',
    customerLookAt: [],
    selfFeelWrong: [],
  },
  judgment: null,
  solution: null,
  measureTip: null,
  done: false,
  lastAction: null,
  effect: null,
  screenNum: 1,
  createdAt: Date.now(),
  chat: [],
};

// ===== 选项定义 =====

export const WHERE_SELL_OPTIONS = [
  '早市', '夜市', '街边', '商场外', '地铁口', '其他',
];

export const DAILY_QTY_OPTIONS = [
  '20 份以下', '20-50', '50-100', '100 以上',
];

export const STALL_FIXED_OPTIONS = [
  '固定', '每天抢位置',
];

export const DAILY_HOURS_OPTIONS = [
  '2 小时以内', '2-4 小时', '4-8 小时', '8 小时以上',
];

// 屏 1 · 你的摊属于哪种情形（24 种实拍场景分类）
export const STALL_TYPE_OPTIONS = [
  // ── 陈列/招牌类（摆法问题）─────────────────────────────────
  '1. 商品放地上，什么也不摆',
  '2. 商品放地上，旁边安个大喇叭',
  '3. 商品放地上，旁边放个广告牌',
  '4. 招牌在地上，商品在摊车上，但四周被挡着看不见产品',
  '5. 招牌在车顶，商品在摊车上，四周透亮',
  '6. 没有招牌的摊车，旁边放个广告牌',
  '7. 没有招牌的摊车，靠老板吆喝',
  '8. 高档移动摊车（上面有 DIY 装饰）',
  '9. 流动三轮车',
  '10. 卡车上直接放上价目表',
  '11. 面包车前直接摆商品',
  '12. 一张桌子上面放商品',
  '13. 摊车上既有招牌也有广告、也有移动的很多张折叠桌椅',
  // ── 位置/场景类（在哪摆）─────────────────────────────────
  '14. 校门口上学高峰和放学高峰摆',
  '15. 工地、工厂门头',
  '16. 景区周围',
  '17. 景区内部的打卡摊位',
  '18. 古街的文创或体验摊位',
  '19. 节庆热闹摊',
  '20. 大型活动摊',
  '21. 地铁旁的摊',
  '22. 公园摊',
  '23. 商场摊',
  '24. 社区固定摊',
];

// 屏 1 · 新增维度
export const TIME_SLOT_OPTIONS = ['早市', '午间', '夜市', '全天候'];
export const VENUE_OPTIONS = ['露天', '有遮阳棚', '室内'];
export const COMPETITORS_OPTIONS = ['独门生意', '竞争少', '竞争激烈'];

// 屏 1 · 点位类型（老板直觉分类）
export const SPOT_TYPE_OPTIONS = [
  '斑马线/路口转角（流量天然好）',
  '公园转角（散步/遛弯高峰）',
  '老片区社区（住户越来越少）',
  '热门街区（摊多但流量也大）',
  '校门口（上下学高峰）',
  '工地/工厂门头（刚需稳定）',
  '地铁旁（通勤流）',
  '商场外围（逛街流）',
  '节庆/活动临时点',
  '其他',
];

// 屏 1 · 当前困境（老板直接选自己的状态）
export const MY_DIFFICULTY_OPTIONS = [
  '顾客越来越少，感到迷茫',
  '摊位太多，分到的顾客越来越少',
  '刚摆起来，还没什么感觉',
  '没什么大问题，想再往上走一步',
  '政策松绑了，想试试新地方',
  '卖完才走，但总卖不完',
  '其他',
];

// 屏 2 选项
export const CUSTOMER_ACTION_OPTIONS = [
  '停下来看了', '问价就走', '直接买', '看一眼就走', '压根没走近',
];

export const CUSTOMER_LOOK_AT_OPTIONS = [
  '招牌', '摊位上', '价格', '看我这个人', '没看清',
];

export const SELF_FEEL_WRONG_OPTIONS = [
  '看不清卖什么', '太贵没人买', '看起来质量不太好',
  '旁边比我便宜', '下雨没人', '出餐慢',
];

// 屏 7 效果选项
export const EFFECT_OPTIONS: { value: EffectResult; label: string }[] = [
  { value: 'good',  label: '明显好一些' },
  { value: 'some',  label: '好像有点' },
  { value: 'none',  label: '没变化' },
  { value: 'worse', label: '更差了' },
];

// 用户不认屏 3 的原因
export const DISAGREE_REASONS = [
  '不是这个问题', '太贵了', '做不到', '看不懂',
];
