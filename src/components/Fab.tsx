interface FabProps {
  onClick: () => void;
  badge?: number;
}

export default function Fab({ onClick, badge }: FabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed top-4 right-4 z-30 w-12 h-12 rounded-full text-white shadow-float hover:active:scale-95 transition-all flex items-center justify-center text-xl border-2 border-white/60"
      style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)'}}
      aria-label="打开 AI 对话"
    >
      💬
      {badge && badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1.5 rounded-full bg-gradient-to-br from-red-400 to-red-500 text-white text-xs font-bold flex items-center justify-center shadow-md border-2 border-white">
          {badge}
        </span>
      )}
    </button>
  );
}
