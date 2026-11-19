import { useStore } from '../store/useStore';

interface Section {
  title?: string;
  type?: string;
  items?: any[];
}

interface AiCard {
  step?: number;
  title?: string;
  emoji?: string;
  summary?: string;
  sections?: Section[];
}

/**
 * 左侧问卷区展示「这一步 AI 给的反馈」。
 * 内容唯一来源：右侧 AI 返回的 stepCard（存在 store.aiCards 里）。
 * 还没让 AI 说这一步时，显示提示，让用户去右边问。
 */
export default function AiStepCardView({ step }: { step: number }) {
  const card = useStore(s => s.aiCards?.[step]) as AiCard | undefined;
  const answer = useStore(s => s.aiAnswers?.[step]) as string | undefined;

  if (!card && !answer) {
    return (
      <div
        style={{
          background: 'linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%)',
          border: '1px dashed #6ee7b7',
          borderRadius: 16,
          padding: '18px 20px',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, color: '#047857', marginBottom: 6 }}>
          👉 请让 AI 给这一步反馈
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: '#6b7280' }}>
          在<span className="md:hidden">下方</span><span className="hidden md:inline">右边</span>对话框问一句「这一屏你怎么看」，AI 的结论会自动显示在这里。
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid #d1fae5',
        borderRadius: 16,
        padding: '18px 20px',
        boxShadow: '0 2px 10px rgba(16,185,129,0.06)',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: '0.12em', color: '#10b981', textTransform: 'uppercase', marginBottom: 8 }}>
        {card?.emoji ? `${card.emoji} ` : ''}{card?.title || 'AI 反馈（与右侧同步）'}
      </div>

      {answer ? (
        <p style={{ fontSize: 14, lineHeight: 1.9, color: '#111827', margin: 0, whiteSpace: 'pre-line' }}>
          {answer}
        </p>
      ) : (
        <>
          {card?.summary && (
            <p style={{ fontSize: 15, fontWeight: 700, color: '#111827', lineHeight: 1.7, margin: '0 0 10px' }}>
              {card.summary}
            </p>
          )}
          {(card?.sections || []).map((sec, si) => {
            const items = sec.items || [];
            if (!items.length) return null;
            return (
              <div key={si} style={{ marginTop: si === 0 ? 0 : 12 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: '#6b7280', marginBottom: 4 }}>
                  {sec.title}
                </div>
                {items.map((it: any, ii: number) => (
                  <div key={ii} style={{ fontSize: 13.5, lineHeight: 1.75, color: '#374151' }}>
                    · {formatItem(it)}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function formatItem(it: any): string {
  if (Array.isArray(it)) {
    return it.length >= 2 ? `${it[0]}：${it[1]}` : String(it[0] ?? '');
  }
  if (it && typeof it === 'object') {
    const label = it.problem || it.reason || it.text || it.metric || '';
    if (label && typeof it.confidence === 'number') {
      return `${label}（把握 ${Math.round(it.confidence * 100)}%）`;
    }
    if (label) return String(label);
    return Object.entries(it).map(([k, v]) => `${k}：${v}`).join('，');
  }
  return String(it ?? '');
}
