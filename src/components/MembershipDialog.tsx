import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Crown,
  FileText,
  Gift,
  Lock,
  Palette,
  RotateCw,
  Sparkles,
  Ticket,
  X,
} from 'lucide-react';
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
const date = (ms: number) =>
  new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
// The price struck through beside it: before the credit or the friend's invite, or the regular
// price the early-bird one stands in for until its date (said in the note, so it isn't a made-up
// "original" price).
const struck = (p: Offer['plans'][number]) =>
  p.credit || p.discount
    ? p.amount + (p.credit || 0) + (p.discount || 0)
    : p.later && p.until
      ? p.later
      : 0;
// A year always says what it comes to a month, with a friend's code too (the struck-through price
// shows what the code took off).
function planNote(p: Offer['plans'][number]) {
  if (p.credit) return `剩余天数抵扣 −${yuan(p.credit)}`;
  if (p.plan === 'year') return `合 ${yuan(Math.round(p.amount / 12))} / 月`;
  if (p.discount) return `邀请码立减 ${yuan(p.discount)}`;
  if (p.later && p.until) return `早鸟价至 ${date(p.until - 1)}`;
  if (p.plan === 'life') return '一次买断';
  return '随用随买';
}

const downloadPage = 'https://helloxxy.com/works/folio/';
// What a friend's code takes off, as 年度会员减 ¥10、永久会员减 ¥20.
const offText = (discount: InviteCode['discount']) =>
  (['month', 'year', 'life'] as const)
    .filter((p) => discount[p])
    .map((p) => `${{ month: '月度', year: '年度', life: '永久' }[p]}会员减 ${yuan(discount[p]!)}`)
    .join('、');
// This computer's invite code: it takes something off one friend's first purchase.
function InviteCard({ invite }: { invite: InviteCode }) {
  const [copied, setCopied] = useState(false);
  const off = offText(invite.discount);
  const share = `我在用「页间」读文档，送你我的邀请码 ${invite.code}：第一次开通${off}，这个码只能用一次。下载：${downloadPage}`;
  return (
    <section className="membership-invite" aria-labelledby="membership-invite-title">
      <div className="membership-invite-head">
        <Gift size={16} />
        <strong id="membership-invite-title">邀请好友</strong>
        {invite.used ? null : (
          <>
            <code className="membership-invite-code">{invite.code}</code>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void navigator.clipboard.writeText(share).then(() => setCopied(true))}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制邀请'}
            </button>
          </>
        )}
      </div>
      <p className="membership-invite-note">
        {invite.used
          ? `你的邀请码 ${invite.code} 已经被好友用过了，每个码只能用一次。`
          : `好友填这个码，第一次开通${off}。每个码只能用一次。`}
      </p>
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
      return {
        title: s.codes.some((c) => !c.revoked)
          ? '会员已到期'
          : s.codes.length
            ? '激活码已作废'
            : '试用已结束',
        detail: s.expires ? `${when(s.expires)} 到期` : '',
      };
    default:
      return { title: '还没有开通会员', detail: '' };
  }
}

export function MembershipDialog({
  reason,
  onClose,
  onNotify,
}: {
  reason: string;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const status = useLicense();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
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
      loadOffer();
      const s = r.status;
      onNotify(
        s.forever ? '已开通永久会员' : `已开通，会员到 ${s.expires ? when(s.expires) : '—'}`,
      );
      if (reason) onClose();
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
  const head = headline(status);
  const member = status.member;
  const price = offer?.plans.find((p) => p.plan === picked)?.amount;
  const liveCodes = status.codes.some((c) => !c.revoked);
  const paid = status.state === 'paid';
  const invite = offer?.inviteCode;
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
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="dialog membership-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="membership-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy) void activate(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
        }}
      >
        <div className="dialog-heading">
          <h2 id="membership-title">
            <Crown size={18} />
            {member ? '页间会员' : '开通页间会员'}
          </h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {member ? null : (
          <p className="membership-lead">
            {reason
              ? `「${reason}」是会员功能，开通后就能用。`
              : '解锁 PDF、全部 AI 功能和界面主题。'}
          </p>
        )}
        {status.state !== 'none' || status.codes.length || status.error ? (
          <div className={`membership-status${paid ? ' is-paid' : member ? ' is-member' : ''}`}>
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
                换电脑时在新电脑上输入激活码，会员就转过去，7 天内能转一次。
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
                onClick={() => void act('renew', renewLicense)}
              >
                {busy === 'renew' ? '验证中…' : '重新验证'}
              </button>
            ) : null}
          </div>
        ) : null}
        {member ? null : (
          <ul className="membership-perks">
            <li>
              <FileText size={16} />
              <span>
                <strong>PDF 阅读与批注</strong>和 HTML 一样高亮、写笔记、手绘
              </span>
            </li>
            <li>
              <Sparkles size={16} />
              <span>
                <strong>全部 AI 功能</strong>
                AI 助手、划词翻译、白板讲解、精读笔记、找论文
              </span>
            </li>
            <li>
              <Palette size={16} />
              <span>
                <strong>十套界面主题</strong>
                宣纸、夜读、墨金、终端……
              </span>
            </li>
          </ul>
        )}
        {status.forever ? null : offerError || (offer && !offer.ready) ? (
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
              <strong>{yuan(order.amount)}</strong>
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
              {offer.plans.map((p) => (
                <button
                  key={p.plan}
                  type="button"
                  role="radio"
                  aria-checked={picked === p.plan}
                  className={`membership-plan${picked === p.plan ? ' is-picked' : ''}`}
                  onClick={() => setPicked(p.plan)}
                >
                  <span className="membership-plan-name">
                    {p.credit ? '升级永久' : plan(p.plan)}
                    {p.later ? <em>早鸟价</em> : p.plan === 'year' ? <em>推荐</em> : null}
                  </span>
                  <strong>
                    {yuan(p.amount)}
                    {struck(p) ? <s>{yuan(struck(p))}</s> : null}
                  </strong>
                  <span
                    className={`membership-plan-note${p.credit || p.discount ? ' is-credit' : ''}`}
                  >
                    {planNote(p)}
                  </span>
                </button>
              ))}
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
                    有好友的邀请码？{offText(invite.discount)}
                  </button>
                )}
              </div>
            ) : null}
            <button
              type="button"
              className="primary-button membership-buy"
              disabled={!!busy || !price}
              onClick={() => void buy(picked)}
            >
              {busy === 'buy' ? '正在下单…' : `微信 / 支付宝付款 ${price ? yuan(price) : ''}`}
            </button>
            <p className="membership-fineprint">
              扫码付款，付完自动开通 · 一份会员同时在一台电脑上用
            </p>
          </>
        )}
        {invite && (paid || inviting) ? (
          <InviteCard invite={invite} />
        ) : null}
        {refusal ? (
          <div className="membership-move" role="alert">
            {refusal.canMoveAt ? (
              <span>
                这个激活码正在另一台{computer(refusal.platform)}上使用，7 天内转移过，
                {when(refusal.canMoveAt)} 之后才能转到这台电脑。
              </span>
            ) : (
              <>
                <span>
                  这个激活码正在另一台{computer(refusal.platform)}上使用。转到这台电脑后，那台
                  {computer(refusal.platform)}上的会员会停用，之后 7 天内不能再转。
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() => void activate(true)}
                >
                  {busy === 'move' ? '转移中…' : '转到这台电脑'}
                </button>
              </>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        {typing ? (
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
          {typing ? null : (
            <button type="button" className="link-button" onClick={() => setTyping(true)}>
              有激活码？
            </button>
          )}
          {invite && !paid && !inviting ? (
            <button type="button" className="link-button" onClick={() => setInviting(true)}>
              邀请好友
            </button>
          ) : null}
          {!member && !status.trialUsed ? (
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
          : '开通会员，或免费试用 3 天，就能打开 PDF。HTML 阅读和批注一直免费。'}
      </span>
      <button type="button" className="primary-button" onClick={() => askMembership('PDF 阅读')}>
        开通会员
      </button>
    </div>
  );
}
