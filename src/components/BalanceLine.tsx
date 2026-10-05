import { useEffect, useState } from 'react';
import { CircleX, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import { errorText } from '../ai/client';
import { dayText, loadBalance, money, resetText, windowName } from '../ai/balance';
import type { Balance, Quota } from '../ai/types';

// What's left on a saved service. The settings ask afresh and list every resource package;
// the model menu (`brief`) takes an answer from the last minute and lists only the packages
// its model can use.
export function BalanceLine({
  of,
  fresh = false,
  brief = false,
}: {
  // A saved AI service's id, or `speech:` and a speech service's.
  of: string;
  fresh?: boolean;
  brief?: boolean;
}) {
  const [state, setState] = useState<Balance | 'loading' | { error: string }>('loading');
  const [asked, setAsked] = useState({ refresh: fresh, n: 0 });
  useEffect(() => {
    let live = true;
    setState('loading');
    loadBalance(of, asked.refresh).then(
      (b) => live && setState(b),
      (e) => live && setState({ error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [of, asked]);
  const again = (
    <button
      type="button"
      className="balance-refresh"
      aria-label="刷新"
      title="刷新"
      disabled={state === 'loading'}
      onClick={() => setAsked((a) => ({ refresh: true, n: a.n + 1 }))}
    >
      {state === 'loading' ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}
    </button>
  );
  if (state === 'loading' || 'error' in state)
    return (
      <div className={`balance-line ${state === 'loading' ? '' : 'error'}`} role="status">
        {state === 'loading' ? (
          <span>正在查询余额…</span>
        ) : (
          <>
            <CircleX size={13} />
            <span>查不到余额：{state.error}</span>
          </>
        )}
        {again}
      </div>
    );
  if (state.kind === 'plan')
    return (
      <div className="balance-line">
        <PlanUsage windows={state.windows} />
        {again}
      </div>
    );
  const packs = (state.packs || []).filter((p) => !brief || p.fits);
  return (
    <div className={`balance-line ${state.empty ? 'error' : ''}`} role="status">
      <Wallet size={13} />
      <div className="balance-text">
        <span>
          {state.amount !== null ? (
            <>
              余额 <strong>{money(state.amount, state.currency)}</strong>
              {state.empty ? '，已用完，请充值' : ''}
              {state.detail ? <em>{state.detail}</em> : null}
            </>
          ) : (
            state.detail
          )}
        </span>
        {packs.length ? (
          <ul className="balance-packs" aria-label="资源包">
            {packs.map((p) => (
              <li key={p.name + p.until} className={p.fits ? 'fits' : ''}>
                <span>{p.name}</span>
                {p.fits && !brief ? <b>当前模型可用</b> : null}
                <em>
                  剩 {p.left}
                  {p.until ? ` · ${dayText(p.until)}到期` : ''}
                </em>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {again}
    </div>
  );
}

// How much of each of a plan's usage windows is used: a ChatGPT plan's through Codex, a Kimi
// membership's.
export function PlanUsage({ windows }: { windows: Quota[] }) {
  return (
    <div className="plan-usage">
      {windows.map((w) => (
        <div
          key={w.windowMins}
          className={w.usedPercent >= 90 ? 'high' : ''}
          title={resetText(w.resetsAt)}
        >
          <span>{windowName(w.windowMins)}额度</span>
          <span
            className="plan-usage-bar"
            role="meter"
            aria-label={`${windowName(w.windowMins)}额度已用`}
            aria-valuenow={w.usedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
          </span>
          <span>已用 {w.usedPercent}%</span>
          <em>{resetText(w.resetsAt)}</em>
        </div>
      ))}
    </div>
  );
}
