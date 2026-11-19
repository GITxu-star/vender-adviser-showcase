interface OptionButtonProps {
  label: string;
  selected?: boolean;
  onClick: () => void;
  multi?: boolean;
}

// 选中：深墨绿 + 白字（内联 style 绕过 Tailwind）
const SELECTED_STYLE = {
  backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)',
  borderColor: '#176338',
  color: '#ffffff',
  boxShadow: '0 6px 24px -4px rgba(23,99,56,0.45)',
};
// 未选中：白底 + 深墨绿字（和选中态强区分）
const UNSELECTED_STYLE = {
  backgroundColor: '#ffffff',
  borderColor: '#e8f3ec',
  color: '#176338',
  boxShadow: 'none',
};

export function OptionButton({ label, selected, onClick, multi }: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={selected ? SELECTED_STYLE : UNSELECTED_STYLE}
      className={
        'opt-btn w-full text-left px-4 py-3 rounded-2xl border text-[14.5px] font-semibold transition-all duration-200 active:scale-[0.98] ' +
        (selected ? 'shadow-pop' : 'hover:shadow-soft hover:border-mint-300')
      }
    >
      <span className="inline-flex items-center gap-2.5">
        {multi && (
          <span className={
            'inline-block w-4 h-4 rounded-full border-2 flex-shrink-0 transition-all ' +
            (selected ? 'bg-white border-white' : 'bg-transparent border-mint-400')
          } />
        )}
        {selected && !multi && (
          <span className="w-4 h-4 rounded-full bg-white flex items-center justify-center flex-shrink-0 shadow-sm">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5 L4 7 L8 3" stroke="#176338" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        <span>{label}</span>
      </span>
    </button>
  );
}
