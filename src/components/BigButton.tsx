interface BigButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
}

// 内联硬编码色（绕过 Tailwind JIT，100% 确定生效）
const INLINE_PRIMARY = {
  backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)',
  color: '#ffffff',
};
const INLINE_PRIMARY_DISABLED = {
  backgroundImage: 'linear-gradient(to bottom right, #6cbf89, #3da468)',
  color: '#114d2c',
};

export function BigButton({ children, onClick, disabled, variant = 'primary' }: BigButtonProps) {
  const base: Record<string, string> = {
    primary:   'text-white font-bold',
    secondary: 'bg-white hover:bg-mint-50 text-mint-700 border border-mint-200 font-semibold hover:border-mint-300',
    ghost:     'bg-transparent hover:bg-mint-50 text-mint-700 font-medium',
  };
  const disabled_cls = variant === 'primary'
    ? 'text-mint-700 font-bold'
    : 'bg-gray-100 text-gray-400 font-medium border border-gray-200';

  const cls = disabled ? disabled_cls : base[variant];
  const isPrimary = variant === 'primary';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={
        isPrimary
          ? (disabled ? INLINE_PRIMARY_DISABLED : INLINE_PRIMARY)
          : undefined
      }
      className={
        'btn-pop w-full py-3.5 rounded-2xl text-[15px] tracking-wide transition-all active:scale-[0.98] ' +
        cls +
        (disabled ? ' opacity-70 cursor-not-allowed shadow-none' : ' shadow-pop')
      }
    >
      {children}
    </button>
  );
}
