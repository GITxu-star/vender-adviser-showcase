/**
 * AccessGate —— 公开部署的访问码门禁
 *
 * 逻辑：
 *   1. 启动时问后端 /health 是否需要访问码（access_required）
 *   2. 需要且本地没存 → 弹输入框；存过就校验一次
 *   3. 校验通过后，全局 fetch 自动给 /api/* 带上 X-Access-Code
 *
 * 本地开发不设 ACCESS_CODE，则完全不弹窗、不拦截。
 */
import { useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'vendor-advisor-access-code';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const HEALTH_URL = API_BASE.endsWith('/api')
  ? API_BASE.slice(0, -4) + '/health'
  : '/health';

export function getAccessCode(): string {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

function saveAccessCode(code: string) {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 隐私模式下忽略 */ }
}

/** 给所有 /api/* 请求自动加访问码头（只打一次补丁） */
let patched = false;
function installFetchInterceptor() {
  if (patched) return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const code = getAccessCode();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (code && url.includes('/api/')) {
      const headers = new Headers(
        init?.headers || (input instanceof Request ? input.headers : undefined)
      );
      headers.set('X-Access-Code', code);
      init = { ...(init || {}), headers };
    }
    return orig(input, init);
  };
}

type Status = 'checking' | 'ok' | 'need-code';

export function AccessGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    installFetchInterceptor();

    const run = async () => {
      let required = false;
      try {
        const r = await fetch(HEALTH_URL);
        if (r.ok) {
          const j = await r.json();
          required = !!j.access_required;
        }
      } catch {
        // 后端不可达时不禁用页面，让原有错误提示去说明问题
        setStatus('ok');
        return;
      }

      if (!required) { setStatus('ok'); return; }

      const saved = getAccessCode();
      if (!saved) { setStatus('need-code'); return; }

      try {
        const r = await fetch(`${API_BASE}/verify`, { headers: { 'X-Access-Code': saved } });
        setStatus(r.ok ? 'ok' : 'need-code');
        if (!r.ok) saveAccessCode('');
      } catch {
        setStatus('need-code');
      }
    };

    run();
  }, []);

  const submit = async () => {
    const code = input.trim();
    if (!code) { setError('请输入访问码'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${API_BASE}/verify`, { headers: { 'X-Access-Code': code } });
      if (r.ok) {
        saveAccessCode(code);
        setStatus('ok');
      } else {
        setError('访问码不对，再试一次');
      }
    } catch {
      setError('连不上服务器，稍后再试');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'ok') return <>{children}</>;

  if (status === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 14 }}>
        正在连接…
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f7faf8' }}>
      <div style={{ width: '100%', maxWidth: 340, background: '#fff', borderRadius: 24, padding: 24, boxShadow: '0 12px 40px -16px rgba(45,138,83,0.25)', border: '1px solid #e6f2ea' }}>
        <div style={{ fontSize: 28, textAlign: 'center', marginBottom: 8 }}>🔑</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', textAlign: 'center', marginBottom: 6 }}>
          输入访问码
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', lineHeight: 1.6, marginBottom: 16 }}>
          这是内测版，需要访问码才能使用。问发你链接的人要一个。
        </div>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="访问码"
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15,
            borderRadius: 14, border: '1px solid #d7e8dc', outline: 'none', marginBottom: 10,
            color: '#111827', background: '#fbfdfc',
          }}
        />
        {error && (
          <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 10 }}>{error}</div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{
            width: '100%', padding: '12px 0', borderRadius: 14, border: 'none', cursor: 'pointer',
            backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)',
            color: '#fff', fontSize: 15, fontWeight: 700,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '验证中…' : '进入'}
        </button>
      </div>
    </div>
  );
}
