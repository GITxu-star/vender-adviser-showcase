import { Component, Fragment, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null; epoch: number }

/**
 * 兜底错误边界：任何子组件渲染抛错时，显示可恢复的提示，而不是整页变白。
 * 点「继续使用」会强制整棵子树重新挂载，避免残留的坏 DOM 节点继续报错。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, epoch: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  private remount = () => {
    this.setState(s => ({ error: null, epoch: s.epoch + 1 }));
  };

  render() {
    if (!this.state.error) {
      return <Fragment key={this.state.epoch}>{this.props.children}</Fragment>;
    }
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-white">
        <div className="w-full max-w-sm text-center">
          <div className="text-[15px] font-bold text-gray-900">这一步出了点问题</div>
          <p className="mt-2 text-[13px] text-gray-500 leading-relaxed">
            页面已保护，数据还在。点下面按钮继续，不会丢已填的内容。
          </p>
          <button
            type="button"
            onClick={this.remount}
            style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
            className="mt-4 w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
          >
            继续使用
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 w-full py-2.5 rounded-2xl text-[13px] font-bold text-gray-600 bg-gray-100 active:scale-[0.98] transition"
          >
            重新加载页面
          </button>
          <p className="mt-3 text-[11px] text-gray-400 break-all">{this.state.error.message}</p>
          <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
            如果反复出现，检查浏览器或微信是否开启了「网页翻译」，关掉后刷新即可。
          </p>
        </div>
      </div>
    );
  }
}
