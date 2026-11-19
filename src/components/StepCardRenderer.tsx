// StepCardRenderer — 渲染 Step Processor 产出的结构化卡

import type { StepCard, Section } from '../data/processor';

export function StepCardRenderer({ card }: { card: StepCard }) {
  return (
    <div className="bg-white/95 rounded-2xl border border-mint-100 shadow-card overflow-hidden">
      {/* 卡头 */}
      <div className="bg-gradient-to-r from-mint-50 via-white to-white px-5 py-3 border-b border-mint-100 flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-mint-100 to-mint-200 flex items-center justify-center text-xl shadow-soft">
          {card.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black tracking-[0.15em] text-mint-500 uppercase">STEP {card.step}</span>
            <span className="text-[15px] font-bold text-gray-900">{card.title}</span>
          </div>
          <p className="text-[12.5px] text-gray-500 mt-0.5 truncate">{card.summary}</p>
        </div>
      </div>

      {/* 各区块 */}
      <div className="divide-y divide-mint-50/50">
        {card.sections.map((sec, i) => (
          <SectionRenderer key={i} section={sec} />
        ))}
      </div>

      {/* 标签 + 知识引用 */}
      {(card.tags.length > 0 || card.knowledge_refs.length > 0) && (
        <div className="px-5 py-3 bg-gradient-to-r from-mint-50/60 to-white flex flex-wrap items-center gap-2 text-[11px]">
          {card.tags.map(t => (
            <span key={t} className="px-2.5 py-1 rounded-full bg-gradient-to-br from-mint-100 to-mint-50 text-mint-600 font-semibold border border-mint-200">
              {t}
            </span>
          ))}
          {card.knowledge_refs.map(r => (
            <span key={r} className="px-2.5 py-1 rounded-full bg-gray-50 text-gray-500 border border-gray-100">
              📚 {r}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionRenderer({ section }: { section: Section }) {
  return (
    <div className="px-5 py-3">
      <div className="text-[10px] font-black tracking-[0.15em] text-gray-400 uppercase mb-2">
        {section.title}
      </div>
      {renderSectionContent(section)}
    </div>
  );
}

function renderSectionContent(sec: Section) {
  switch (sec.type) {
    case 'kv':
      return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {sec.items.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2 text-[13px]">
              <span className="text-gray-500 flex-shrink-0">{k}</span>
              <span className="text-gray-800 font-semibold truncate">{v}</span>
            </div>
          ))}
        </div>
      );

    case 'confidence':
      return (
        <div className="space-y-2">
          {sec.items.map((item: any, i: number) => (
            <ConfidenceBar key={i} label={item.problem} value={item.confidence} />
          ))}
        </div>
      );

    case 'tree':
      return (
        <div className="space-y-1">
          {sec.items.map((text: string, i: number) => (
            <div key={i} className="flex gap-2 text-[13px]">
              <span className="text-mint-500 font-bold flex-shrink-0">▸</span>
              <span className="text-gray-700">{text}</span>
            </div>
          ))}
        </div>
      );

    case 'list':
      return (
        <ul className="space-y-1 text-[13px]">
          {sec.items.map((text: string, i: number) => (
            <li key={i} className="text-gray-700 flex gap-2">
              <span className="text-mint-400 flex-shrink-0">✓</span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      );

    case 'tag':
      return (
        <div className="flex flex-wrap gap-1.5">
          {sec.items.map((text: string, i: number) => (
            <span key={i} className="px-2.5 py-1 rounded-xl bg-gradient-to-br from-mint-50 to-mint-100 text-mint-600 text-[12px] font-semibold border border-mint-200">
              {text}
            </span>
          ))}
        </div>
      );

    default:
      return null;
  }
}

function ConfidenceBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.7 ? 'bg-gradient-to-r from-mint-500 to-mint-400' : value >= 0.5 ? 'bg-gradient-to-r from-mint-300 to-mint-200' : 'bg-gray-200';
  return (
    <div>
      <div className="flex justify-between text-[12px] mb-1">
        <span className="text-gray-700 font-medium">{label}</span>
        <span className="text-gray-400 font-semibold">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-mint-50 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
