interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  aiHint?: string;   // AI 给的引导提示
}

export function ScreenHeader({ title, subtitle, aiHint }: ScreenHeaderProps) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl sm:text-[30px] font-black text-gray-900 leading-tight tracking-tight">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-3 text-[15px] text-gray-500 leading-relaxed">
          {subtitle}
        </p>
      )}
      {aiHint && (
        <div className="mt-4 flex gap-3 bg-gradient-to-r from-mint-50 to-white border border-mint-100 rounded-2xl px-4 py-3 shadow-soft">
          <span className="w-7 h-7 rounded-xl bg-gradient-to-br from-mint-400 to-mint-500 text-white text-[11px] font-black flex items-center justify-center flex-shrink-0 shadow-sm">AI</span>
          <p className="text-[13.5px] text-gray-700 leading-relaxed pt-1">{aiHint}</p>
        </div>
      )}
    </div>
  );
}
