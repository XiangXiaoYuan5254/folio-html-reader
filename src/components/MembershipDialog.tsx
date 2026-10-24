import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Crown, Gift, Lock, RotateCw, Ticket, X } from 'lucide-react';
import { encode } from 'uqr';
import { invoke } from '../api';
import { errorText } from '../ai/client';
import {
  activateLicense,
  askMembership,
  checkOrder,
  createOrder,
  getOffer,
  recoverLicense,
  renewLicense,
  setInvite,
  startTrial,
  useLicense,
} from '../license';
import type { InviteCode, LicenseStatus, Offer, Order, Plan, Refusal } from '../license';

const DAY = 86_400_000;
const when = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
const computer = (platform: string | null) =>
  platform === 'darwin' ? ' Mac ' : platform === 'win32' ? ' Windows 电脑' : '电脑';
const plan = (p: string) => (p === 'life' ? '永久' : p === 'year' ? '365 天' : '30 天');
const membership = (p: string) => (p === 'life' ? '永久会员' : `${plan(p)}会员`);
// Fen as ¥19.9, ¥99, ¥8.25.
const yuan = (fen: number) => `¥${(fen / 100).toFixed(fen % 10 ? 2 : fen % 100 ? 1 : 0)}`;
// A price with its ¥ set smaller than the number.
const Price = ({ fen }: { fen: number }) => (
  <span className="membership-price">
    <small>¥</small>
    {yuan(fen).slice(1)}
  </span>
);
const date = (ms: number) =>
  new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
const promotionEnd = (until: number) =>
  new Date(until - 1).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
// The price struck through beside it: before the credit or the friend's invite, or the regular
// price the early-bird one stands in for until its date (said in the note, so it isn't a made-up
// "original" price).
const struck = (p: Offer['plans'][number]) =>
  p.credit || p.discount
    ? p.amount + (p.credit || 0) + (p.discount || 0)
    : p.later && p.until
      ? p.later
      : 0;
// What a friend's invite code takes off is a line of its own (see the plan cards).
function planNote(p: Offer['plans'][number]) {
  if (p.credit) return `剩余天数抵扣 −${yuan(p.credit)}`;
  if (p.plan === 'year' && p.discount) return '首年邀请码价';
  if (p.plan === 'year') return `合 ${yuan(Math.round(p.amount / 12))} / 月`;
  if (p.later && p.until) return `早鸟价至 ${date(p.until - 1)}`;
  if (p.plan === 'life') return '一次买断';
  return '随用随买';
}

// What everyone has, and what a membership adds.
const compare: [string, boolean][] = [
  ['HTML 阅读、批注、笔记', true],
  ['源码编辑、双栏、专注阅读', true],
  ['导出 Markdown、默认主题', true],
  ['PDF 阅读与批注', false],
  ['十套界面主题、跟随系统', false],
  ['AI 助手问答、AI 划重点', false],
  ['划词解释、翻译、提问', false],
  ['页老师白板讲解、语音对话', false],
  ['精读笔记、找论文、AI 改源码', false],
];
// What a friend's code currently takes off each plan.
const offText = (discount: InviteCode['discount']) =>
  (['month', 'year', 'life'] as const)
    .filter((p) => discount[p])
    .map((p) => `${{ month: '月度', year: '年度', life: '永久' }[p]}会员减 ${yuan(discount[p]!)}`)
    .join('、');
// This computer's invite code: it takes something off one friend's first purchase. The button
// copies the server's invite, with the code and download link in it; clicking the code copies
// just the code (for a comment, or a chat that already knows 页间), and says so for a moment.
function InviteCard({ invite }: { invite: InviteCode }) {
  const [copied, setCopied] = useState<'' | 'code' | 'share'>('');
  useEffect(() => {
    if (copied !== 'code') return;
    const timer = window.setTimeout(() => setCopied(''), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const off = offText(invite.discount);
  const copy = (what: 'code' | 'share') =>
    void navigator.clipboard
      .writeText(what === 'code' ? invite.code : invite.share)
      .then(() => setCopied(what));
  return (
    <section className="membership-invite" aria-labelledby="membership-invite-title">
      <div className="membership-invite-head">
        <Gift size={16} />
        <strong id="membership-invite-title">邀请好友</strong>
        {invite.used ? null : (
          <>
            {/* Both words take the same cell, so the button keeps its width either way. */}
            <button
              type="button"
              className="membership-invite-code"
              title="点击复制邀请码"
              onClick={() => copy('code')}
            >
              <span className={copied === 'code' ? 'is-hidden' : ''}>{invite.code}</span>
              <span className={copied === 'code' ? 'is-copied' : 'is-copied is-hidden'}>
                已复制
              </span>
            </button>
            <button type="button" className="secondary-button" onClick={() => copy('share')}>
              {copied === 'share' ? <Check size={13} /> : <Copy size={13} />}
              {copied === 'share' ? '已复制' : '复制邀请'}
            </button>
          </>
        )}
      </div>
      <p className="membership-invite-note">
        {invite.used
          ? `你的邀请码 ${invite.code} 已经被好友用过了，每个码只能用一次。`
          : `好友填这个码，第一次开通${off}。每个码只能用一次。`}
      </p>
      {!invite.used && invite.discountUntil?.life ? (
        <p className="membership-invite-note">
          永久会员优惠截至北京时间 {promotionEnd(invite.discountUntil.life)}。
        </p>
      ) : null}
    </section>
  );
}

// The checkout page as a QR code: black on white whatever the theme, for the phone to read.
function QrCode({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const { data } = encode(text, { ecc: 'M', border: 0 });
    let d = '';
    data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { d, size: data.length };
  }, [text]);
  return (
    <svg
      className="membership-qr"
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="付款二维码"
    >
      <rect x={-2} y={-2} width={size + 4} height={size + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function headline(s: LicenseStatus) {
  const left = s.expires ? Math.max(1, Math.ceil((s.expires - Date.now()) / DAY)) : 0;
  switch (s.state) {
    case 'paid':
      if (s.forever) return { title: '你是永久会员', detail: 'PDF 和全部 AI 功能一直可用' };
      return {
        title: '你已经是会员',
        detail: s.expires ? `到 ${when(s.expires)}，还剩 ${left} 天` : '',
      };
    case 'trial':
      return { title: '试用中', detail: s.expires ? `到 ${when(s.expires)}` : '' };
    case 'offline':
      return {
        title: '需要联网确认会员',
        detail: '超过 7 天没连上激活服务器，PDF 和 AI 暂时停用。连上网后会自动恢复。',
      };
    case 'clock':
      return {
        title: '电脑时间好像不对',
        detail: '系统时间比上次用页间时还早。把时间调准后点「重新验证」。',
      };
    case 'expired':
      if (s.moved) return movedAway(s.moved);
      return {
        title: s.codes.some((c) => !c.revoked)
          ? '会员已到期'
          : s.codes.length
            ? '激活码已作废'
            : '试用已结束',
        detail: s.expires ? `${when(s.expires)} 到期` : '',
      };
    default:
      if (s.moved) return movedAway(s.moved);
      return { title: '还没有开通会员', detail: '' };
  }
}
function movedAway(moved: NonNullable<LicenseStatus['moved']>) {
  return {
    title: '会员已转到另一台电脑',
    detail: `${when(moved.at)} 转到了另一台${computer(moved.platform)}上。在这台输入同一个激活码，可以转回来。`,
  };
}

export function MembershipDialog({
  reason,
  onClose,
  onNotify,
  embedded = false,
  onBusyChange,
}: {
  reason: string;
  onClose: () => void;
  onNotify: (message: string) => void;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const status = useLicense();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerError, setOfferError] = useState('');
  const [picked, setPicked] = useState<Plan>('year');
  const [order, setOrder] = useState<Order | null>(null);
  const [typing, setTyping] = useState(false);
  // A paying member sees the plans only after asking for them, so the window reads as "you're in".
  const [renewing, setRenewing] = useState(false);
  const [copied, setCopied] = useState('');
  // A friend's invite code being typed in, and this computer's own card opened from the footer.
  const [friendTyping, setFriendTyping] = useState(false);
  const [friendCode, setFriendCode] = useState('');
  const [inviting, setInviting] = useState(false);
  // Paid just now in this window: it says so and shows the invite, and closes on 开始使用.
  const [welcome, setWelcome] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const friendInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);
  useEffect(() => {
    if (friendTyping) friendInput.current?.focus();
  }, [friendTyping]);
  const loadOffer = () => {
    setOfferError('');
    getOffer().then(
      (next) => {
        setOffer(next);
        // A code kept from before that doesn't count: shown in the box with why.
        if (next.inviteCode?.friend?.error) setFriendCode(next.inviteCode.friend.code);
      },
      (e) => setOfferError(errorText(e)),
    );
  };
  useEffect(() => {
    loadOffer();
    // A membership the server has for this computer but this one has lost, and a purchase paid
    // after this window was last closed.
    void recoverLicense().catch(() => {});
    void checkOrder().catch(() => {});
  }, []);
  // Refresh an open membership window when an invitation discount ends. Long campaigns need
  // more than one timeout because browser timers are limited to about 24.8 days.
  useEffect(() => {
    const next = Math.min(
      ...Object.values(offer?.inviteCode?.discountUntil || {}).filter((at) => at > Date.now()),
    );
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(loadOffer, Math.min(next - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [offer]);
  // While the QR code is up, asks every two seconds whether it has been paid.
  useEffect(() => {
    if (!order || order.closed) return;
    let timer = 0;
    let stopped = false;
    const ask = async () => {
      const r = await checkOrder().catch(() => null);
      if (stopped) return;
      if (r?.closed) return setOrder((o) => o && { ...o, closed: true });
      if (!r?.paid) return void (timer = window.setTimeout(ask, 2000));
      setOrder(null);
      setRenewing(false);
      setWelcome(true);
      loadOffer();
    };
    timer = window.setTimeout(ask, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [order]);
  async function act(name: string, work: () => Promise<unknown>) {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  const activate = (move: boolean) =>
    act(move ? 'move' : 'activate', async () => {
      const r = await activateLicense(code, move);
      if (r.refusal) return setRefusal(r.refusal);
      setRefusal(null);
      setCode('');
      const s = r.status!;
      onNotify(move ? '会员已转到这台电脑' : `已激活，会员到 ${s.expires ? when(s.expires) : '—'}`);
      if (reason && s.member) onClose();
    });
  if (!status) return null;
  const head =
    welcome && status.state === 'paid'
      ? {
          title: '开通成功',
          detail: status.forever
            ? 'PDF 和全部 AI 功能已经可以用了，永久有效'
            : `PDF 和全部 AI 功能已经可以用了\n会员到 ${status.expires ? when(status.expires) : '—'}`,
        }
      : headline(status);
  const member = status.member;
  // A paying member who can't be confirmed for now (offline, or the clock turned back): shown
  // as a member waiting to be checked again, not offered a membership or a trial.
  const paused = (status.state === 'offline' || status.state === 'clock') && status.kind === 'paid';
  // No activation code entry: a lifetime member has nothing left for one to add, and a paused
  // member can't reach the server to activate one.
  const noCode = paused || (member && status.forever);
  const selected = offer?.plans.find((p) => p.plan === picked);
  const price = selected?.amount;
  const liveCodes = status.codes.some((c) => !c.revoked);
  const paid = status.state === 'paid';
  // Anyone not paying yet sees the cover beside the plans; a paying member sees their membership.
  const shop = !paid && !paused;
  const invite = offer?.inviteCode;
  const pendingDiscount =
    invite?.first && !selected?.discount && !selected?.credit && !!invite.discount[picked];
  const friend = invite?.first ? invite.friend : undefined;
  const friendOk = friend && !friend.error ? friend.code : undefined;
  const buy = (plan: Plan) =>
    act('buy', async () => {
      setPicked(plan);
      setOrder(await createOrder(plan, friendOk));
    });
  const applyFriend = (code: string) => act('invite', async () => setOffer(await setInvite(code)));
  return (
    <div
      className={embedded ? 'membership-embedded' : 'modal-backdrop'}
      onMouseDown={(e) => {
        if (!embedded && e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className={`dialog membership-dialog${shop ? ' is-shop' : ''}`}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="membership-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy) void activate(false);
        }}
        onKeyDown={(e) => {
          if (!embedded && e.key === 'Escape' && !busy) onClose();
        }}
      >
        {shop ? (
          <aside className="membership-cover">
            <span className="membership-cover-mark">
              <Crown size={13} />
              FOLIO MEMBERSHIP
            </span>
            <h2 id="membership-title">页间会员</h2>
            <p>
              {reason ? (
                `「${reason}」是会员功能，开通后就能用。`
              ) : (
                <>
                  PDF、全部 AI 功能和十套界面主题，
                  <br />
                  一次解锁。
                </>
              )}
            </p>
            <table className="membership-compare">
              <thead>
                <tr>
                  <th />
                  <th>免费</th>
                  <th>会员</th>
                </tr>
              </thead>
              <tbody>
                {compare.map(([what, free], i) => (
                  <tr
                    key={what}
                    className={
                      free ? '' : i && compare[i - 1][1] ? 'is-pro is-pro-start' : 'is-pro'
                    }
                  >
                    <td>{what}</td>
                    <td>{free ? <Check size={14} role="img" aria-label="有" /> : '—'}</td>
                    <td>
                      <Check size={15} role="img" aria-label="有" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        ) : null}
        <div className="membership-main">
          <div className="dialog-heading">
            {shop ? (
              <span className="membership-step">{order ? '扫码付款' : '选择会员时长'}</span>
            ) : (
              <h2 id="membership-title">
                <Crown size={18} />
                页间会员
              </h2>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="关闭"
              onClick={onClose}
              hidden={embedded}
            >
              <X size={18} />
            </button>
          </div>
          {status.state !== 'none' || status.codes.length || status.moved || status.error ? (
            <div
              className={`membership-status${paid ? ' is-paid' : member ? ' is-member' : ''}${paid && welcome ? ' is-welcome' : ''}`}
            >
              <div className="membership-status-head">
                {paid ? (
                  <span className="membership-badge">
                    <Crown size={18} />
                  </span>
                ) : null}
                <div>
                  <strong>{head.title}</strong>
                  {head.detail ? <span>{head.detail}</span> : null}
                </div>
              </div>
              {status.codes.length ? (
                <span className="membership-codes">
                  {status.codes.map((c) => (
                    <span key={c.code}>
                      激活码 {c.code} · {plan(c.plan)}
                      {c.revoked ? (
                        '（已作废）'
                      ) : (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="复制激活码"
                          title="复制激活码"
                          onClick={() =>
                            void navigator.clipboard.writeText(c.code).then(() => setCopied(c.code))
                          }
                        >
                          {copied === c.code ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      )}
                    </span>
                  ))}
                </span>
              ) : null}
              {liveCodes ? (
                <span className="membership-hint">
                  在另一台电脑上输入这个激活码，会员就转过去，这台随即停用。
                </span>
              ) : null}
              {status.error && !member ? (
                <span className="membership-error">{status.error}</span>
              ) : null}
              {status.state === 'offline' || status.state === 'clock' ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act('renew', async () => {
                      await renewLicense();
                      // The prices failed to load while offline too.
                      loadOffer();
                    })
                  }
                >
                  {busy === 'renew' ? '验证中…' : '重新验证'}
                </button>
              ) : null}
            </div>
          ) : null}
          {status.forever || welcome || paused ? null : offerError || (offer && !offer.ready) ? (
            <p className="membership-offline">
              {offerError ? '连不上激活服务器，暂时不能购买。' : '暂时不能在线购买，请稍后再试。'}
              <button type="button" className="link-button" onClick={loadOffer}>
                重试
              </button>
            </p>
          ) : !offer ? null : paid && !renewing && !order ? (
            <button
              type="button"
              className="secondary-button membership-renew"
              onClick={() => setRenewing(true)}
            >
              续费或升级为永久会员
              <ChevronDown size={15} />
            </button>
          ) : order ? (
            <div className={`membership-pay${order.closed ? ' is-closed' : ''}`}>
              <div className="membership-qr-frame">
                <QrCode text={order.payUrl} />
                {order.closed ? (
                  <button
                    type="button"
                    className="membership-qr-expired"
                    disabled={!!busy}
                    onClick={() => void buy(order.plan)}
                  >
                    <RotateCw size={18} />
                    {busy === 'buy' ? '正在生成…' : '二维码已过期，点这里重新生成'}
                  </button>
                ) : null}
              </div>
              <div className="membership-pay-text">
                <span className="membership-pay-plan">{membership(order.plan)}</span>
                <strong>
                  <Price fen={order.amount} />
                </strong>
                <span>打开微信或支付宝，扫一扫付款</span>
                {order.closed ? null : <span className="membership-waiting">付完自动开通</span>}
                <div className="membership-pay-actions">
                  <button type="button" className="link-button" onClick={() => setOrder(null)}>
                    换个套餐
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void invoke('external', { url: order.payUrl }).catch(() => {})}
                  >
                    在浏览器里打开
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {paid ? (
                <p className="membership-section">
                  续费的天数接在后面；升级永久时，剩下的天数折成钱抵扣
                </p>
              ) : null}
              <div className="membership-plans" role="radiogroup" aria-label="会员时长">
                {offer.plans.map((p) => {
                  const off = invite?.first ? invite.discount[p.plan] : undefined;
                  // Preview the invitation price on the card only. Checkout always uses the
                  // server's actual amount, and a validated code must not be deducted twice.
                  const preview =
                    off && !p.discount && !p.credit ? Math.min(off, p.amount - 100) : 0;
                  const shown = preview
                    ? { ...p, amount: p.amount - preview, discount: preview }
                    : p;
                  return (
                    <button
                      key={p.plan}
                      type="button"
                      role="radio"
                      aria-checked={picked === p.plan}
                      className={`membership-plan${picked === p.plan ? ' is-picked' : ''}`}
                      onClick={() => setPicked(p.plan)}
                    >
                      <span className="membership-plan-radio" aria-hidden="true" />
                      <span className="membership-plan-main">
                        <span className="membership-plan-name">
                          {p.credit ? '升级永久' : plan(p.plan)}
                          {p.later ? (
                            <em>早鸟价</em>
                          ) : off && invite?.discountUntil?.[p.plan] ? (
                            <em>限时邀请优惠</em>
                          ) : p.plan === 'year' ? (
                            <em className="is-pick">推荐</em>
                          ) : null}
                        </span>
                        <span className={`membership-plan-note${p.credit ? ' is-credit' : ''}`}>
                          {planNote(shown)}
                        </span>
                      </span>
                      <span className="membership-plan-price">
                        <strong>
                          {struck(shown) ? <s>{yuan(struck(shown))}</s> : null}
                          <Price fen={shown.amount} />
                        </strong>
                        {off ? (
                          <span className="membership-plan-invite">
                            {p.discount
                              ? `邀请码已减 ${yuan(p.discount)}`
                              : `填写好友邀请码后，原价立减 ${yuan(preview)}`}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {invite?.first ? (
                <div className="membership-friend">
                  {friendOk ? (
                    <span className="membership-friend-ok">
                      <Check size={14} />
                      已使用好友的邀请码 {friendOk}
                      <button
                        type="button"
                        className="link-button"
                        disabled={!!busy}
                        onClick={() => {
                          setFriendCode('');
                          setFriendTyping(true);
                          void applyFriend('');
                        }}
                      >
                        更换
                      </button>
                    </span>
                  ) : friendTyping || friend?.error ? (
                    <>
                      <div className="membership-friend-input">
                        <input
                          ref={friendInput}
                          aria-label="好友的邀请码"
                          placeholder="好友的邀请码"
                          value={friendCode}
                          spellCheck={false}
                          autoComplete="off"
                          maxLength={12}
                          onChange={(e) => setFriendCode(e.target.value)}
                          onPaste={(e) => {
                            // A friend's whole invite pasted in: just the code from it.
                            const found = e.clipboardData
                              .getData('text')
                              .match(/邀请码[\s：:]*([0-9a-z]{6})(?![0-9a-z])/i);
                            if (!found) return;
                            e.preventDefault();
                            setFriendCode(found[1].toUpperCase());
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            if (friendCode.trim() && !busy) void applyFriend(friendCode);
                          }}
                        />
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!friendCode.trim() || !!busy}
                          onClick={() => void applyFriend(friendCode)}
                        >
                          {busy === 'invite' ? '检查中…' : '使用'}
                        </button>
                      </div>
                      {friend?.error ? (
                        <span className="membership-error">{friend.error}</span>
                      ) : null}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="link-button membership-friend-ask"
                      onClick={() => setFriendTyping(true)}
                    >
                      <Ticket size={14} />
                      有好友的邀请码？点这里填写
                    </button>
                  )}
                </div>
              ) : null}
              <button
                type="button"
                className="membership-buy"
                disabled={!!busy || !price}
                onClick={() => void buy(picked)}
              >
                {busy === 'buy'
                  ? '正在下单…'
                  : `${paid ? (picked === 'life' ? '升级永久' : '续费') : pendingDiscount ? '原价开通' : '立即开通'}${price ? ` · ${yuan(price)}` : ''}`}
              </button>
              <p className="membership-fineprint">
                {invite?.first && invite.discountUntil?.life ? (
                  <>
                    永久会员好友优惠截至北京时间 {promotionEnd(invite.discountUntil.life)}。
                    <br />
                  </>
                ) : null}
                微信 / 支付宝扫码付款，付完自动开通 · 一份会员同时在一台电脑上用
                <br />
                注：AI 功能需在 AI 设置里填自己的服务商 API Key。
              </p>
            </>
          )}
          {invite && (paid || inviting) ? <InviteCard invite={invite} /> : null}
          {paid && welcome ? (
            <button type="button" className="membership-buy" onClick={onClose}>
              开始使用
            </button>
          ) : null}
          {refusal ? (
            <div className="membership-move" role="alert">
              <span>
                这个激活码正在另一台{computer(refusal.platform)}上使用。转到这台电脑后，那台
                {computer(refusal.platform)}上的会员会马上停用。
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={!!busy}
                onClick={() => void activate(true)}
              >
                {busy === 'move' ? '转移中…' : '转到这台电脑'}
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          {typing && !noCode ? (
            <div className="membership-activate">
              <input
                ref={input}
                aria-label="激活码"
                placeholder="输入激活码，如 ABCD-EFGH-JKMN-PQRS"
                value={code}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setCode(e.target.value);
                  setRefusal(null);
                }}
              />
              <button className="primary-button" disabled={!code.trim() || !!busy}>
                {busy === 'activate' ? '激活中…' : '激活'}
              </button>
            </div>
          ) : null}
          <div className="membership-footer">
            {typing || welcome || noCode ? null : (
              <button type="button" className="link-button" onClick={() => setTyping(true)}>
                有激活码？
              </button>
            )}
            {invite && !paid && !inviting ? (
              <button type="button" className="link-button" onClick={() => setInviting(true)}>
                邀请好友
              </button>
            ) : null}
            {!member && !paused && !status.trialUsed ? (
              <button
                type="button"
                className="link-button membership-trial"
                disabled={!!busy}
                onClick={() =>
                  void act('trial', async () => {
                    const s = await startTrial();
                    onNotify(`试用已开始，到 ${s.expires ? when(s.expires) : '—'}`);
                    if (reason && s.member) onClose();
                  })
                }
              >
                {busy === 'trial' ? '开通中…' : '先免费试用 3 天'}
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}

// Where a PDF would be, for someone without a membership.
export function MemberLock() {
  const status = useLicense();
  return (
    <div className="reading-column-empty member-lock">
      <Lock size={28} />
      <strong>PDF 阅读和批注是会员功能</strong>
      <span>
        {status?.state === 'offline'
          ? '会员需要联网确认，连上网后就能继续读。'
          : status?.moved && !status.member
            ? '会员已转到另一台电脑。在这台输入同一个激活码，可以转回来。'
            : '开通会员，或免费试用 3 天，就能打开 PDF。HTML 阅读和批注一直免费。'}
      </span>
      <button type="button" className="primary-button" onClick={() => askMembership('PDF 阅读')}>
        开通会员
      </button>
    </div>
  );
}
