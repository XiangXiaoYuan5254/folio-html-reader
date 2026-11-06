import { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { invoke, isDesktop } from '../api';
import { errorText } from '../ai/client';

const COMMUNITY_PAGE = 'https://helloxxy.com/works/folio/community/';
const ISSUES = 'https://github.com/XiangXiaoYuan5254/folio-html-reader/issues';

const open = (url: string) => void invoke('external', { url }).catch(() => {});

// 设置 › 用户交流群: the WeChat group's QR code. WeChat's codes expire after a week, so it's read
// from the website each time the page opens (electron/community.cjs), never shipped in the app.
export function CommunitySettings() {
  const [image, setImage] = useState('');
  const [loading, setLoading] = useState(isDesktop);
  const [error, setError] = useState('');
  async function load(force = false) {
    setLoading(true);
    setError('');
    try {
      setImage(await invoke<string>('community-qr', { force }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (isDesktop) void load();
  }, []);
  return (
    <div className="settings-community">
      <div className="community-code">
        {image ? (
          <img src={image} alt="页间用户交流群的微信二维码" />
        ) : (
          <div className="community-code-empty" role="status">
            {loading ? (
              <>
                <LoaderCircle size={18} className="spin" />
                <span>正在读取二维码…</span>
              </>
            ) : (
              <>
                <span>{error || '二维码在官网上'}</span>
                {isDesktop ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void load(true)}
                  >
                    <RefreshCw size={13} />
                    重试
                  </button>
                ) : null}
                <button
                  type="button"
                  className="settings-link"
                  onClick={() => open(COMMUNITY_PAGE)}
                >
                  在浏览器里打开
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="community-text">
        <h4>微信扫一扫，加入交流群</h4>
        <p>
          聊聊阅读和 AI 的用法、反馈问题，
          <br />
          也欢迎分享你的笔记和插件。
        </p>
        <button type="button" className="settings-link" onClick={() => open(ISSUES)}>
          在 GitHub 上反馈问题
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}
