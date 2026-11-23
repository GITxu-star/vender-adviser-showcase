import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * 兜底错误边界：任何子组件渲染抛错时，显示可恢复的提示，而不是整页变白。
 * 只影响出错的那一次渲染，点「重新加载」即可恢复。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 留一条日志，方便真机排查
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-white">
        <div className="w-full max-w-sm text-center">
          <div className="text-[15px] font-bold text-gray-900">这一步出了点问题</div>
          <p className="mt-2 text-[13px] text-gray-500 leading-relaxed">
            页面已保护，数据还在。点下面按钮继续，不会丢已填的内容。
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
            className="mt-4 w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
          >
            继续使用
          </button>
          <p className="mt-3 text-[11px] text-gray-400 break-all">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
