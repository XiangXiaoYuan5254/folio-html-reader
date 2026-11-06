/// <reference path="../../types/folio.d.ts" />
// Hacker News 摘要的脚本：给 AI 加一个 hn_top_stories 工具。
//
// 为什么用脚本而不是让 AI 直接 fetch_url：Hacker News 的接口要先取一串 id，再一条条取详情，
// 二十多次请求让 AI 自己做又慢又费额度。脚本把这件事做完，只把整理好的结果交给 AI。
// 脚本自己不能联网，folio.fetch 由页间转交，只能访问 permissions.network 里的网站。

const API = 'https://hacker-news.firebaseio.com/v0';
const number = (value, fallback, max) => {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

async function json(url) {
  const res = await folio.fetch(url, { accept: 'application/json' });
  if (!res.ok) throw Error(`${url} 返回了 ${res.status}`);
  return JSON.parse(res.text);
}

folio.registerTool(
  {
    name: 'hn_top_stories',
    description:
      '读取 Hacker News 首页当前的热门帖子，返回标题、原文链接、讨论页链接、分数、评论数和发布时间。已经按插件设置筛掉了分数太低的。',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: '看首页前几条，不填用插件设置',
        },
      },
    },
  },
  async ({ count }) => {
    const take = number(count ?? folio.settings.count, 20, 30);
    const minPoints = number(folio.settings.min_points, 100, 10000);
    const ids = (await json(`${API}/topstories.json`)).slice(0, take);
    folio.log(`取首页前 ${ids.length} 条，至少 ${minPoints} 分`);
    const items = await Promise.all(
      ids.map((id) =>
        json(`${API}/item/${id}.json`).catch((e) => {
          folio.log(`第 ${id} 条没读到：`, e);
          return null;
        }),
      ),
    );
    const stories = items
      .filter((x) => x && x.type === 'story' && !x.dead && !x.deleted)
      .filter((x) => (x.score || 0) >= minPoints)
      .map((x) => ({
        title: x.title,
        url: x.url || `https://news.ycombinator.com/item?id=${x.id}`,
        discussion: `https://news.ycombinator.com/item?id=${x.id}`,
        points: x.score,
        comments: x.descendants || 0,
        by: x.by,
        posted: new Date(x.time * 1000).toISOString().slice(0, 16).replace('T', ' '),
      }));
    folio.log(`筛完剩 ${stories.length} 条`);
    return { count: stories.length, stories };
  },
);
