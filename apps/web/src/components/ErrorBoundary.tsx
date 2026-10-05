import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)' }}>
          <div className="white-card p-8 max-w-sm w-full text-center">
            <div className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center text-xl" style={{ background: 'var(--primary-light)', color: 'var(--danger)' }}>
              !
            </div>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>页面出错了</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--text-2)' }}>{this.state.error?.message || '发生了未知错误'}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="btn-primary px-6 py-2 rounded-xl text-sm font-medium"
            >
              刷新重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
