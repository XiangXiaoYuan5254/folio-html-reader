const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommunity } = require('../electron/community.cjs');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const image = (type = 'image/jpeg', body = jpeg) =>
  new Response(body, { headers: { 'content-type': type } });

test('the QR code is read from the website and kept for a while', async () => {
  const calls = [];
  const community = createCommunity({
    url: 'https://example.com/qr.jpg',
    fetch: async (url) => {
      calls.push(url);
      return image();
    },
  });
  const data = await community.qr();
  assert.equal(data, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.match(calls[0], /^https:\/\/example\.com\/qr\.jpg\?t=\d+$/);
  await community.qr();
  assert.equal(calls.length, 1, 'switching pages does not fetch it again');
  await community.qr({ force: true });
  assert.equal(calls.length, 2);
});

test('a missing or wrong picture is an error the page can show', async () => {
  const cases = [
    [async () => new Response('', { status: 404 }), /404/],
    [async () => image('text/html', Buffer.from('<html>')), /不是图片/],
    [async () => image('image/jpeg', Buffer.alloc(0)), /不对/],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      /连不上/,
    ],
  ];
  for (const [fetch, message] of cases)
    await assert.rejects(createCommunity({ fetch }).qr(), message);
});
